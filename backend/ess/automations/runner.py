"""Automation runner: executes workflow steps in order, records every step, pauses at human gates.

Steps are small adapters over the pipeline. A step marked `requires_approval` stops the run in
`waiting_approval`; a person resumes it from the app.
"""
from __future__ import annotations

import asyncio
import logging
import traceback
from datetime import datetime, timedelta
from typing import Callable, Optional

from sqlmodel import select

from .. import jobs
from ..db import session_scope
from ..models import Automation, AutomationRun, Customer, Email, Project, ProjectLink, ScanJob, Workspace, utcnow
from ..workspace import log_activity

log = logging.getLogger("ess.automations")


class StepContext:
    def __init__(self, run_id: str, workspace_id: str, target_type: Optional[str], target_id: Optional[str]):
        self.run_id = run_id
        self.workspace_id = workspace_id
        self.target_type = target_type
        self.target_id = target_id
        self.project_ids: list[str] = [target_id] if target_type == "project" and target_id else []


def _projects_in_scope(ctx: StepContext) -> list[str]:
    if ctx.project_ids:
        return ctx.project_ids
    with session_scope() as s:
        since = utcnow() - timedelta(days=2)
        rows = s.exec(select(Project).where(Project.workspace_id == ctx.workspace_id, Project.archived_at == None,  # noqa: E711
                                            Project.updated_at >= since)).all()
        return [p.id for p in rows]


def step_sync_mail(ctx: StepContext, cfg: dict) -> str:
    from ..pipeline.scan import run_scan

    with session_scope() as s:
        ws = s.get(Workspace, ctx.workspace_id)
        last = (ws.settings or {}).get("last_sync")
        job = ScanJob(workspace_id=ws.id, scope={"date_from": (last or "")[:10] or None, "months": 1,
                                                 "max_threads": cfg.get("max_threads", 300)})
        s.add(job)
        job_id = job.id
    counts = run_scan(job_id)
    return f"{counts.get('threads', 0)} threads, {counts.get('work', 0)} work messages"


def step_classify(ctx: StepContext, cfg: dict) -> str:
    from ..models import Category
    from ..pipeline.scan import _classify

    n = 0
    with session_scope() as s:
        ws = s.get(Workspace, ctx.workspace_id)
        cats = list(s.exec(select(Category).where(Category.workspace_id == ws.id)).all())
        q = select(Email).where(Email.workspace_id == ws.id, Email.category_source == "rules", Email.state == "new")
        if ctx.target_type == "email":
            q = select(Email).where(Email.id == ctx.target_id)
        for e in s.exec(q.limit(cfg.get("limit", 500))).all():
            _classify(s, ws, e, cats)
            s.add(e)
            n += 1
    return f"{n} message(s) classified"


def step_link_project(ctx: StepContext, cfg: dict) -> str:
    from ..models import Category
    from ..pipeline.scan import link_email_to_project

    n = 0
    with session_scope() as s:
        ws = s.get(Workspace, ctx.workspace_id)
        work = {c.key for c in s.exec(select(Category).where(Category.workspace_id == ws.id, Category.group == "work")).all()}
        q = select(Email).where(Email.workspace_id == ws.id, Email.project_id == None, Email.direction == "inbound")  # noqa: E711
        if ctx.target_type == "email":
            q = select(Email).where(Email.id == ctx.target_id)
        for e in s.exec(q).all():
            if e.category in work:
                p = link_email_to_project(s, ws, e)
                if p and p.id not in ctx.project_ids:
                    ctx.project_ids.append(p.id)
                n += 1
    return f"{n} message(s) linked to projects"


def step_fetch_attachments(ctx: StepContext, cfg: dict) -> str:
    from ..pipeline.files import fetch_attachments

    saved = 0
    errors = []
    for pid in _projects_in_scope(ctx):
        try:
            saved += fetch_attachments(pid).get("saved", 0)
        except Exception as exc:
            errors.append(str(exc)[:120])
    return f"{saved} attachment(s) saved" + (f"; {len(errors)} error(s): {errors[0]}" if errors else "")


