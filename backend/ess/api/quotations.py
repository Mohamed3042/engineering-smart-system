"""Quotations, templates, signatories, letterhead assets, approval queue and the send gate."""
from __future__ import annotations

import copy
import io
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlmodel import Session, col, select

from .. import jobs
from ..config import get_settings
from ..db import get_session
from ..models import (
    Approval,
    Customer,
    Enquiry,
    Project,
    Quotation,
    Signatory,
    TeamMember,
    TemplateSetting,
    Workspace,
    utcnow,
)
from ..pipeline import drafting
from ..pipeline.state import refresh_project_state
from ..workspace import log_activity
from .deps import get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["quotations"])

EDITABLE = {"to", "project_name", "subject", "tender_no", "enquiry_ref", "intro", "items", "currency", "price_unit",
            "terms", "exclusions", "notes", "show_total", "stamp", "clarifications", "date", "paper_id", "photos"}


@router.get("/quotations")
def list_quotations(status: Optional[str] = None, project_id: Optional[str] = None, q: Optional[str] = None,
                    session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    query = select(Quotation).where(Quotation.workspace_id == ws.id)
    if status:
        query = query.where(col(Quotation.status).in_(status.split(",")))
    else:
        query = query.where(Quotation.status != "superseded")
    if project_id:
        query = query.where(Quotation.project_id == project_id)
    if q:
        query = query.where(col(Quotation.reference).ilike(f"%{q}%"))
    rows = session.exec(query.order_by(col(Quotation.updated_at).desc())).all()
    projects = {p.id: p for p in session.exec(select(Project).where(Project.workspace_id == ws.id)).all()}
    customers = {c.id: c for c in session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()}
    items = []
    for x in rows:
        p = projects.get(x.project_id)
        c = customers.get(x.customer_id or "")
        items.append({**drafting.as_public(x),
                      "project": {"id": p.id, "name": p.name, "service_family": p.service_family} if p else None,
                      "customer": {"id": c.id, "name": c.name} if c else None})
    counts = {s: sum(1 for x in rows if x.status == s) for s in ("draft", "needs_review", "changes_requested", "approved", "sent")}
    return {"items": items, "counts": counts}


@router.post("/quotations")
def new_quotation(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                  user: TeamMember = Depends(user_dep)) -> dict:
    project = get_or_404(session, Project, data.get("project_id") or "", ws)
    enquiry = get_or_404(session, Enquiry, data["enquiry_id"], ws) if data.get("enquiry_id") else None
    signatory = get_or_404(session, Signatory, data["signatory_id"], ws) if data.get("signatory_id") else None
    q = drafting.create_quotation(session, ws, project, enquiry=enquiry, template_key=data.get("template_key"),
                                  language=data.get("language"), signatory=signatory, actor=user.name)
    session.commit()
    return drafting.as_public(q)


@router.get("/quotations/{quotation_id}")
def get_quotation(quotation_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    q = get_or_404(session, Quotation, quotation_id, ws)
    project = session.get(Project, q.project_id)
    enquiry = session.get(Enquiry, q.enquiry_id) if q.enquiry_id else None
    approvals = session.exec(select(Approval).where(Approval.target_id == q.id).order_by(col(Approval.created_at))).all()
    return {"quotation": drafting.as_public(q), "project": project, "enquiry": enquiry,
            "customer": session.get(Customer, q.customer_id) if q.customer_id else None,
            "signatory": session.get(Signatory, q.signatory_id) if q.signatory_id else None,
            "approvals": approvals, "send_defaults": drafting.default_send_message(session, ws, q),
            "approval_blockers": drafting.approval_blockers(session, ws, q)}


@router.put("/quotations/{quotation_id}")
def edit_quotation(quotation_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    """People edit drafts here, including prices. Approved/sent quotations are frozen: edit makes a new version."""
    q = get_or_404(session, Quotation, quotation_id, ws)
    if q.status in ("approved", "sent"):
        raise HTTPException(409, {"code": "frozen", "message": "Approved quotations are frozen. Create a revision."})
    patch = {k: v for k, v in (data.get("data") or {}).items() if k in EDITABLE}
    if (data.get("template_key") and data["template_key"] != q.template_key) or (
            data.get("language") and data["language"] != q.language):
        drafting.require_enabled_template(session, ws, data.get("template_key") or q.template_key,
                                          data.get("language") or q.language)
    before = dict(q.data)
    merged = {**q.data, **patch}
    for item in merged.get("items") or []:
        if item.get("unit_price") not in (None, "") and item.get("qty") not in (None, ""):
            try:
                item["total"] = round(float(item["qty"]) * float(item["unit_price"]), 3)
            except (TypeError, ValueError):
                item["total"] = None
    q.data = merged
    from ..learning import on_quotation_edited, on_template_changed

    project = session.get(Project, q.project_id)
    choice = {k: data.get(k) for k in ("template_key", "language", "signatory_id")}
    if patch.get("paper_id") and patch.get("paper_id") != before.get("paper_id"):
        choice["paper_id"] = patch["paper_id"]
    if any(v and v != getattr(q, k, None) for k, v in choice.items() if k != "paper_id") or choice.get("paper_id"):
        on_template_changed(session, ws, q, project, {**{"template_key": q.template_key, "language": q.language},
                                                      **{k: v for k, v in choice.items() if v}}, user.name)
    on_quotation_edited(session, ws, q, project, before, merged, user.name)
    for key in ("template_key", "language", "signatory_id"):
        if data.get(key):
            setattr(q, key, data[key])
    if q.status == "changes_requested":
        q.status = "draft"
    q.updated_at = utcnow()
    q.pdf_path = None  # stale until re-rendered
    session.add(q)
    log_activity(session, ws.id, "quotation_edited", f"Quotation {q.reference} edited", actor=user.name,
                 project_id=q.project_id, quotation_id=q.id)
    session.commit()
    return drafting.as_public(q)


@router.post("/quotations/{quotation_id}/term-changes/{key}/decide")
def decide_term(quotation_id: str, key: str, data: dict = Body(...), session: Session = Depends(get_session),
                ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    """A person decides a term the customer asked for: accept the requested wording, keep the template
    wording (reason required) or ask the customer to clarify."""
    from ..pipeline.terms import decide_term_change

    q = get_or_404(session, Quotation, quotation_id, ws)
    if q.status in ("approved", "sent", "superseded"):
        raise HTTPException(409, {"code": "frozen", "message": "This quotation is frozen. Create a revision: "
                                                               "it needs a fresh approval and send authorization."})
    data_copy = copy.deepcopy(q.data or {})
    try:
        changed = decide_term_change(data_copy, key, str(data.get("decision") or ""), actor=user.name,
                                     revision=f"{q.reference} v{q.version}", reason=str(data.get("reason") or ""))
    except LookupError:
        raise HTTPException(404, {"code": "no_term_change", "message": f"No requested term '{key}' on this quotation."})
    except ValueError as exc:
        code = "reason_required" if data.get("decision") == "retain" else "bad_decision"
        raise HTTPException(400, {"code": code, "message": str(exc)})
    q.data, q.updated_at = data_copy, utcnow()
    reopened = changed and q.status == "needs_review"
    if changed:
        q.pdf_path = None  # stale until re-rendered
    if reopened:
        q.status = "draft"  # the approver saw other terms: approval must be requested again
    session.add(q)
    log_activity(session, ws.id, "quotation_term_decided", f"{q.reference}: requested {key} term {data.get('decision')}",
                 detail="Approval request reopened" if reopened else "", actor=user.name,
                 project_id=q.project_id, quotation_id=q.id)
    session.commit()
    return drafting.as_public(q)


@router.post("/quotations/{quotation_id}/revise")
def revise(quotation_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
           user: TeamMember = Depends(user_dep)) -> dict:
    old = get_or_404(session, Quotation, quotation_id, ws)
    new = Quotation(**{k: v for k, v in old.model_dump().items() if k not in (
        "id", "status", "version", "pdf_path", "pdf_rendered_at", "approved_by", "approved_at", "sent_at", "sent_via",
        "mail_draft_id", "created_at", "updated_at")}, status="draft", version=old.version + 1)
    new.data = {**old.data, "reference": f"{old.reference} Rev.{old.version}"}
    new.reference = new.data["reference"]
    drafting.mark_superseded(session, old)
    session.add(new)
    log_activity(session, ws.id, "quotation_revised", f"Revision {new.version} of {old.reference}", actor=user.name,
                 project_id=old.project_id, quotation_id=new.id)
    session.commit()
    return drafting.as_public(new)


@router.post("/quotations/{quotation_id}/render")
def render(quotation_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    get_or_404(session, Quotation, quotation_id, ws)
    session.commit()
    path = jobs._call(drafting.render_pdf, quotation_id)  # rendering takes ~1 s; keep it synchronous
    return {"pdf": path}


@router.get("/quotations/{quotation_id}/pdf")
def pdf(quotation_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)):
    q = get_or_404(session, Quotation, quotation_id, ws)
    path = _current_pdf(session, q)
    return FileResponse(path, media_type="application/pdf", filename=path.name,
                        headers={"Content-Disposition": f'inline; filename="{path.name}"'})


def _current_pdf(session: Session, q: Quotation):
    if not q.pdf_path or not (get_settings().data_dir / q.pdf_path).exists():
        session.commit()
        jobs._call(drafting.render_pdf, q.id)
        session.refresh(q)
    return get_settings().data_dir / q.pdf_path


@router.get("/quotations/{quotation_id}/pages")
def quotation_pages(quotation_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    """Page count of the current PDF (rendered first when stale), for page previews in the editor."""
    import pypdfium2 as pdfium

    q = get_or_404(session, Quotation, quotation_id, ws)
    path = _current_pdf(session, q)
    doc = pdfium.PdfDocument(str(path))
    try:
        return {"count": len(doc), "rendered_at": q.pdf_rendered_at}
    finally:
        doc.close()


@router.get("/quotations/{quotation_id}/pages/{page}.png")
def quotation_page(quotation_id: str, page: int, dpi: int = 80, session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep)):
    """One page of the current PDF as an image: shows where the stamp and photos really land."""
    import io

    import pypdfium2 as pdfium

    q = get_or_404(session, Quotation, quotation_id, ws)
    path = _current_pdf(session, q)
    doc = pdfium.PdfDocument(str(path))
    try:
        if page < 1 or page > len(doc):
            raise HTTPException(404, {"code": "no_page", "message": f"The PDF has {len(doc)} page(s)"})
        image = doc[page - 1].render(scale=min(max(dpi, 40), 200) / 72).to_pil()
        buf = io.BytesIO()
        image.save(buf, "PNG")
        return Response(content=buf.getvalue(), media_type="image/png",
                        headers={"Cache-Control": "no-store", "X-Page-Count": str(len(doc))})
    finally:
        doc.close()


@router.post("/quotations/{quotation_id}/submit")
def submit(quotation_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
           user: TeamMember = Depends(user_dep)) -> dict:
    q = get_or_404(session, Quotation, quotation_id, ws)
    if q.status not in ("draft", "changes_requested"):
        raise HTTPException(409, {"code": "bad_state", "message": f"Quotation is {q.status}"})
    q.status, q.updated_at = "needs_review", utcnow()
    session.add(q)
    log_activity(session, ws.id, "quotation_submitted", f"{q.reference} waits for approval", actor=user.name,
                 project_id=q.project_id, quotation_id=q.id, severity="warning")
    refresh_project_state(session, session.get(Project, q.project_id))
    session.commit()
    return drafting.as_public(q)


@router.post("/quotations/{quotation_id}/approve")
def approve(quotation_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
            ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "engineer", "Approving a quotation")
    q = get_or_404(session, Quotation, quotation_id, ws)
    if q.status not in ("needs_review", "draft"):
        raise HTTPException(409, {"code": "bad_state", "message": f"Quotation is {q.status}"})
    drafting.approve_quotation(session, ws, q, user, data.get("note", ""))
    q.pdf_path = None
    session.commit()
    jobs._call(drafting.render_pdf, quotation_id)  # final PDF without the draft watermark
    session.refresh(q)
    return drafting.as_public(q)


@router.post("/quotations/{quotation_id}/request-changes")
def quotation_changes(quotation_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                      ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "engineer", "Requesting changes on a quotation")
    q = get_or_404(session, Quotation, quotation_id, ws)
    if q.status != "needs_review":
        raise HTTPException(409, {"code": "bad_state", "message": f"Quotation is {q.status}, not waiting for approval"})
    note = (data.get("note") or "").strip()
    if not note:
        raise HTTPException(400, {"code": "note_required", "message": "Say what must change"})
    q.status = "changes_requested"
    q.change_requests = [*(q.change_requests or []), {"by": user.name, "at": utcnow().isoformat(), "note": note,
                                                      "items": data.get("items") or []}]
    session.add(q)
    session.add(Approval(workspace_id=ws.id, action="approve_quotation", target_type="quotation", target_id=q.id,
                         decided_by=user.name, decision="rejected", note=note))
    from ..learning import on_review_note

    on_review_note(session, ws, session.get(Project, q.project_id), note, user.name, kind="change_request")
    log_activity(session, ws.id, "quotation_changes", f"Changes requested on {q.reference}", detail=note,
                 actor=user.name, project_id=q.project_id, quotation_id=q.id, severity="warning")
    session.commit()
    return drafting.as_public(q)


@router.post("/quotations/{quotation_id}/send")
def send(quotation_id: str, data: dict = Body(...), session: Session = Depends(get_session),
         ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "engineer", "Sending a quotation")
    if data.get("confirm") is not True:
        raise HTTPException(400, {"code": "confirm_required", "message": "Confirm the recipients and attachment first."})
    q = get_or_404(session, Quotation, quotation_id, ws)
    if q.status != "approved":
        raise HTTPException(409, {"code": "not_approved", "message": "Only approved quotations can be sent."})
    if not q.pdf_path:
        session.commit()
        jobs._call(drafting.render_pdf, quotation_id)
        session.refresh(q)
    result = drafting.send_quotation(session, ws, q, user, to=data.get("to") or [], subject=data.get("subject") or "",
                                     body=data.get("body") or "", send_now=bool(data.get("send_now")))
    session.commit()
    return result


@router.get("/approvals")
def approval_queue(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    pending = session.exec(select(Quotation).where(Quotation.workspace_id == ws.id, Quotation.status == "needs_review")
                           .order_by(col(Quotation.updated_at))).all()
    history = session.exec(select(Approval).where(Approval.workspace_id == ws.id)
                           .order_by(col(Approval.created_at).desc()).limit(50)).all()
    projects = {p.id: p for p in session.exec(select(Project).where(Project.workspace_id == ws.id)).all()}
    customers = {c.id: c for c in session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()}
    return {"pending": [{**drafting.as_public(q), "project": projects.get(q.project_id),
                         "customer": customers.get(q.customer_id or ""),
                         "approval_blockers": drafting.approval_blockers(session, ws, q)} for q in pending],
            "history": history}


# --------------------------------------------------------------------------- templates


@router.get("/templates")
def templates(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[dict]:
    from ..quotation.templates import TEMPLATES

    settings = {t.id: t for t in session.exec(select(TemplateSetting).where(TemplateSetting.workspace_id == ws.id)).all()}
    out = []
    for key, spec in TEMPLATES.items():
        d = spec.to_dict() if hasattr(spec, "to_dict") else dict(getattr(spec, "__dict__", {}))
        d["key"] = key
        d["settings"] = {lang: settings.get(f"{ws.id}:{key}:{lang}") for lang in d.get("languages", ["en"])}
        out.append(d)
    return out


@router.put("/templates/{key}/{language}")
def update_template(key: str, language: str, data: dict = Body(...), session: Session = Depends(get_session),
                    ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> TemplateSetting:
    require_role(user, "admin", "Editing templates")
    from ..quotation.templates import OVERRIDE_KEYS, TEMPLATES

    if key not in TEMPLATES:
        raise HTTPException(404, {"code": "no_template", "message": key})
    row = session.get(TemplateSetting, f"{ws.id}:{key}:{language}") or TemplateSetting(
        id=f"{ws.id}:{key}:{language}", workspace_id=ws.id, key=key, language=language)
    row.enabled = data.get("enabled", row.enabled)
    if "overrides" in data:  # the full set of the company's wording; {} or nulls go back to the template's
        row.overrides = {k: v for k, v in (data["overrides"] or {}).items() if k in OVERRIDE_KEYS and v not in (None, "", [])}
    row.applies_to = data.get("applies_to", row.applies_to)
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    return row


@router.post("/templates/preview")
async def template_preview(data: dict = Body(...), session: Session = Depends(get_session),
                           ws: Workspace = Depends(ws_dep)) -> dict:
    from ..quotation.assets import LetterheadAssets
    from ..quotation.render import render_quotation_html
    from ..quotation.templates import apply_overrides, default_quotation

    sig = drafting.signatory_dict(session.get(Signatory, data.get("signatory_id") or "") , ws)
    q = default_quotation(data.get("template_key") or "supply_installation", data.get("language") or "en",
                          {"name": "Sample project", "service_family": "bmu"}, {"company": "Sample customer"}, sig)
    own = session.get(TemplateSetting, f"{ws.id}:{q['template_key']}:{q['language']}")
    apply_overrides(q, own.overrides if own else None)
    assets = LetterheadAssets.load(get_settings().private_dir, ws.company_name or ws.name, sig["initials"])
    return {"html": render_quotation_html(q, {"company_name": ws.company_name or ws.name, "name": ws.name}, sig, assets)}


# --------------------------------------------------------------------------- signatories & letterhead


@router.get("/signatories")
def signatories(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[dict]:
    rows = session.exec(select(Signatory).where(Signatory.workspace_id == ws.id).order_by(col(Signatory.created_at))).all()
    sig_dir = get_settings().private_dir / "signatures"
    return [{**s.model_dump(), "has_signature_image": (sig_dir / f"{s.initials.upper()}.png").exists()} for s in rows]


@router.post("/signatories")
def add_signatory(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                  user: TeamMember = Depends(user_dep)) -> Signatory:
    require_role(user, "admin", "Adding signatories")
    if not data.get("initials") or not data.get("full_name"):
        raise HTTPException(400, {"code": "required", "message": "Initials and full name are required"})
    sig = Signatory(workspace_id=ws.id, initials=data["initials"].upper()[:4], full_name=data["full_name"],
                    title=data.get("title") or "", company=data.get("company") or ws.company_name,
                    city=data.get("city") or "", email=data.get("email") or "", phone=data.get("phone"),
                    is_default=bool(data.get("is_default")))
    if sig.is_default or not session.exec(select(Signatory).where(Signatory.workspace_id == ws.id)).first():
        for other in session.exec(select(Signatory).where(Signatory.workspace_id == ws.id)).all():
            other.is_default = False
            session.add(other)
        sig.is_default = True
    session.add(sig)
    session.commit()
    return sig


@router.patch("/signatories/{sig_id}")
def edit_signatory(sig_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Signatory:
    require_role(user, "admin", "Editing signatories")
    sig = get_or_404(session, Signatory, sig_id, ws)
    for k in ("full_name", "title", "company", "city", "email", "phone"):
        if k in data:
            setattr(sig, k, data[k])
    if data.get("is_default"):
        for other in session.exec(select(Signatory).where(Signatory.workspace_id == ws.id)).all():
            other.is_default = other.id == sig.id
            session.add(other)
    session.add(sig)
    session.commit()
    return sig


@router.delete("/signatories/{sig_id}")
def delete_signatory(sig_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                     user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Removing signatories")
    sig = get_or_404(session, Signatory, sig_id, ws)
    session.delete(sig)
    session.commit()
    return {"deleted": sig_id}


def _save_private_image(sub: str, name: str, data: bytes) -> str:
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    img.load()
    dest_dir = get_settings().private_dir / sub
    dest_dir.mkdir(parents=True, exist_ok=True)
    fmt = "PNG" if name.endswith(".png") else "JPEG"
    dest = dest_dir / name
    (img if fmt == "PNG" else img.convert("RGB")).save(dest, fmt)
    return str(dest)


@router.post("/signatories/{sig_id}/signature/detect")
async def detect_signature_route(sig_id: str, file: UploadFile = File(...), session: Session = Depends(get_session),
                                 ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    """Step 1 of 'import signature from a signed letter': show where the signature and stamp were found."""
    from ..quotation.signature_import import detect_signature

    require_role(user, "admin", "Importing signatures")
    get_or_404(session, Signatory, sig_id, ws)
    return detect_signature(await file.read()).to_dict()


@router.post("/signatories/{sig_id}/signature")
async def upload_signature(sig_id: str, file: UploadFile = File(...), mode: str = "detect",
                           x: Optional[float] = None, y: Optional[float] = None, w: Optional[float] = None,
                           h: Optional[float] = None, session: Session = Depends(get_session),
                           ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    """mode=detect cuts the blue-ink signature out of a photo/scan (a drawn box x,y,w,h wins);
    mode=raw stores a clean transparent PNG as it is."""
    from ..quotation.signature_import import SignatureNotFound, extract_signature

    require_role(user, "admin", "Uploading signatures")
    sig = get_or_404(session, Signatory, sig_id, ws)
    data = await file.read()
    if mode == "raw":
        _save_private_image("signatures", f"{sig.initials.upper()}.png", data)
        return {"ok": True, "mode": "raw"}
    box = (x, y, w, h) if None not in (x, y, w, h) else None
    try:
        png = extract_signature(data, crop_box=box)
    except SignatureNotFound as exc:
        raise HTTPException(422, {"code": "signature_not_found", "message": str(exc)})
    dest = get_settings().private_dir / "signatures"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{sig.initials.upper()}.png").write_bytes(png)
    return {"ok": True, "mode": "detect", "bytes": len(png)}


@router.get("/papers")
def papers(ws: Workspace = Depends(ws_dep)) -> dict:
    """Installed company papers (letterheads); the default follows workspace settings."""
    from ..quotation.papers import default_paper_id, list_papers

    rows = list_papers(get_settings().private_dir)
    chosen = (ws.settings or {}).get("quotations", {}).get("default_paper_id") or default_paper_id(rows)
    return {"items": [p.to_dict() for p in rows], "default": chosen}


@router.get("/catalog")
def catalog(q: str = "", language: str = "en", transaction: Optional[str] = None, limit: int = 20,
            ws: Workspace = Depends(ws_dep)) -> dict:
    """Catalog prefill: description/spec/unit; the dated last-known price is guidance only."""
    from ..quotation.catalog import load_catalog, search_catalog

    cat = load_catalog(get_settings().private_dir)
    return {"items": search_catalog(q, cat, language=language, transaction=transaction, limit=min(limit, 100))}


@router.post("/quotations/{quotation_id}/photos")
async def add_photo(quotation_id: str, file: UploadFile = File(...), caption: str = Form(""), placement: str = Form("annex"),
                    session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    from ..quotation.photos import normalize_photo

    q = get_or_404(session, Quotation, quotation_id, ws)
    if q.status in ("approved", "sent"):
        raise HTTPException(409, {"code": "frozen", "message": "Approved quotations are frozen. Create a revision."})
    try:
        photo = normalize_photo(await file.read())
    except ValueError as exc:
        raise HTTPException(400, {"code": "bad_image", "message": str(exc)})
    folder = get_settings().quotations_dir / q.id / "photos"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"photo-{len(list(folder.glob('*.jpg'))) + 1}.jpg"
    path.write_bytes(photo.jpeg)
    data = dict(q.data)
    data["photos"] = [*(data.get("photos") or []), {"path": str(path), "caption": caption, "placement": placement}]
    q.data, q.pdf_path, q.updated_at = data, None, utcnow()
    session.add(q)
    session.commit()
    return drafting.as_public(q)


@router.get("/quotations/{quotation_id}/photos/{index}")
def photo_image(quotation_id: str, index: int, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)):
    """A reference photo of this quotation (thumbnail source for the editor)."""
    q = get_or_404(session, Quotation, quotation_id, ws)
    photos = (q.data or {}).get("photos") or []
    if index < 0 or index >= len(photos):
        raise HTTPException(404, {"code": "no_photo", "message": "No such photo"})
    path = Path(str(photos[index].get("path") or "")).resolve()
    root = get_settings().quotations_dir.resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(404, {"code": "no_photo", "message": "The photo file is missing"})
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/letterhead")
def letterhead_status(ws: Workspace = Depends(ws_dep)) -> dict:
    base = get_settings().private_dir / "letterhead"
    found = {}
    for asset in ("header", "footer", "stamp", "watermark"):
        found[asset] = next((p.name for p in sorted(base.glob(f"{asset}.*"))), None) if base.exists() else None
    return {"assets": found, "private_dir": str(get_settings().private_dir), "complete": all(found[a] for a in ("header", "footer"))}


@router.post("/letterhead/{asset}")
async def upload_letterhead(asset: str, file: UploadFile = File(...), ws: Workspace = Depends(ws_dep),
                            user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Changing the letterhead")
    if asset not in ("header", "footer", "stamp", "watermark"):
        raise HTTPException(400, {"code": "bad_asset", "message": asset})
    ext = ".png" if asset in ("stamp", "watermark") else ".jpg"
    base = get_settings().private_dir / "letterhead"
    for old in base.glob(f"{asset}.*") if base.exists() else []:
        old.unlink()
    _save_private_image("letterhead", f"{asset}{ext}", await file.read())
    return letterhead_status(ws)
