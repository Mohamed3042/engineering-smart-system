"""Import / export of `ess-workspace-snapshot/1` files (see docs/snapshot-format.md).

Import is idempotent (records are matched by id/ref) and enforces the two hard rules on the
way in: evidence quotes are re-checked against the stored source text, and prices are removed.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlmodel import Session, select

from ..config import get_settings
from ..models import (
    Activity,
    Contact,
    Customer,
    Email,
    Enquiry,
    KnowledgeItem,
    Project,
    ProjectFile,
    ProjectLink,
    Workspace,
    utcnow,
)
from .state import refresh_project_state

FORMAT = "ess-workspace-snapshot/1"
PRICE_KEYS = {"unit_price", "total", "amount", "rate", "price", "unit_rate", "total_price"}
SERVICE_FAMILIES = {"bmu", "wce", "cradle", "hoist", "crane", "access_rental", "scaffolding", "space_frame", "other_work"}


# --------------------------------------------------------------------------- helpers


def parse_dt(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        try:
            dt = datetime.fromisoformat(text[:10])
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_date(value: Any) -> Optional[date]:
    dt = parse_dt(value)
    return dt.date() if dt else None


_AR_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = _AR_DIACRITICS.sub("", text)
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    text = re.sub("[إأآا]", "ا", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def quote_found(quote: str, source: str) -> bool:
    if not quote or not source:
        return False
    q, s = normalize(quote), normalize(source)
    if q in s:
        return True
    # tolerate ellipses used to join two verbatim fragments
    parts = [p.strip() for p in re.split(r"\.\.\.|…", q) if len(p.strip()) >= 12]
    return bool(parts) and all(p in s for p in parts)


def strip_prices(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: (None if k in PRICE_KEYS else strip_prices(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [strip_prices(v) for v in obj]
    return obj


def _verify_tree(obj: Any, sources: dict[str, str], stats: dict[str, int]) -> Any:
    """Mark every {"evidence": {...}} entry verified / not verified against its source text."""
    if isinstance(obj, list):
        return [_verify_tree(v, sources, stats) for v in obj]
    if not isinstance(obj, dict):
        return obj
    out = {k: _verify_tree(v, sources, stats) for k, v in obj.items()}
    ev = out.get("evidence")
    evs = ev if isinstance(ev, list) else [ev] if isinstance(ev, dict) else []
    for item in evs:
        if not isinstance(item, dict) or not item.get("quote"):
            continue
        src = sources.get(str(item.get("source_id") or ""), "")
        if not src:  # fall back to any source text of the same kind
            src = sources.get("__all__", "")
        item["verified"] = quote_found(item["quote"], src)
        stats["checked"] += 1
        stats["verified"] += int(item["verified"])
    return out


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:60] or "item"


# --------------------------------------------------------------------------- import


def import_snapshot(session: Session, ws: Workspace, snap: dict[str, Any], *, files_root: Optional[Path] = None) -> dict:
    if snap.get("format") != FORMAT:
        raise ValueError(f"Unsupported snapshot format: {snap.get('format')!r}")
    counts = {"emails": 0, "customers": 0, "contacts": 0, "projects": 0, "enquiries": 0, "links": 0,
              "files": 0, "knowledge": 0, "activity": 0}
    stats = {"checked": 0, "verified": 0}

    _merge_workspace(ws, snap.get("workspace") or {})
    session.add(ws)

    # Customers ------------------------------------------------------------------
    cust_by_ref: dict[str, Customer] = {
        c.ref: c for c in session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()
    }
    for c in snap.get("customers") or []:
        ref = (c.get("ref") or c.get("domain") or _slug(c.get("name", ""))).lower()
        cust = cust_by_ref.get(ref) or Customer(workspace_id=ws.id, ref=ref, name=c.get("name") or ref)
        cust.name = c.get("name") or cust.name
        cust.domain = c.get("domain") or cust.domain or (ref if "." in ref else "")
        if c.get("kind"):
            cust.kind = c["kind"]
            cust.kind_confidence = max(cust.kind_confidence or 0.0, 0.8)  # read from the mail by the scanner
        cust.country = c.get("country") or cust.country
        cust.city = c.get("city") or cust.city
        cust.website = c.get("website") or cust.website
        merged = {t.get("tag"): t for t in cust.tags or [] if isinstance(t, dict)}
        for t in c.get("tags") or []:
            t = t if isinstance(t, dict) else {"tag": t, "kind": "role", "confidence": 0.7, "source": "scan"}
            merged.setdefault(t.get("tag"), t)
        cust.tags = list(merged.values())
        note = c.get("notes")
        if note and note not in (cust.notes or ""):
            cust.notes = f"{cust.notes}\n{note}".strip() if cust.notes else note
        cust.updated_at = utcnow()
        session.add(cust)
        session.flush()
        cust_by_ref[ref] = cust
        counts["customers"] += 1
        for ct in c.get("contacts") or []:
            email = (ct.get("email") or "").lower()
            existing = session.exec(
                select(Contact).where(Contact.customer_id == cust.id, Contact.email == email)
            ).first() if email else None
            contact = existing or Contact(workspace_id=ws.id, customer_id=cust.id, email=email)
            contact.name = ct.get("name") or contact.name
            contact.phone = ct.get("phone") or contact.phone
            contact.title = ct.get("title") or contact.title
            session.add(contact)
            counts["contacts"] += 1

    def customer_id(ref: Optional[str]) -> Optional[str]:
        if not ref:
            return None
        cust = cust_by_ref.get(ref.lower())
        if cust is None:
            cust = Customer(workspace_id=ws.id, ref=ref.lower(), name=ref, domain=ref.lower() if "." in ref else "")
            session.add(cust)
            session.flush()
            cust_by_ref[ref.lower()] = cust
            counts["customers"] += 1
        return cust.id

    # Emails ---------------------------------------------------------------------
    sources: dict[str, str] = {}
    email_rows: dict[str, Email] = {}
    for e in snap.get("emails") or []:
        if not e.get("id"):
            continue
        row = session.get(Email, e["id"])
        incoming_has_body = bool(e.get("body_text"))
        if row is None:
            row = Email(id=e["id"], workspace_id=ws.id, thread_id=e.get("thread_id") or e["id"])
        elif not incoming_has_body and row.body_text:
            # A metadata-only overview must not erase a deep-read message.
            _apply_email_meta(row, e, overwrite_category=False)
            email_rows[row.id] = row
            sources[row.id] = f"{row.subject}\n{row.body_text}"
            continue
        _apply_email_meta(row, e, overwrite_category=True)
        row.body_text = e.get("body_text") or row.body_text or ""
        row.customer_id = customer_id(e.get("customer_ref")) if e.get("customer_ref") else row.customer_id
        row.updated_at = utcnow()
        session.add(row)
        email_rows[row.id] = row
        sources[row.id] = f"{row.subject}\n{row.body_text or row.snippet}"
        counts["emails"] += 1
    for thread_id in {r.thread_id for r in email_rows.values()}:
        sources[thread_id] = "\n\n".join(f"{r.subject}\n{r.body_text or r.snippet}" for r in email_rows.values()
                                         if r.thread_id == thread_id)
    sources["__all__"] = "\n\n".join(f"{r.subject}\n{r.body_text or ''}" for r in email_rows.values())

    # Projects -------------------------------------------------------------------
    proj_by_ref: dict[str, Project] = {
        p.ref: p for p in session.exec(select(Project).where(Project.workspace_id == ws.id)).all()
    }
    next_code = len(proj_by_ref) + 1
    pending_related: list[tuple[Project, list[str]]] = []
    for p in snap.get("projects") or []:
        ref = p.get("ref") or f"P-{_slug(p.get('name', 'project')).upper()}"
        proj = proj_by_ref.get(ref)
        if proj is None:
            proj = Project(workspace_id=ws.id, ref=ref, name=p.get("name") or ref, code=f"P-{next_code:04d}", source="scan")
            next_code += 1
        family = p.get("service_family") or (p.get("work_type") if p.get("work_type") in SERVICE_FAMILIES else None)
        work_type = p.get("work_type") if p.get("work_type") not in SERVICE_FAMILIES else None
        file_sources = _import_files(session, ws, proj, p, files_root, counts)
        all_sources = {**sources, **file_sources}
        all_sources["__all__"] = sources["__all__"] + "\n\n" + "\n\n".join(file_sources.values())

        verified = _verify_tree(strip_prices({
            "scope_items": p.get("scope_items") or [],
            "requirements": p.get("requirements") or [],
            "changes": p.get("changes") or [],
            "blockers": p.get("blockers") or [],
        }), all_sources, stats)

        proj.name = p.get("name") or proj.name
        proj.service_family = family or proj.service_family
        proj.work_type = work_type or proj.work_type
        proj.request_kind = p.get("request_kind") or proj.request_kind
        proj.customer_id = customer_id(p.get("customer_ref")) or proj.customer_id
        proj.status_note = p.get("status_note") or proj.status_note
        proj.priority = p.get("priority") or proj.priority
        proj.due_date = parse_date(p.get("due_date")) or proj.due_date
        for key in ("tender_no", "location", "owner_client", "consultant", "main_contractor", "summary", "recommended_template"):
            if p.get(key) is not None:
                setattr(proj, key, p[key])
        proj.scope_items = verified["scope_items"]
        proj.requirements = verified["requirements"]
        proj.unresolved_questions = p.get("unresolved_questions") or proj.unresolved_questions
        proj.changes = verified["changes"]
        proj.blockers = [dict(b, source=b.get("source", "scan")) for b in verified["blockers"]]
        proj.timeline = p.get("timeline") or proj.timeline
        if isinstance(p.get("next_action"), dict) and p["next_action"].get("label"):
            proj.next_action = {**p["next_action"], "source": p["next_action"].get("source") or "scan",
                                "set_at": p["next_action"].get("set_at") or snap.get("generated_at") or utcnow().isoformat()}
        if p.get("stage"):
            proj.stage = p["stage"]
        proj.updated_at = utcnow()
        session.add(proj)
        session.flush()
        proj_by_ref[ref] = proj
        counts["projects"] += 1
        pending_related.append((proj, p.get("related_project_refs") or []))

        for e_id in p.get("email_ids") or []:
            if e_id in email_rows:
                email_rows[e_id].project_id = proj.id
                if email_rows[e_id].state in ("new", "needs_review"):
                    email_rows[e_id].state = "linked"
        for e in snap.get("emails") or []:
            if e.get("project_ref") == ref and e.get("id") in email_rows:
                email_rows[e["id"]].project_id = proj.id

        _import_enquiries(session, ws, proj, p, customer_id, email_rows, counts)
        _import_links(session, ws, proj, p, counts)

    for proj, refs in pending_related:
        proj.related_project_ids = [proj_by_ref[r].id for r in refs if r in proj_by_ref]
        session.add(proj)

    # Knowledge ------------------------------------------------------------------
    for k in snap.get("knowledge") or []:
        key = k.get("key") or _slug(k.get("label", ""))
        kind = k.get("kind") or "term"
        item = session.exec(select(KnowledgeItem).where(
            KnowledgeItem.workspace_id == ws.id, KnowledgeItem.kind == kind, KnowledgeItem.key == key)).first()
        item = item or KnowledgeItem(workspace_id=ws.id, kind=kind, key=key, label=k.get("label") or key, source="import")
        for field in ("label", "label_ar", "description", "synonyms", "region", "language", "claim_basis",
                      "evidence", "value", "score", "confidence"):
            if k.get(field) is not None:
                setattr(item, field, k[field])
        if item.status != "owner_confirmed":
            item.status = k.get("status") or "suggested"
        item.updated_at = utcnow()
        session.add(item)
        counts["knowledge"] += 1

    # Activity -------------------------------------------------------------------
    for a in snap.get("activity") or []:
        proj = proj_by_ref.get(a.get("project_ref") or "")
        session.add(Activity(workspace_id=ws.id, kind=a.get("kind") or "event", title=a.get("title") or "",
                             detail=a.get("detail") or "", project_id=proj.id if proj else None,
                             created_at=parse_dt(a.get("date")) or utcnow(), actor="scan", is_read=True))
        counts["activity"] += 1

    session.flush()
    for proj in proj_by_ref.values():
        refresh_project_state(session, proj)
    refresh_customer_stats(session, ws)
    session.add(Activity(workspace_id=ws.id, kind="import", severity="success",
                         title=f"Imported {counts['projects']} projects and {counts['emails']} emails",
                         detail=f"Evidence quotes verified: {stats['verified']}/{stats['checked']}"))
    session.commit()
    return {"counts": counts, "evidence": stats}


def _merge_workspace(ws: Workspace, data: dict[str, Any]) -> None:
    for key in ("company_name", "primary_email", "region", "country", "currency", "timezone"):
        if data.get(key) and (not getattr(ws, key) or getattr(ws, key) in ("USD", "UTC")):
            setattr(ws, key, data[key])
    if data.get("languages") and not ws.languages:
        ws.languages = data["languages"]
    if ws.primary_email and "@" in ws.primary_email:
        domain = ws.primary_email.split("@", 1)[1].lower()
        if domain not in (ws.own_domains or []):
            ws.own_domains = [*(ws.own_domains or []), domain]


def _apply_email_meta(row: Email, e: dict[str, Any], *, overwrite_category: bool) -> None:
    row.thread_id = e.get("thread_id") or row.thread_id
    row.direction = e.get("direction") or row.direction
    row.from_name = e.get("from_name") or row.from_name
    row.from_email = (e.get("from_email") or row.from_email or "").lower()
    row.to = e.get("to") or row.to
    row.cc = e.get("cc") or row.cc
    row.subject = e.get("subject") or row.subject
    row.date = parse_dt(e.get("date")) or row.date
    row.snippet = e.get("snippet") or row.snippet
    row.labels = e.get("labels") or row.labels
    row.attachments = e.get("attachments") or row.attachments
    row.links = e.get("links") or row.links
    row.list_unsubscribe = e.get("list_unsubscribe") or row.list_unsubscribe
    row.view_url = e.get("view_url") or row.view_url
    row.message_count = e.get("message_count") or row.message_count
    if e.get("answered_by_us") is not None:
        row.answered_by_us = bool(e["answered_by_us"]) or row.answered_by_us
    from .changes import detect_intent

    if e.get("intent") or row.intent in ("other", "", None):
        row.intent = e.get("intent") or detect_intent(e.get("subject") or row.subject, e.get("body_text") or "",
                                                      e.get("category") or row.category)
    if overwrite_category or row.category_source in ("rules", "import") and row.category in ("other", ""):
        if e.get("category"):
            row.category = e["category"]
            row.category_confidence = float(e.get("category_confidence") or 0.0)
            row.category_reason = e.get("category_reason") or ""
            row.category_evidence = e.get("category_evidence") or []
            row.category_source = "import"
        row.priority = e.get("priority") or row.priority
        row.state = e.get("state") or row.state


def _import_files(session: Session, ws: Workspace, proj: Project, p: dict, files_root: Optional[Path],
                  counts: dict) -> dict[str, str]:
    """Copy scanned files into data/files/<project>/ and register them; return {file_ref: text}."""
    settings = get_settings()
    texts: dict[str, str] = {}
    for f in p.get("files") or []:
        name = f.get("name") or Path(f.get("path") or "file").name
        src = None
        if f.get("path"):
            cand = Path(f["path"])
            if not cand.is_absolute() and files_root is not None:
                cand = files_root / cand
            src = cand if cand.exists() else None
        rel = None
        sha = f.get("sha256")
        size = f.get("size") or 0
        if src is not None:
            dest_dir = settings.files_dir / proj.id
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / name
            if not dest.exists():
                shutil.copy2(src, dest)
            data = dest.read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            size = len(data)
            rel = str(dest.relative_to(settings.data_dir))
        existing = session.exec(select(ProjectFile).where(ProjectFile.project_id == proj.id, ProjectFile.name == name)).first()
        row = existing or ProjectFile(workspace_id=ws.id, project_id=proj.id, name=name)
        row.doc_kind = f.get("doc_kind") or row.doc_kind
        row.source = f.get("source") or "scan"
        row.source_url = f.get("source_url") or row.source_url
        row.path = rel or row.path
        row.sha256 = sha or row.sha256
        row.size = size or row.size
        row.mime = f.get("mime") or row.mime
        row.status = "ready" if rel else ("not_downloaded" if not row.path else row.status)
        row.summary = f.get("summary") or row.summary
        row.updated_at = utcnow()
        session.add(row)
        session.flush()
        counts["files"] += 1
        if rel:
            text = _file_text(settings.data_dir / rel)
            for key in {name, f.get("path") or "", row.id, f.get("source_id") or ""}:
                if key:
                    texts[key] = text
    for a in p.get("attachments") or []:
        name = a.get("filename") or "attachment"
        existing = session.exec(select(ProjectFile).where(ProjectFile.project_id == proj.id, ProjectFile.name == name)).first()
        if existing:
            continue
        session.add(ProjectFile(workspace_id=ws.id, project_id=proj.id, name=name, doc_kind=a.get("doc_kind") or "other",
                                source="email_attachment", email_id=a.get("email_id"), attachment_id=a.get("attachment_id"),
                                mime=a.get("mime") or "", size=a.get("size") or 0, status="not_downloaded"))
        counts["files"] += 1
    return texts


def _file_text(path: Path) -> str:
    try:
        from ..documents.extract import extract_document

        return extract_document(path).text or ""
    except Exception:
        try:
            return path.read_text(encoding="utf-8", errors="ignore") if path.suffix.lower() in (".txt", ".md", ".csv") else ""
        except OSError:
            return ""


def _import_enquiries(session: Session, ws: Workspace, proj: Project, p: dict, customer_id, email_rows, counts) -> None:
    enquiries = p.get("enquiries") or []
    if not enquiries and p.get("customer_ref"):
        enquiries = [{"ref": f"E-{proj.ref}", "customer_ref": p["customer_ref"], "email_ids": p.get("email_ids") or [],
                      "thread_ids": p.get("thread_ids") or [], "due_date": p.get("due_date"),
                      "our_response": p.get("our_response") or {}}]
    for e in enquiries:
        ref = e.get("ref") or f"E-{proj.ref}-{e.get('customer_ref')}"
        enq = session.exec(select(Enquiry).where(Enquiry.project_id == proj.id, Enquiry.ref == ref)).first()
        enq = enq or Enquiry(workspace_id=ws.id, project_id=proj.id, ref=ref)
        enq.customer_id = customer_id(e.get("customer_ref")) or enq.customer_id
        enq.contact = e.get("contact") or enq.contact
        enq.email_ids = e.get("email_ids") or enq.email_ids
        enq.thread_ids = e.get("thread_ids") or enq.thread_ids
        enq.received_at = parse_dt(e.get("received_at")) or enq.received_at
        enq.due_date = parse_date(e.get("due_date")) or enq.due_date
        enq.due_date_history = e.get("due_date_history") or enq.due_date_history
        enq.status = e.get("status") or enq.status
        enq.our_response = e.get("our_response") or enq.our_response
        if (enq.our_response or {}).get("status") == "quoted" and enq.status == "open":
            enq.status = "quoted"
        enq.updated_at = utcnow()
        session.add(enq)
        session.flush()
        for e_id in enq.email_ids or []:
            if e_id in email_rows:
                email_rows[e_id].enquiry_id = enq.id
                email_rows[e_id].project_id = proj.id
        counts["enquiries"] += 1


def _import_links(session: Session, ws: Workspace, proj: Project, p: dict, counts: dict) -> None:
    from urllib.parse import urlparse

    for l in p.get("links") or []:
        url = l.get("url")
        if not url:
            continue
        row = session.exec(select(ProjectLink).where(ProjectLink.project_id == proj.id, ProjectLink.url == url)).first()
        row = row or ProjectLink(workspace_id=ws.id, project_id=proj.id, url=url)
        row.kind = l.get("kind") or row.kind
        row.host = urlparse(url).hostname or ""
        status = l.get("status") or row.status
        # A sandbox block is not a property of the link: on the user's machine it can be fetched.
        row.status = "found" if status == "blocked_in_sandbox" else status
        row.note = l.get("note") or row.note
        row.email_id = l.get("email_id") or row.email_id
        row.updated_at = utcnow()
        session.add(row)
        counts["links"] += 1


def refresh_customer_stats(session: Session, ws: Workspace) -> None:
    customers = session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()
    for cust in customers:
        emails = session.exec(select(Email).where(Email.customer_id == cust.id)).all()
        enquiries = session.exec(select(Enquiry).where(Enquiry.customer_id == cust.id)).all()
        cust.email_count = len(emails)
        cust.enquiry_count = len(enquiries)
        cust.project_count = len({e.project_id for e in enquiries})
        dates = [e.date for e in emails if e.date]
        if dates:
            cust.first_seen = min(dates)
            cust.last_seen = max(dates)
        session.add(cust)


# --------------------------------------------------------------------------- export


def export_snapshot(session: Session, ws: Workspace) -> dict[str, Any]:
    customers = session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()
    by_id = {c.id: c for c in customers}
    projects = session.exec(select(Project).where(Project.workspace_id == ws.id)).all()
    proj_ref = {p.id: p.ref for p in projects}
    emails = session.exec(select(Email).where(Email.workspace_id == ws.id)).all()
    out_projects = []
    for p in projects:
        enqs = session.exec(select(Enquiry).where(Enquiry.project_id == p.id)).all()
        links = session.exec(select(ProjectLink).where(ProjectLink.project_id == p.id)).all()
        files = session.exec(select(ProjectFile).where(ProjectFile.project_id == p.id)).all()
        out_projects.append({
            "ref": p.ref, "name": p.name, "service_family": p.service_family, "work_type": p.work_type,
            "request_kind": p.request_kind, "customer_ref": by_id[p.customer_id].ref if p.customer_id in by_id else None,
            "enquiries": [{
                "ref": e.ref, "customer_ref": by_id[e.customer_id].ref if e.customer_id in by_id else None,
                "contact": e.contact, "email_ids": e.email_ids, "thread_ids": e.thread_ids,
                "received_at": e.received_at.isoformat() if e.received_at else None,
                "due_date": e.due_date.isoformat() if e.due_date else None, "due_date_history": e.due_date_history,
                "status": e.status, "our_response": e.our_response} for e in enqs],
            "stage": p.stage, "status_note": p.status_note, "priority": p.priority,
            "due_date": p.due_date.isoformat() if p.due_date else None, "tender_no": p.tender_no,
            "location": p.location, "owner_client": p.owner_client, "consultant": p.consultant,
            "main_contractor": p.main_contractor, "summary": p.summary, "changes": p.changes,
            "blockers": [b for b in p.blockers if b.get("source") != "derived"], "next_action": p.next_action,
            "scope_items": p.scope_items, "requirements": p.requirements,
            "unresolved_questions": p.unresolved_questions,
            "links": [{"url": l.url, "kind": l.kind, "email_id": l.email_id, "status": l.status, "note": l.note} for l in links],
            "files": [{"name": f.name, "path": f.path, "source": f.source, "source_url": f.source_url, "sha256": f.sha256,
                       "size": f.size, "mime": f.mime, "doc_kind": f.doc_kind, "summary": f.summary} for f in files],
            "timeline": p.timeline, "recommended_template": p.recommended_template,
            "related_project_refs": [proj_ref[r] for r in p.related_project_ids if r in proj_ref],
        })
    return {
        "format": FORMAT,
        "generated_at": utcnow().isoformat(),
        "generator": "ess-export",
        "workspace": {"name": ws.name, "company_name": ws.company_name, "primary_email": ws.primary_email,
                      "region": ws.region, "country": ws.country, "languages": ws.languages,
                      "currency": ws.currency, "timezone": ws.timezone},
        "emails": [{
            "id": e.id, "thread_id": e.thread_id, "direction": e.direction, "from_name": e.from_name,
            "from_email": e.from_email, "to": e.to, "cc": e.cc, "subject": e.subject,
            "date": e.date.isoformat() if e.date else None, "snippet": e.snippet, "body_text": e.body_text,
            "labels": e.labels, "attachments": e.attachments, "links": e.links,
            "list_unsubscribe": e.list_unsubscribe, "view_url": e.view_url, "category": e.category,
            "category_confidence": e.category_confidence, "category_reason": e.category_reason,
            "category_evidence": e.category_evidence, "priority": e.priority, "state": e.state,
            "project_ref": proj_ref.get(e.project_id or ""),
            "customer_ref": by_id[e.customer_id].ref if e.customer_id in by_id else None,
            "message_count": e.message_count, "answered_by_us": e.answered_by_us} for e in emails],
        "customers": [{
            "ref": c.ref, "name": c.name, "domain": c.domain, "kind": c.kind, "country": c.country, "city": c.city,
            "tags": c.tags, "notes": c.notes,
            "contacts": [{"name": ct.name, "email": ct.email, "phone": ct.phone, "title": ct.title}
                         for ct in session.exec(select(Contact).where(Contact.customer_id == c.id)).all()]}
            for c in customers],
        "projects": out_projects,
        "knowledge": [{
            "kind": k.kind, "key": k.key, "label": k.label, "label_ar": k.label_ar, "description": k.description,
            "synonyms": k.synonyms, "region": k.region, "language": k.language, "claim_basis": k.claim_basis,
            "evidence": k.evidence, "value": k.value, "score": k.score, "confidence": k.confidence, "status": k.status}
            for k in session.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id)).all()],
    }