def step_fetch_links(ctx: StepContext, cfg: dict) -> str:
    from ..pipeline.files import download_link_job

    results = []
    with session_scope() as s:
        links = s.exec(select(ProjectLink).where(ProjectLink.workspace_id == ctx.workspace_id,
                                                 ProjectLink.status == "approved")).all()
        ids = [l.id for l in links if not ctx.project_ids or l.project_id in ctx.project_ids]
        waiting = s.exec(select(ProjectLink).where(ProjectLink.workspace_id == ctx.workspace_id,
                                                   ProjectLink.status == "pending_approval")).all()
    for lid in ids:
        results.append(asyncio.run(download_link_job(lid)))
    ok = sum(1 for r in results if r.get("status") == "ok")
    return f"{ok}/{len(ids)} link(s) downloaded; {len(waiting)} waiting for approval"


def step_extract_files(ctx: StepContext, cfg: dict) -> str:
    from ..pipeline.files import extract_project_files

    total = sum(extract_project_files(pid).get("extracted", 0) for pid in _projects_in_scope(ctx))
    return f"{total} document(s) read"


def step_analyze(ctx: StepContext, cfg: dict) -> str:
    from ..pipeline.analysis import analyze_project

    done = [analyze_project(pid, actor="automation") for pid in _projects_in_scope(ctx)]
    return f"{len(done)} project(s) analysed"


def step_draft(ctx: StepContext, cfg: dict) -> str:
    from ..models import Quotation
    from ..pipeline.drafting import create_quotation

    n = 0
    with session_scope() as s:
        ws = s.get(Workspace, ctx.workspace_id)
        for pid in _projects_in_scope(ctx):
            p = s.get(Project, pid)
            if p is None or s.exec(select(Quotation).where(Quotation.project_id == pid)).first():
                continue
            create_quotation(s, ws, p, actor="automation")
            n += 1
    return f"{n} draft quotation(s) created (prices left for the engineer)"


def step_detect_changes(ctx: StepContext, cfg: dict) -> str:
    with session_scope() as s:
        since = utcnow() - timedelta(days=1)
        rows = s.exec(select(Project).where(Project.workspace_id == ctx.workspace_id, Project.updated_at >= since)).all()
        open_changes = sum(1 for p in rows for c in p.changes or [] if not c.get("acknowledged"))
    return f"{open_changes} unreviewed change(s) on recently updated projects"


def step_notify(ctx: StepContext, cfg: dict) -> str:
    with session_scope() as s:
        rows = s.exec(select(Project).where(Project.workspace_id == ctx.workspace_id)).all()
        flagged = [p for p in rows if any(not c.get("acknowledged") for c in p.changes or [])]
        for p in flagged[:20]:
            log_activity(s, ctx.workspace_id, "change_alert", f"{p.name}: {p.next_action.get('label', 'Review change')}",
                         project_id=p.id, severity="warning")
    return f"{len(flagged)} project(s) flagged"


def step_monitor_customers(ctx: StepContext, cfg: dict) -> str:
    from ..api.customers import check_customer_updates

    with session_scope() as s:
        ids = [c.id for c in s.exec(select(Customer).where(Customer.workspace_id == ctx.workspace_id,
                                                           Customer.monitoring == True)).all()]  # noqa: E712
    found = 0
    for cid in ids:
        try:
            found += check_customer_updates(cid)
        except Exception:
            continue
    return f"{found} update(s) for {len(ids)} monitored customer(s)"


def step_suggest_unsubscribe(ctx: StepContext, cfg: dict) -> str:
    with session_scope() as s:
        promo = s.exec(select(Email).where(Email.workspace_id == ctx.workspace_id, Email.category == "promotions",
                                           Email.unsubscribed_at == None)).all()  # noqa: E711
        senders = {e.from_email for e in promo if e.list_unsubscribe}
    return f"{len(senders)} sender(s) can be unsubscribed — waiting for a person to choose"


def step_request_review(ctx: StepContext, cfg: dict) -> str:
    return "Engineer review requested — the quotation stays locked until a person approves it"


