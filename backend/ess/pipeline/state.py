"""Derived project state: stage, blockers, next action, attention bucket.

The pipeline and the API both call `refresh_project_state` after anything changes, so the
control center always shows one honest "what to do next" per project.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from sqlmodel import Session, select

from ..models import Enquiry, Project, ProjectFile, ProjectLink, Quotation, Review, utcnow

STAGES = ["received", "files_ready", "analysis", "engineer_review", "quotation", "approved", "sent", "archived"]

STAGE_LABELS = {
    "received": "Received",
    "files_ready": "Files ready",
    "analysis": "Analysis",
    "engineer_review": "Engineer review",
    "quotation": "Quotation",
    "approved": "Approved",
    "sent": "Sent",
    "archived": "Archived",
}

_LINK_BLOCKING = {"failed": "Download failed", "expired": "Link expired", "needs_login": "Link needs a login",
                  "blocked": "Host blocked", "pending_approval": "Download waits for approval"}


def _as_date(value: Any) -> Optional[date]:
    if value is None or isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def compute_blockers(project: Project, files: Iterable[ProjectFile], links: Iterable[ProjectLink]) -> list[dict]:
    blockers: list[dict] = []
    files = list(files)
    links = list(links)
    # Keep blockers recorded by people / scanners that are not derived here.
    for b in project.blockers or []:
        if b.get("source") != "derived" and not b.get("resolved"):
            blockers.append(b)
    for link in links:
        if link.status in _LINK_BLOCKING:
            blockers.append({
                "kind": "expired_link" if link.status == "expired" else "missing_files",
                "text": f"{_LINK_BLOCKING[link.status]}: {link.host or link.url}",
                "link_id": link.id,
                "source": "derived",
            })
    ready = [f for f in files if f.status == "ready"]
    if not ready and not any(l.status in ("found", "approved", "downloading") for l in links):
        if not any(b.get("kind") in ("missing_files", "expired_link") for b in blockers):
            blockers.append({"kind": "missing_files", "text": "No project documents available yet", "source": "derived"})
    if ready and not any(f.doc_kind == "drawing" for f in ready) and project.service_family in ("bmu", "wce", "cradle"):
        blockers.append({"kind": "missing_drawing", "text": "No drawing among the received files", "source": "derived"})
    return blockers


def open_changes(project: Project) -> list[dict]:
    return [c for c in (project.changes or []) if not c.get("acknowledged")]


def compute_stage(project: Project, files: list[ProjectFile], quotations: list[Quotation], review: Optional[Review],
                  enquiries: Iterable[Enquiry] = ()) -> str:
    if project.archived_at:
        return "archived"
    statuses = {q.status for q in quotations}
    if "sent" in statuses:
        return "sent"
    enquiries = list(enquiries)
    answered = [e for e in enquiries if e.status in ("quoted", "won", "lost") or (e.our_response or {}).get("status") == "quoted"]
    if enquiries and len(answered) == len(enquiries):
        return "sent"  # every contractor already has our offer (sent from the app or by mail)
    if "approved" in statuses:
        return "approved"
    if review and review.decision == "approved":
        return "quotation"
    if statuses & {"needs_review", "changes_requested"}:
        return "engineer_review"
    analysis = (project.analysis or {}).get("status")
    if analysis == "running":
        return "analysis"
    if analysis == "done" or (review and review.decision is None and review.checklist):
        return "engineer_review"
    if any(f.status == "ready" for f in files):
        return "files_ready"
    return "received"


EXPLICIT_SOURCES = ("scan", "user", "ai", "mcp")


def compute_next_action(project: Project, stage: str, blockers: list[dict], quotations: list[Quotation]) -> dict:
    changes = open_changes(project)
    explicit = project.next_action if (project.next_action or {}).get("source") in EXPLICIT_SOURCES else None
    if explicit and stage not in ("approved", "sent", "archived"):
        # A person, the scanner or the AI wrote a specific next step; keep it until newer mail changes things.
        set_at = str(explicit.get("set_at") or "")
        if not any(str(c.get("date") or "") > set_at for c in changes):
            return explicit
    if changes:
        latest = changes[-1]
        kind = latest.get("kind")
        label = {
            "deadline_changed": "Review deadline change",
            "addendum": "Review addendum",
            "technical_revision": "Review revision",
            "scope_change": "Review scope change",
            "reminder": "Answer reminder",
        }.get(kind, "Review change")
        return {"kind": "review_change", "label": label, "change_index": (project.changes or []).index(latest)}
    for b in blockers:
        if b.get("link_id"):
            return {"kind": "resolve_link", "label": "Fix file download", "link_id": b["link_id"]}
    by_stage = {
        "received": {"kind": "collect_files", "label": "Collect project files"},
        "files_ready": {"kind": "analyze", "label": "Study documents"},
        "analysis": {"kind": "wait", "label": "Analysis running"},
        "engineer_review": {"kind": "engineer_review", "label": "Open engineer review"},
        "quotation": {"kind": "prepare_quotation", "label": "Enter prices and finish quotation"},
        "approved": {"kind": "send", "label": "Send approved quotation"},
        "sent": {"kind": "follow_up", "label": "Follow up with customer"},
        "archived": {"kind": "none", "label": "Archived"},
    }
    if stage == "received" and not quotations and not blockers:
        return {"kind": "analyze", "label": "Review scope"}
    return by_stage.get(stage, {"kind": "none", "label": ""})


def attention_bucket(project: Project, stage: str, blockers: list[dict], today: Optional[date] = None) -> str:
    """needs_attention | in_progress | completed — the three Control Center tabs."""
    if stage in ("sent", "archived"):
        return "completed"
    today = today or datetime.now(timezone.utc).date()
    due = _as_date(project.due_date)
    if open_changes(project) or blockers or stage in ("engineer_review", "approved"):
        return "needs_attention"
    if due and due <= today + timedelta(days=7):
        return "needs_attention"
    return "in_progress"


def refresh_project_state(session: Session, project: Project) -> Project:
    files = session.exec(select(ProjectFile).where(ProjectFile.project_id == project.id)).all()
    links = session.exec(select(ProjectLink).where(ProjectLink.project_id == project.id)).all()
    quotations = session.exec(
        select(Quotation).where(Quotation.project_id == project.id, Quotation.status != "superseded")
    ).all()
    review = session.exec(
        select(Review).where(Review.project_id == project.id).order_by(Review.created_at.desc())
    ).first()
    enquiries = session.exec(select(Enquiry).where(Enquiry.project_id == project.id)).all()

    blockers = compute_blockers(project, files, links)
    stage = compute_stage(project, list(files), list(quotations), review, enquiries)
    project.blockers = blockers
    project.stage = stage
    project.next_action = compute_next_action(project, stage, blockers, list(quotations))
    open_dues = [e.due_date for e in enquiries if e.due_date and e.status == "open"]
    if open_dues:
        project.due_date = min(open_dues)
    if review:
        project.review_status = {"approved": "approved", "changes_requested": "changes_requested"}.get(
            review.decision or "", "in_review")
    project.updated_at = utcnow()
    session.add(project)
    return project
