"""Mailbox scan: fetch threads, store mail, classify, group enquiries into projects, register files.

Grouping rule: one project per building/tender. Tender numbers and name similarity decide whether
a new enquiry belongs to an existing project; each sender company gets its own enquiry.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from rapidfuzz import fuzz
from sqlmodel import Session, select

from ..db import session_scope
from ..models import (
    Category,
    Contact,
    Customer,
    Email,
    Enquiry,
    Project,
    ProjectFile,
    ScanJob,
    Workspace,
    utcnow,
)
from ..workspace import log_activity
from .changes import detect_changes, find_closing_date
from .connect import engine_for, mail_source_for
from .files import register_links
from .state import refresh_project_state

WORK_GROUP = "work"
TENDER_PATTERNS = [
    re.compile(r"\bRFP[-\s]?(\d{5,})\b", re.I),
    re.compile(r"\bKOC[-\s]?(\d{5,})\b", re.I),
    re.compile(r"\bCAPT\.?\s*No\.?\s*([A-Z]{2,5}\s*/\s*\d{2,5})", re.I),
    re.compile(r"\btender\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-.]{3,30})", re.I),
]
SUBJECT_NOISE = re.compile(
    r"^(?:\s*(?:re|fw|fwd|tr|aw)\s*:\s*)+|\b(?:r\.?f\.?q\.?|request\s+for\s+quotation|inquiry|enquiry|tender|add(?:endum)?[-\s]?\d+|"
    r"quotation|rfq)\b[\s:_\-–]*",
    re.I,
)


def clean_subject(subject: str) -> str:
    s = SUBJECT_NOISE.sub(" ", subject or "")
    s = re.sub(r"[_\s]+", " ", s).strip(" -–:@")
    return s[:120] or (subject or "Untitled enquiry")[:120]


def canonical_tender(value: str) -> str:
    """'RFP-2143588', 'KOC-2143588', 'Tender No. RFP 2143588.' → '2143588' (one tender, many spellings)."""
    v = re.sub(r"\s+", "", value or "").upper().strip(".,;:)(")
    m = re.fullmatch(r"(?:RFP|KOC|RFQ)[-/]?(\d{5,})", v)
    return m.group(1) if m else v


def tender_numbers(text: str) -> list[str]:
    """Tender numbers in order of appearance, most specific patterns first, canonical spelling."""
    found: list[str] = []
    for rx in TENDER_PATTERNS:
        for m in rx.finditer(text or ""):
            value = canonical_tender(m.group(1))
            if len(value) >= 4 and value not in found:
                found.append(value)
    return found


def sender_company(email: Email, own_domains: list[str]) -> tuple[str, str]:
    """(domain, display name) of the outside company behind a message, unwrapping internal forwards."""
    domain = (email.from_email.split("@")[-1] if "@" in email.from_email else "").lower()
    if domain in own_domains or not domain:
        m = re.search(r"From:\s*\"?([^<\n\"]*)\"?\s*<([^>\s]+@([^>\s]+))>", email.body_text or "")
        if m and m.group(3).lower() not in own_domains:
            return m.group(3).lower(), m.group(1).strip() or m.group(3)
    name = email.from_name or domain
    return domain, name


def _classify(session: Session, ws: Workspace, email: Email, categories: list[Category]) -> None:
    payload = {"id": email.id, "from_email": email.from_email, "from_name": email.from_name, "subject": email.subject,
               "body_text": (email.body_text or "")[:6000], "snippet": email.snippet, "to": email.to,
               "list_unsubscribe": email.list_unsubscribe, "direction": email.direction,
               "own_domains": ws.own_domains}
    cats = [c.model_dump() for c in categories]
    from ..learning import learned_category

    learned = learned_category(session, ws, email)
    if learned:
        from .changes import detect_intent

        email.intent = detect_intent(email.subject, email.body_text or "", learned["category"])
        email.category, email.category_confidence = learned["category"], learned["confidence"]
        email.category_reason, email.category_evidence = learned["reason"], learned["evidence"]
        email.category_source = "learned"
        return
    result: Optional[dict] = None
    try:
        from ..ai.rules import RuleClassifier

        result = RuleClassifier(cats).classify(payload)
        source = "rules"
    except Exception:
        result, source = None, "rules"
    work_keys = {c.key for c in categories if c.group == WORK_GROUP}
    needs_ai = result is None or result.get("confidence", 0) < 0.75 or result.get("category") in work_keys
    if needs_ai:
        choice = engine_for(session, ws, "classify_email")
        if choice is not None:
            from ..ai import tasks
            from .analysis import knowledge_context

            try:
                from ..learning import memory_context

                know = {**knowledge_context(session, ws), "lessons": memory_context(session, ws, task="classify_email")}
                result = tasks.classify_email(choice.engine, payload, cats, know)
                source = "ai"
            except Exception as exc:  # keep the rule result; the failure is visible in the reason
                if result is not None:
                    result["reason"] = f"{result.get('reason', '')} (AI failed: {exc})"[:500]
    if result:
        from .changes import detect_intent

        email.intent = result.get("intent") or detect_intent(email.subject, email.body_text or "",
                                                             result.get("category") or "", result.get("request_kind"))
        email.category = result.get("category") or "other"
        email.category_confidence = float(result.get("confidence") or 0)
        email.category_reason = result.get("reason") or ""
        email.category_evidence = result.get("evidence") or []
        email.priority = result.get("priority") or email.priority
        email.category_source = source


def _match_project(session: Session, ws: Workspace, email: Email, name: str, tenders: list[str]) -> Optional[Project]:
    projects = session.exec(select(Project).where(Project.workspace_id == ws.id, Project.archived_at == None)).all()  # noqa: E711
    # 1. same thread already linked
    linked = session.exec(select(Email).where(Email.thread_id == email.thread_id, Email.project_id != None)).first()  # noqa: E711
    if linked:
        return session.get(Project, linked.project_id)
    # 2. same tender number
    for p in projects:
        if p.tender_no and canonical_tender(p.tender_no) in tenders:
            return p
    # 3. similar name
    best, score = None, 0.0
    for p in projects:
        s = fuzz.token_set_ratio(name.lower(), p.name.lower())
        if s > score:
            best, score = p, s
    return best if score >= 88 else None


def link_email_to_project(session: Session, ws: Workspace, email: Email,
                          project: Optional[Project] = None) -> Optional[Project]:
    """Attach a message to a project and to its sender's enquiry. Without ``project`` the project is
    matched by tender number or name, or created; with ``project`` a person chose it."""
    text = f"{email.subject}\n{email.body_text or ''}"
    name = clean_subject(email.subject)
    tenders = tender_numbers(text)
    chosen = project is not None
    project = project or _match_project(session, ws, email, name, tenders)
    created = project is None
    if project is None:
        count = len(session.exec(select(Project.id).where(Project.workspace_id == ws.id)).all())
        project = Project(workspace_id=ws.id, ref=f"P-{email.thread_id}", code=f"P-{count + 1:04d}", name=name,
                          service_family=email.category, tender_no=tenders[0] if tenders else None, source="pipeline",
                          priority=email.priority)
        session.add(project)
        session.flush()
    domain, company = sender_company(email, ws.own_domains or [])
    customer = None
    if domain:
        customer = session.exec(select(Customer).where(Customer.workspace_id == ws.id, Customer.ref == domain)).first()
        if customer is None:
            customer = Customer(workspace_id=ws.id, ref=domain, name=company or domain, domain=domain,
                                first_seen=email.date)
            session.add(customer)
            session.flush()
        contact = session.exec(select(Contact).where(Contact.customer_id == customer.id,
                                                     Contact.email == email.from_email)).first()
        if contact is None and domain in email.from_email:
            session.add(Contact(workspace_id=ws.id, customer_id=customer.id, name=email.from_name,
                                email=email.from_email, last_seen=email.date))
        project.customer_id = project.customer_id or customer.id
        email.customer_id = customer.id
    enquiry = session.exec(select(Enquiry).where(Enquiry.project_id == project.id,
                                                 Enquiry.customer_id == (customer.id if customer else None))).first()
    if enquiry is None:
        enquiry = Enquiry(workspace_id=ws.id, project_id=project.id, customer_id=customer.id if customer else None,
                          ref=f"E-{project.code}-{(domain or 'direct').split('.')[0]}", received_at=email.date,
                          contact={"name": email.from_name, "email": email.from_email})
        session.add(enquiry)
        session.flush()
    if email.id not in (enquiry.email_ids or []):
        enquiry.email_ids = [*(enquiry.email_ids or []), email.id]
    if email.thread_id not in (enquiry.thread_ids or []):
        enquiry.thread_ids = [*(enquiry.thread_ids or []), email.thread_id]
    closing = find_closing_date(email.body_text or "")
    if closing and enquiry.due_date is None:
        enquiry.due_date = closing[0]
    sent_at = email.date.isoformat() if email.date else None
    for change in detect_changes(email.body_text or "", email_id=email.id, sent_at=sent_at, current_due=enquiry.due_date):
        if change["kind"] == "deadline_changed":
            # proposed only: the closing date (and its reminders) change when a person confirms it
            change["enquiry_id"] = enquiry.id
            change["pending_confirmation"] = True
        known = {(c.get("kind"), c.get("new_value"), (c.get("evidence") or {}).get("source_id")) for c in project.changes or []}
        if (change["kind"], change["new_value"], email.id) not in known:
            project.changes = [*(project.changes or []), change]
            from .state import reopen_for_revision

            reopen_for_revision(session, project, change)
    session.add(enquiry)
    email.project_id = project.id
    email.enquiry_id = enquiry.id
    email.state = "linked" if (chosen or not created) else "needs_review"
    for a in email.attachments or []:
        name_ = a.get("filename")
        if not name_ or session.exec(select(ProjectFile).where(ProjectFile.project_id == project.id,
                                                               ProjectFile.name == name_)).first():
            continue
        session.add(ProjectFile(workspace_id=ws.id, project_id=project.id, enquiry_id=enquiry.id, name=name_,
                                source="email_attachment", email_id=email.id, attachment_id=a.get("attachment_id"),
                                mime=a.get("mime") or "", size=a.get("size") or 0, status="not_downloaded"))
    register_links(session, ws, project, email)
    session.add(project)
    if created:
        log_activity(session, ws.id, "project_created", f"New project: {project.name}", project_id=project.id,
                     email_id=email.id, detail=f"from {email.from_name or email.from_email}")
    session.flush()
    refresh_project_state(session, project)
    return project


def _upsert(session: Session, ws: Workspace, msg: Any) -> tuple[Email, bool]:
    m = msg.model_dump() if hasattr(msg, "model_dump") else dict(msg)
    row = session.get(Email, m["id"])
    is_new = row is None
    row = row or Email(id=m["id"], workspace_id=ws.id, thread_id=m.get("thread_id") or m["id"])
    for key in ("thread_id", "account", "direction", "from_name", "subject", "snippet", "body_text", "labels",
                "list_unsubscribe", "list_unsubscribe_post", "view_url"):
        if m.get(key) is not None:
            setattr(row, key, m[key])
    row.from_email = (m.get("from_email") or "").lower()
    row.to = list(m.get("to") or [])
    row.cc = list(m.get("cc") or [])
    row.date = m.get("date")
    row.attachments = [a if isinstance(a, dict) else dict(a) for a in (m.get("attachments") or [])]
    if not row.links:
        try:
            from ..sources.links import extract_links

            row.links = extract_links(row.body_text or "", m.get("body_html"))
        except Exception:
            row.links = []
    row.updated_at = utcnow()
    session.add(row)
    return row, is_new


def build_queries(scope: dict, categories: list[Category]) -> list[str]:
    if scope.get("queries"):
        return list(scope["queries"])
    return [""]  # everything inside the date window


def run_scan(job_id: str) -> dict:
    with session_scope() as s:
        job = s.get(ScanJob, job_id)
        ws = s.get(Workspace, job.workspace_id)
        job.status, job.started_at = "running", utcnow()
        s.add(job)
        scope = dict(job.scope or {})
    log: list[str] = []
    counts = {"threads": 0, "messages": 0, "new_messages": 0, "new_inbound": 0, "work": 0, "projects": 0}
    try:
        with session_scope() as s:
            ws = s.get(Workspace, job.workspace_id)
            source = mail_source_for(s, ws)
            categories = list(s.exec(select(Category).where(Category.workspace_id == ws.id)).all())
            after = _d(scope.get("date_from")) or (datetime.now(timezone.utc) - timedelta(days=30 * int(scope.get("months", 2)))).date()
            before = _d(scope.get("date_to"))
            thread_ids: list[str] = []
            for q in build_queries(scope, categories):
                for tid in source.search(q, after=after, before=before, max_results=int(scope.get("max_threads", 2000))):
                    if tid not in thread_ids:
                        thread_ids.append(tid)
            log.append(f"{len(thread_ids)} threads in scope")
        total = max(len(thread_ids), 1)
        for i, tid in enumerate(thread_ids):
            with session_scope() as s:
                ws = s.get(Workspace, job.workspace_id)
                categories = list(s.exec(select(Category).where(Category.workspace_id == ws.id)).all())
                work_keys = {c.key for c in categories if c.group == WORK_GROUP}
                messages = source.get_thread(tid)
                counts["threads"] += 1
                for msg in messages:
                    email, is_new = _upsert(s, ws, msg)
                    counts["messages"] += 1
                    counts["new_messages"] += int(is_new)
                    if email.direction == "outbound":
                        email.category = email.category if email.category != "other" else "internal"
                        continue
                    counts["new_inbound"] += int(is_new)
                    if is_new or email.category_source == "rules":
                        _classify(s, ws, email, categories)
                    if email.category in work_keys and email.category != "other_work" or (
                            email.category == "other_work" and scope.get("projects_for_other_work", True)):
                        if email.project_id is None:
                            link_email_to_project(s, ws, email)
                        counts["work"] += 1
                answered = any(getattr(m, "direction", None) == "outbound" or (isinstance(m, dict) and m.get("direction") == "outbound")
                               for m in messages)
                if answered:
                    for e in s.exec(select(Email).where(Email.thread_id == tid)).all():
                        e.answered_by_us = True
                        s.add(e)
                job = s.get(ScanJob, job_id)
                job.progress = round((i + 1) / total, 3)
                job.counts = dict(counts)
                s.add(job)
        with session_scope() as s:
            ws = s.get(Workspace, job.workspace_id)
            counts["projects"] = len(s.exec(select(Project.id).where(Project.workspace_id == ws.id)).all())
            settings = dict(ws.settings or {})
            settings["last_sync"] = utcnow().isoformat()
            ws.settings = settings
            s.add(ws)
            job = s.get(ScanJob, job_id)
            job.status, job.finished_at, job.counts, job.log = "done", utcnow(), counts, log
            s.add(job)
            log_activity(s, ws.id, "scan", f"Mailbox scan finished: {counts['threads']} threads",
                         detail=f"{counts['work']} work messages, {counts['projects']} projects", severity="success")
        _auto_fetch(job_id)
        from ..automations.runner import on_new_mail

        on_new_mail(job.workspace_id, counts["new_inbound"])  # "new mail" workflows (background service only)
        return counts
    except Exception as exc:
        with session_scope() as s:
            job = s.get(ScanJob, job_id)
            job.status, job.error, job.finished_at, job.log = "failed", str(exc)[:2000], utcnow(), log
            job.counts = counts
            s.add(job)
        raise


def _auto_fetch(job_id: str) -> None:
    """After a scan: download approved links and attachments for open projects (background)."""
    from .. import jobs
    from ..models import ProjectLink
    from .files import download_link_job

    with session_scope() as s:
        job = s.get(ScanJob, job_id)
        links = s.exec(select(ProjectLink).where(ProjectLink.workspace_id == job.workspace_id,
                                                 ProjectLink.status == "approved")).all()
        link_ids = [l.id for l in links]
        project_ids = [p.id for p in s.exec(select(Project).where(Project.workspace_id == job.workspace_id,
                                                                  Project.archived_at == None)).all()]  # noqa: E711
    for lid in link_ids:
        jobs.submit(f"link:{lid}", download_link_job, lid)
    for pid in project_ids:
        jobs.submit(f"attachments:{pid}", _safe_fetch, pid)


def _safe_fetch(project_id: str) -> None:
    from .files import fetch_attachments

    try:
        fetch_attachments(project_id)
    except Exception:
        pass


def _d(value: Any) -> Optional[date]:
    if not value:
        return None
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])