STEPS: dict[str, Callable[[StepContext, dict], str]] = {
    "sync_mail": step_sync_mail, "classify": step_classify, "link_project": step_link_project,
    "fetch_attachments": step_fetch_attachments, "fetch_links": step_fetch_links, "extract_files": step_extract_files,
    "analyze_project": step_analyze, "draft_quotation": step_draft, "detect_changes": step_detect_changes,
    "notify": step_notify, "monitor_customers": step_monitor_customers, "suggest_unsubscribe": step_suggest_unsubscribe,
    "request_review": step_request_review,
}


# What a person sees when building a workflow. "locked" steps keep their human gate.
STEP_CATALOG: list[dict] = [
    {"type": "sync_mail", "label": "Read new mail", "description": "Fetch messages that arrived since the last check.",
     "config": [{"key": "max_threads", "label": "Most threads per run", "type": "number", "default": 300}]},
    {"type": "classify", "label": "Classify mail", "description": "Sort new messages into work, bills, promotions and other.",
     "config": [{"key": "limit", "label": "Most messages per run", "type": "number", "default": 500}]},
    {"type": "link_project", "label": "Link to project and enquiry",
     "description": "File work mail under its project and the sender's enquiry (or open a new project)."},
    {"type": "fetch_attachments", "label": "Save attachments", "description": "Download e-mail attachments of the projects in this run."},
    {"type": "fetch_links", "label": "Download shared links",
     "description": "Download approved Google Drive, WeTransfer, Dropbox and OneDrive links. Unknown hosts wait for approval."},
    {"type": "extract_files", "label": "Read documents and drawings", "description": "Extract text, BOQ rows and drawing pages."},
    {"type": "analyze_project", "label": "Analyse scope", "description": "Find requirements, scope items and open questions with evidence."},
    {"type": "draft_quotation", "label": "Draft quotation (no prices)",
     "description": "Prepare the quotation draft. Prices stay empty for the engineer."},
    {"type": "detect_changes", "label": "Detect changes", "description": "Find closing-date changes, addenda, reminders and revisions."},
    {"type": "notify", "label": "Notify owners", "description": "Add a notification for projects with unreviewed changes."},
    {"type": "monitor_customers", "label": "Search customer updates", "description": "Look for news, projects and tenders of monitored customers."},
    {"type": "suggest_unsubscribe", "label": "Suggest unsubscribes",
     "description": "List senders that can be unsubscribed. A person chooses; nothing is sent automatically."},
    {"type": "request_review", "label": "Engineer review", "locked": True,
     "description": "Stop here until an engineer continues the run. This gate cannot be switched off."},
]

SCHEDULER_STATE: dict = {"running": False, "started_at": None}
DEFAULT_MAIL_POLL_MINUTES = 15


def mail_poll_minutes(ws: Workspace) -> int:
    try:
        return max(5, int((ws.settings or {}).get("mail_poll_minutes") or DEFAULT_MAIL_POLL_MINUTES))
    except (TypeError, ValueError):
        return DEFAULT_MAIL_POLL_MINUTES


def _every(minutes: int) -> str:
    if minutes % (7 * 24 * 60) == 0:
        n = minutes // (7 * 24 * 60)
        return "Every week" if n == 1 else f"Every {n} weeks"
    if minutes % (24 * 60) == 0:
        n = minutes // (24 * 60)
        return "Every day" if n == 1 else f"Every {n} days"
    if minutes % 60 == 0:
        n = minutes // 60
        return "Every hour" if n == 1 else f"Every {n} hours"
    return f"Every {minutes} minutes"


def needs_mail(auto: Automation) -> bool:
    """Workflows that start from mail, or read mail, need a connected mailbox to run on their own."""
    return auto.trigger == "new_email" or any(st.get("type") == "sync_mail" and st.get("enabled", True)
                                              for st in auto.steps or [])


