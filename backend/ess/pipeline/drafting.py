"""Quotation drafts: template choice, reference number, AI-drafted items (never prices), PDF render, send gate."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException
from sqlmodel import Session, select

from ..config import get_settings
from ..models import (
    Approval,
    Contact,
    Customer,
    Email,
    Enquiry,
    Project,
    Quotation,
    Signatory,
    TeamMember,
    Workspace,
    utcnow,
)
from ..workspace import default_signatory, log_activity
from .analysis import knowledge_context
from .connect import engine_for, mail_source_for
from .importer import strip_prices
from .state import refresh_project_state


def signatory_dict(sig: Optional[Signatory], ws: Workspace) -> dict:
    if sig is None:
        return {"initials": "XX", "full_name": "", "title": "", "company": ws.company_name or ws.name,
                "city": "", "email": ws.primary_email, "phone": None}
    return {"initials": sig.initials, "full_name": sig.full_name, "title": sig.title,
            "company": sig.company or ws.company_name, "city": sig.city, "email": sig.email or ws.primary_email,
            "phone": sig.phone}


def project_dict(project: Project, customer: Optional[Customer]) -> dict:
    return {
        "name": project.name, "service_family": project.service_family, "work_type": project.work_type,
        "request_kind": project.request_kind, "tender_no": project.tender_no, "location": project.location,
        "owner_client": project.owner_client, "consultant": project.consultant, "summary": project.summary,
        "scope_items": project.scope_items, "requirements": project.requirements,
        "unresolved_questions": project.unresolved_questions, "customer": customer.name if customer else None,
        "due_date": project.due_date.isoformat() if project.due_date else None,
    }


def enquiry_dict(session: Session, enquiry: Optional[Enquiry]) -> dict:
    if enquiry is None:
        return {}
    customer = session.get(Customer, enquiry.customer_id) if enquiry.customer_id else None
    contact = dict(enquiry.contact or {})
    if not contact.get("email") and customer:
        c = session.exec(select(Contact).where(Contact.customer_id == customer.id)).first()
        if c:
            contact = {"name": c.name, "email": c.email, "title": c.title}
    return {"ref": enquiry.ref, "company": customer.name if customer else "", "contact": contact,
            "due_date": enquiry.due_date.isoformat() if enquiry.due_date else None}


def enquiry_sources(session: Session, project: Project, enquiry: Optional[Enquiry] = None) -> dict[str, str]:
    """Customer text a quotation answers: that contractor's mails, else every mail of the project."""
    emails = session.exec(select(Email).where(Email.project_id == project.id)).all()
    if enquiry is not None and (enquiry.email_ids or enquiry.thread_ids):
        ids, threads = set(enquiry.email_ids or []), set(enquiry.thread_ids or [])
        emails = [e for e in emails if e.id in ids or e.thread_id in threads]
    return {e.id: f"{e.subject}\n{e.body_text or e.snippet}" for e in emails if e.direction != "outbound"}


def _existing_refs(session: Session, ws: Workspace) -> list[str]:
    return [q.reference for q in session.exec(select(Quotation).where(Quotation.workspace_id == ws.id)).all() if q.reference]


