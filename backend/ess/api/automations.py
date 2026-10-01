"""Automations (workflows), their runs, approvals of paused steps, and mailbox scan jobs."""
from __future__ import annotations

from datetime import date
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, col, select

from .. import jobs
from ..automations.runner import STEPS, resume_run, start_run
from ..db import get_session
from ..models import Approval, Automation, AutomationRun, ScanJob, TeamMember, Workspace, utcnow
from ..pipeline.connect import active_connection
from ..pipeline.scan import run_scan
from .deps import get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["automations"])


@router.get("/automations")
def list_automations(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[dict]:
    rows = session.exec(select(Automation).where(Automation.workspace_id == ws.id).order_by(Automation.created_at)).all()
    out = []
    for a in rows:
        last = session.exec(select(AutomationRun).where(AutomationRun.automation_id == a.id)
                            .order_by(col(AutomationRun.started_at).desc())).first()
        out.append({**a.model_dump(), "last_run": last})
    return out


@router.get("/automations/step-types")
def step_types() -> list[str]:
    return sorted(STEPS)


@router.get("/automations/{auto_id}")
def get_automation(auto_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    a = get_or_404(session, Automation, auto_id, ws)
    runs = session.exec(select(AutomationRun).where(AutomationRun.automation_id == a.id)
                        .order_by(col(AutomationRun.started_at).desc()).limit(30)).all()
    return {"automation": a, "runs": runs}


@router.patch("/automations/{auto_id}")
def edit_automation(auto_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                    ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Automation:
    require_role(user, "admin", "Editing automations")
    a = get_or_404(session, Automation, auto_id, ws)
    if "enabled" in data:
        a.enabled = bool(data["enabled"])
    if "interval_minutes" in data:
        a.interval_minutes = max(int(data["interval_minutes"]), 15) if data["interval_minutes"] else None
    if isinstance(data.get("steps"), list):
        steps = []
        for st in data["steps"]:
            if st.get("type") not in STEPS:
                raise HTTPException(400, {"code": "bad_step", "message": f"Unknown step type {st.get('type')}"})
            # sending is never automatic: the review gate cannot be switched off
            if st.get("type") == "request_review":
                st = {**st, "requires_approval": True, "enabled": True}
            steps.append(st)
        a.steps = steps
    for k in ("name", "description"):
        if k in data:
            setattr(a, k, data[k])
    a.updated_at = utcnow()
    session.add(a)
    session.commit()
    return a


@router.post("/automations/{auto_id}/run")
def run_now(auto_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
            ws: Workspace = Depends(ws_dep)) -> dict:
    a = get_or_404(session, Automation, auto_id, ws)
    run_id = start_run(a.id, trigger="manual", target_type=data.get("target_type"), target_id=data.get("target_id"))
    return {"run_id": run_id}


@router.get("/runs/{run_id}")
def get_run(run_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    run = get_or_404(session, AutomationRun, run_id, ws)
    return {"run": run, "automation": session.get(Automation, run.automation_id)}


@router.post("/runs/{run_id}/continue")
def continue_run(run_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                 user: TeamMember = Depends(user_dep)) -> dict:
    run = get_or_404(session, AutomationRun, run_id, ws)
    if run.status != "waiting_approval":
        raise HTTPException(409, {"code": "not_waiting", "message": f"Run is {run.status}"})
    session.add(Approval(workspace_id=ws.id, action="continue_run", target_type="run", target_id=run.id,
                         decided_by=user.name, decision="approved"))
    session.commit()
    resume_run(run.id, user.name)
    return {"resumed": True}


# --------------------------------------------------------------------------- scans


@router.post("/scan")
def start_scan(data: dict = Body(default={}), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
               user: TeamMember = Depends(user_dep)) -> ScanJob:
    if active_connection(session, ws, "mail") is None:
        raise HTTPException(409, {"code": "no_mailbox", "message": "Connect a mailbox first (Settings → Connections)."})
    scope = {**(ws.settings or {}).get("scan_scope", {}), **{k: v for k, v in data.items()
                                                             if k in ("date_from", "date_to", "months", "queries",
                                                                      "max_threads", "include_sent")}}
    for key in ("date_from", "date_to"):
        if scope.get(key):
            date.fromisoformat(str(scope[key])[:10])  # validate
    job = ScanJob(workspace_id=ws.id, scope=scope)
    session.add(job)
    session.commit()
    jobs.submit(f"scan:{ws.id}", run_scan, job.id)
    return job


@router.get("/scan/jobs")
def scan_jobs(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[ScanJob]:
    return list(session.exec(select(ScanJob).where(ScanJob.workspace_id == ws.id)
                             .order_by(col(ScanJob.created_at).desc()).limit(20)).all())


@router.get("/scan/{job_id}")
def scan_job(job_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> ScanJob:
    return get_or_404(session, ScanJob, job_id, ws)