def trigger_status(session, ws: Workspace, auto: Automation) -> dict:
    """How this workflow really starts on this installation right now (never more than the truth)."""
    from ..pipeline.connect import active_connection

    manual = {"mode": "manual", "automatic": False, "label": "Manual — Run now"}
    if not auto.enabled:
        return {"mode": "off", "automatic": False, "label": "Switched off",
                "detail": "It does not run on its own. Run now still works."}
    if auto.trigger == "manual" or (auto.trigger == "schedule" and not auto.interval_minutes):
        return {**manual, "detail": "Runs only when someone presses Run now."}
    if not SCHEDULER_STATE["running"]:
        return {**manual, "detail": "Background runs are off: the server was started without the scheduler."}
    if not (ws.settings or {}).get("automations_enabled", True):
        return {"mode": "paused", "automatic": False, "label": "Paused",
                "detail": "Automations are paused for this workspace."}
    if needs_mail(auto) and active_connection(session, ws, "mail") is None:
        return {**manual, "detail": "Connect a mailbox so it can run on its own."}
    if auto.trigger == "new_email":
        return {"mode": "automatic", "automatic": True, "label": "When new mail arrives",
                "detail": f"The mailbox is checked every {mail_poll_minutes(ws)} minutes."}
    nxt = (_aware(auto.last_run_at) + timedelta(minutes=auto.interval_minutes)) if auto.last_run_at else utcnow()
    return {"mode": "automatic", "automatic": True, "label": _every(int(auto.interval_minutes)),
            "detail": "Runs on its own.", "next_run_at": max(nxt, utcnow()).isoformat()}


def on_new_mail(workspace_id: str, new_inbound: int) -> list[str]:
    """After a mailbox check that stored new inbound mail, start the workspace's "new mail" workflows."""
    if new_inbound <= 0 or not SCHEDULER_STATE["running"]:
        return []
    with session_scope() as s:
        ws = s.get(Workspace, workspace_id)
        if ws is None or not (ws.settings or {}).get("automations_enabled", True):
            return []
        autos = s.exec(select(Automation).where(Automation.workspace_id == ws.id, Automation.enabled == True,  # noqa: E712
                                                Automation.trigger == "new_email")).all()
        due = []
        for a in autos:
            busy = s.exec(select(AutomationRun).where(AutomationRun.automation_id == a.id,
                                                      AutomationRun.status == "running")).first()
            if busy is None:
                due.append(a.id)
    return [start_run(aid, trigger="new_email") for aid in due]


def start_run(automation_id: str, *, trigger: str = "manual", target_type: Optional[str] = None,
              target_id: Optional[str] = None) -> str:
    with session_scope() as s:
        auto = s.get(Automation, automation_id)
        run = AutomationRun(workspace_id=auto.workspace_id, automation_id=auto.id, trigger=trigger,
                            target_type=target_type, target_id=target_id,
                            steps=[{"key": st["key"], "label": st.get("label", st["key"]), "type": st.get("type"),
                                    "status": "pending" if st.get("enabled", True) else "skipped",
                                    "requires_approval": bool(st.get("requires_approval"))} for st in auto.steps])
        s.add(run)
        auto.last_run_at = utcnow()
        auto.runs_count += 1
        s.add(auto)
        run_id = run.id
    jobs.submit(f"run:{run_id}", execute_run, run_id)
    return run_id


def execute_run(run_id: str, *, resume_from: Optional[int] = None) -> str:
    with session_scope() as s:
        run = s.get(AutomationRun, run_id)
        ctx = StepContext(run.id, run.workspace_id, run.target_type, run.target_id)
        steps = list(run.steps)
        auto = s.get(Automation, run.automation_id)
        configs = {st["key"]: st.get("config") or {} for st in auto.steps}
        run.status = "running"
        s.add(run)
    start = resume_from or 0
    for i, step in enumerate(steps):
        if i < start or step["status"] in ("done", "skipped"):
            continue
        if step.get("requires_approval") and resume_from is None:
            steps[i] = {**step, "status": "waiting_approval", "message": "Waiting for a person to continue"}
            _save(run_id, steps, "waiting_approval")
            return "waiting_approval"
        fn = STEPS.get(step.get("type") or "")
        steps[i] = {**step, "status": "running", "started_at": utcnow().isoformat()}
        _save(run_id, steps, "running")
        try:
            message = fn(ctx, configs.get(step["key"], {})) if fn else f"Unknown step type {step.get('type')}"
            steps[i] = {**steps[i], "status": "done", "message": message, "finished_at": utcnow().isoformat()}
        except Exception as exc:
            log.error("step %s failed: %s", step["key"], traceback.format_exc())
            steps[i] = {**steps[i], "status": "failed", "message": str(exc)[:500], "finished_at": utcnow().isoformat()}
            _save(run_id, steps, "failed", error=str(exc)[:1000])
            return "failed"
        _save(run_id, steps, "running")
        resume_from = None
    _save(run_id, steps, "succeeded")
    return "succeeded"