def create_quotation(session: Session, ws: Workspace, project: Project, *, enquiry: Optional[Enquiry] = None,
                     template_key: Optional[str] = None, language: Optional[str] = None,
                     signatory: Optional[Signatory] = None, actor: str = "system") -> Quotation:
    from ..quotation.numbering import next_reference
    from ..quotation.templates import choose_template, default_quotation

    from ..learning import memory_context, resolve_template

    reason = "chosen by user"
    paper_id = None
    if not template_key:
        if enquiry is None:
            enquiry = session.exec(select(Enquiry).where(Enquiry.project_id == project.id,
                                                         Enquiry.quotation_id == None)  # noqa: E711
                                   .order_by(Enquiry.received_at)).first()
        rule = resolve_template(session, ws, project, (enquiry.customer_id if enquiry else None) or project.customer_id)
        if rule:
            template_key, reason, paper_id = rule["template_key"], rule["reason"], rule.get("paper_id")
            language = language or rule.get("language")
            if signatory is None and rule.get("signatory_id"):
                signatory = session.get(Signatory, rule["signatory_id"])
    language = language or (ws.settings or {}).get("quotations", {}).get("default_language") or "en"
    if not template_key:
        template_key, reason = choose_template(project.service_family, project.work_type, project.request_kind, language)
    signatory = signatory or default_signatory(session, ws)
    sig = signatory_dict(signatory, ws)
    if enquiry is None:
        enquiry = session.exec(select(Enquiry).where(Enquiry.project_id == project.id, Enquiry.quotation_id == None)  # noqa: E711
                               .order_by(Enquiry.received_at)).first()
    customer = session.get(Customer, enquiry.customer_id if enquiry else project.customer_id) if (enquiry and enquiry.customer_id) or project.customer_id else None
    pdict = project_dict(project, customer)
    edict = enquiry_dict(session, enquiry)
    data = default_quotation(template_key, language, pdict, edict, sig, currency=ws.currency or None)
    data["reference"] = next_reference(sig["initials"], datetime.now(timezone.utc).year, _existing_refs(session, ws))
    data["paper_id"] = paper_id or (ws.settings or {}).get("quotations", {}).get("default_paper_id")
    data["status"] = "draft"

    created_by = "rules"
    choice = engine_for(session, ws, "draft_quotation")
    if choice is not None:
        from ..ai import tasks

        know = {**knowledge_context(session, ws),
                "lessons": memory_context(session, ws, task="draft_quotation", service_family=project.service_family,
                                          customer_id=customer.id if customer else None)}
        draft = tasks.draft_quotation(choice.engine, pdict, template_key, know)
        for key in ("subject", "intro"):
            if draft.get(key):
                data[key] = draft[key]
        if draft.get("items"):
            data["items"] = [{"no": i + 1, "description": it.get("description", ""), "spec": it.get("spec", ""),
                              "qty": it.get("qty"), "unit": it.get("unit") or "", "unit_price": None, "total": None}
                             for i, it in enumerate(draft["items"])]
        if draft.get("exclusions"):
            data["exclusions"] = draft["exclusions"]
        if draft.get("clarifications"):
            data["clarifications"] = draft["clarifications"]
        created_by = "ai"
    elif not data.get("items") and project.scope_items:
        data["items"] = [{"no": i + 1, "description": it.get("description", ""), "spec": it.get("spec", ""),
                          "qty": it.get("qty"), "unit": it.get("unit") or "", "unit_price": None, "total": None}
                         for i, it in enumerate(project.scope_items)]
    from .terms import apply_requested_terms

    apply_requested_terms(data, enquiry_sources(session, project, enquiry))  # e.g. "validity of the offer: 120 days"
    data = strip_prices(data)  # hard rule: drafts never carry prices

    q = Quotation(workspace_id=ws.id, project_id=project.id, enquiry_id=enquiry.id if enquiry else None,
                  customer_id=customer.id if customer else None, reference=data["reference"],
                  template_key=template_key, template_reason=reason, language=language,
                  signatory_id=signatory.id if signatory else None, status="draft", data=data, created_by=created_by)
    session.add(q)
    session.flush()
    if enquiry is not None and enquiry.quotation_id is None:
        enquiry.quotation_id = q.id
        session.add(enquiry)
    log_activity(session, ws.id, "quotation_drafted", f"Quotation {q.reference} drafted",
                 detail=f"{template_key} ({reason})", project_id=project.id, quotation_id=q.id, actor=actor)
    refresh_project_state(session, project)
    return q


def pdf_path_for(q: Quotation) -> Path:
    d = get_settings().quotations_dir / q.id
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{q.reference.replace('/', '-') or q.id}-v{q.version}.pdf"


async def render_pdf(q_id: str) -> str:
    from ..db import session_scope
    from ..quotation.assets import LetterheadAssets
    from ..quotation.render import render_quotation_pdf

    with session_scope() as s:
        q = s.get(Quotation, q_id)
        ws = s.get(Workspace, q.workspace_id)
        sig = s.get(Signatory, q.signatory_id) if q.signatory_id else default_signatory(s, ws)
        sigd = signatory_dict(sig, ws)
        data = {**q.data, "status": q.status, "reference": q.reference, "language": q.language,
                "template_key": q.template_key}
        wsd = {"company_name": ws.company_name or ws.name, "name": ws.name}
        sign_drafts = bool((ws.settings or {}).get("quotations", {}).get("sign_drafts", False))
        out = pdf_path_for(q)
    import inspect

    kwargs = {}
    if data.get("paper_id") and "paper_id" in inspect.signature(LetterheadAssets.load).parameters:
        kwargs["paper_id"] = data["paper_id"]
    final = data.get("status") in ("approved", "sent")
    initials = sigd["initials"]
    if not final and not sign_drafts:
        # A draft never carries the real signature or stamp: a forwarded draft cannot pass as an offer.
        initials = None
        data["stamp"] = {**(data.get("stamp") or {}), "show": False}
    assets = LetterheadAssets.load(get_settings().private_dir, wsd["company_name"], initials, **kwargs)
    await render_quotation_pdf(data, wsd, sigd, assets, out)
    with session_scope() as s:
        q = s.get(Quotation, q_id)
        q.pdf_path = str(out.relative_to(get_settings().data_dir))
        q.pdf_rendered_at = utcnow()
        status = getattr(assets, "status", {})
        q.assets_status = status if isinstance(status, dict) else {"status": str(status)}
        s.add(q)
    return str(out)


def missing_prices(q: Quotation) -> list[int]:
    return [i.get("no") or n + 1 for n, i in enumerate(q.data.get("items") or [])
            if i.get("unit_price") in (None, "") and not i.get("included")]


def approve_quotation(session: Session, ws: Workspace, q: Quotation, user: TeamMember, note: str = "") -> Quotation:
    from ..models import Review

    review = session.exec(select(Review).where(Review.project_id == q.project_id)
                          .order_by(Review.created_at.desc())).first()
    if (ws.settings or {}).get("quotations", {}).get("require_engineer_review", True):
        if review is None or review.decision != "approved":
            raise HTTPException(409, {"code": "review_required",
                                      "message": "The engineer review must approve the technical scope first."})
    if (q.impact_review or {}).get("required"):
        raise HTTPException(409, {"code": "impact_review",
                                  "message": "A new technical revision arrived: the engineer must review it first ("
                                             + str(q.impact_review.get("reason")) + ")."})
    gaps = missing_prices(q)
    if gaps:
        raise HTTPException(409, {"code": "prices_missing",
                                  "message": f"Enter prices for item(s) {', '.join(map(str, gaps))} before approval."})
    q.status = "approved"
    q.approved_by = user.name
    q.approved_at = utcnow()
    q.updated_at = utcnow()
    session.add(q)
    session.add(Approval(workspace_id=ws.id, action="approve_quotation", target_type="quotation", target_id=q.id,
                         decided_by=user.name, decision="approved", revision=f"{q.reference} v{q.version}", note=note))
    log_activity(session, ws.id, "quotation_approved", f"Quotation {q.reference} approved", actor=user.name,
                 project_id=q.project_id, quotation_id=q.id, severity="success")
    project = session.get(Project, q.project_id)
    refresh_project_state(session, project)
    return q


def send_quotation(session: Session, ws: Workspace, q: Quotation, user: TeamMember, *, to: list[str],
                   subject: str, body: str, send_now: bool) -> dict:
    """The human gate: only an approved quotation leaves, and only on an explicit request."""
    if q.status != "approved":
        raise HTTPException(409, {"code": "not_approved", "message": "Only approved quotations can be sent."})
    if not q.pdf_path:
        raise HTTPException(409, {"code": "no_pdf", "message": "Render the PDF first."})
    if not to:
        raise HTTPException(400, {"code": "no_recipient", "message": "Add at least one recipient."})
    pdf = (get_settings().data_dir / q.pdf_path).read_bytes()
    source = mail_source_for(session, ws)
    enquiry = session.get(Enquiry, q.enquiry_id) if q.enquiry_id else None
    in_reply_to = (enquiry.email_ids or [None])[-1] if enquiry else None
    thread_id = (enquiry.thread_ids or [None])[-1] if enquiry else None
    draft_id = source.create_draft(to, subject, body, attachments=[(Path(q.pdf_path).name, pdf, "application/pdf")],
                                   in_reply_to=in_reply_to, thread_id=thread_id)
    q.mail_draft_id = draft_id
    result = {"draft_id": draft_id, "sent": False}
    if send_now:
        source.send_draft(draft_id)
        q.status = "sent"
        q.sent_at = utcnow()
        q.sent_via = "mail"
        result["sent"] = True
        if enquiry:
            enquiry.status = "quoted"
            enquiry.our_response = {"status": "quoted", "date": utcnow().isoformat(), "detail": q.reference}
            enquiry.customer_response = "awaiting"  # sent ≠ accepted
            session.add(enquiry)
    session.add(q)
    import hashlib as _hashlib

    session.add(Approval(workspace_id=ws.id, action="send_quotation", target_type="quotation", target_id=q.id,
                         decided_by=user.name, decision="approved",
                         revision=f"{q.reference} v{q.version} pdf:{_hashlib.sha256(pdf).hexdigest()[:16]}",
                         note=f"to={', '.join(to)}; send_now={send_now}; draft={draft_id}"))
    log_activity(session, ws.id, "quotation_sent" if send_now else "quotation_draft_saved",
                 f"Quotation {q.reference} {'sent' if send_now else 'saved as mail draft'}",
                 detail=", ".join(to), actor=user.name, project_id=q.project_id, quotation_id=q.id, severity="success")
    refresh_project_state(session, session.get(Project, q.project_id))
    return result


def default_send_message(session: Session, ws: Workspace, q: Quotation) -> dict:
    enquiry = session.get(Enquiry, q.enquiry_id) if q.enquiry_id else None
    contact = (enquiry.contact if enquiry else None) or {}
    to = [contact["email"]] if contact.get("email") else []
    name = contact.get("name") or "Sir/Madam"
    subject = f"Quotation {q.reference} – {q.data.get('subject') or q.data.get('project_name') or ''}".strip(" –")
    sig = q.data.get("signatory") or {}
    body = (f"Dear {name},\n\nPlease find attached our quotation {q.reference}"
            f" for {q.data.get('project_name') or 'the above project'}.\n\n"
            "Should you have any question, please do not hesitate to contact us.\n\nBest regards,\n"
            f"{sig.get('full_name') or ''}\n{ws.company_name or ws.name}")
    return {"to": to, "subject": subject, "body": body}


def mark_superseded(session: Session, q: Quotation) -> None:
    q.status = "superseded"
    session.add(q)


def as_public(q: Quotation) -> dict[str, Any]:
    d = q.model_dump()
    d["missing_prices"] = missing_prices(q)
    return d