def _save(run_id: str, steps: list[dict], status: str, error: Optional[str] = None) -> None:
    with session_scope() as s:
        run = s.get(AutomationRun, run_id)
        run.steps = steps
        run.status = status
        run.error = error
        if status in ("succeeded", "failed", "waiting_approval"):
            run.finished_at = utcnow()
            run.summary = "; ".join(st.get("message", "") for st in steps if st.get("message"))[:2000]
        s.add(run)


def resume_run(run_id: str, approved_by: str) -> None:
    with session_scope() as s:
        run = s.get(AutomationRun, run_id)
        steps = list(run.steps)
        idx = next((i for i, st in enumerate(steps) if st["status"] == "waiting_approval"), None)
        if idx is None:
            return
        steps[idx] = {**steps[idx], "status": "pending", "approved_by": approved_by}
        run.steps = steps
        s.add(run)
    jobs.submit(f"run:{run_id}", execute_run, run_id, resume_from=idx)


def _poll_mailboxes() -> None:
    """Check the mailbox of every workspace with an active "new mail" workflow (every few minutes)."""
    from ..models import AppState
    from ..pipeline.connect import active_connection
    from ..pipeline.scan import run_scan

    with session_scope() as s:
        targets = []
        for ws in s.exec(select(Workspace)).all():
            if not (ws.settings or {}).get("automations_enabled", True):
                continue
            wants = s.exec(select(Automation).where(Automation.workspace_id == ws.id, Automation.enabled == True,  # noqa: E712
                                                    Automation.trigger == "new_email")).first()
            if wants is None or active_connection(s, ws, "mail") is None:
                continue
            state = s.get(AppState, f"mailpoll:{ws.id}")
            last = state.value if state and state.value else None
            if last and (utcnow() - _aware(datetime.fromisoformat(last))).total_seconds() < mail_poll_minutes(ws) * 60:
                continue
            last_sync = (ws.settings or {}).get("last_sync")
            job = ScanJob(workspace_id=ws.id, scope={"date_from": (last_sync or "")[:10] or None, "months": 1,
                                                     "max_threads": 300, "trigger": "mail_poll"})
            s.add(job)
            row = state or AppState(key=f"mailpoll:{ws.id}")
            row.value = utcnow().isoformat()
            s.add(row)
            targets.append((ws.id, job.id))
    for ws_id, job_id in targets:
        jobs.submit(f"scan:{ws_id}", run_scan, job_id)


async def scheduler_loop(stop: asyncio.Event) -> None:
    """Every minute: start due scheduled automations, and check mailboxes for "new mail" workflows."""
    SCHEDULER_STATE.update(running=True, started_at=utcnow().isoformat())
    try:
        await _scheduler_ticks(stop)
    finally:
        SCHEDULER_STATE["running"] = False


async def _scheduler_ticks(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            _poll_mailboxes()
        except Exception:
            log.error("mailbox poll failed: %s", traceback.format_exc())
        try:
            with session_scope() as s:
                autos = s.exec(select(Automation).where(Automation.enabled == True, Automation.trigger == "schedule")).all()  # noqa: E712
                due = [a.id for a in autos if a.interval_minutes and (
                    a.last_run_at is None or (utcnow() - _aware(a.last_run_at)).total_seconds() >= a.interval_minutes * 60)]
                from ..pipeline.connect import active_connection

                runnable = []
                for aid in due:
                    a = s.get(Automation, aid)
                    ws = s.get(Workspace, a.workspace_id)
                    if (ws.settings or {}).get("automations_enabled", True) and (
                            not needs_mail(a) or active_connection(s, ws, "mail") is not None):
                        runnable.append(aid)
            for aid in runnable:
                start_run(aid, trigger="schedule")
        except Exception:
            log.error("scheduler tick failed: %s", traceback.format_exc())
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
        except asyncio.TimeoutError:
            pass


def _aware(dt):
    from datetime import timezone

    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
