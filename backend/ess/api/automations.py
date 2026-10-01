"""Automations (workflows), their runs, approvals of paused steps, and mailbox scan jobs."""
from __future__ import annotations

from datetime import date
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, col, select

from .. import jobs
from ..automations.runner import STEP_CATALOG, STEPS, resume_run, start_run, trigger_status
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
        out.append({**a.model_dump(), "last_run": last, "trigger_status": trigger_status(session, ws, a),
                    "built_in": a.key in BUILT_IN_KEYS})
    return out


BUILT_IN_KEYS = {"enquiry_intake", "change_watch", "customer_watch", "inbox_hygiene"}
TRIGGERS = ("manual", "schedule", "new_email")


@router.get("/automations/step-types")
def step_types() -> list[str]:
    return sorted(STEPS)


@router.get("/automations/step-catalog")
def step_catalog() -> list[dict]:
    """Step types with plain labels, descriptions and settings, for the workflow editor."""
    return STEP_CATALOG


def _clean_steps(raw: list) -> list[dict]:
    steps, keys = [], set()
    for i, st in enumerate(raw):
        if not isinstance(st, dict) or st.get("type") not in STEPS:
            raise HTTPException(400, {"code": "bad_step", "message": f"Unknown step type {st.get('type') if isinstance(st, dict) else st}"})
        key = str(st.get("key") or f"{st['type']}_{i + 1}")
        while key in keys:
            key = f"{key}_{i + 1}"
        keys.add(key)
        label = (st.get("label") or next((c["label"] for c in STEP_CATALOG if c["type"] == st["type"]), st["type"])).strip()
        clean = {"key": key, "label": label, "type": st["type"], "enabled": bool(st.get("enabled", True)),
                 "requires_approval": bool(st.get("requires_approval", False)),
                 "config": st.get("config") if isinstance(st.get("config"), dict) else {}}
        # the engineer-review gate cannot be switched off or skipped
        if clean["type"] == "request_review":
            clean.update(requires_approval=True, enabled=True)
        steps.append(clean)
    return steps


def _apply_trigger(a: Automation, data: dict) -> None:
    if "trigger" in data:
        if data["trigger"] not in TRIGGERS:
            raise HTTPException(400, {"code": "bad_trigger", "message": "Trigger must be manual, schedule or new_email"})
        a.trigger = data["trigger"]
    if "interval_minutes" in data:
        a.interval_minutes = max(int(data["interval_minutes"]), 15) if data["interval_minutes"] else None
    if a.trigger == "schedule" and not a.interval_minutes:
        a.interval_minutes = 60


@router.post("/automations")
def create_automation(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                      user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Creating automations")
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(400, {"code": "name_required", "message": "Give the workflow a name."})
    steps = _clean_steps(data.get("steps") or [])
    if not steps:
        raise HTTPException(400, {"code": "steps_required", "message": "Add at least one step."})
    count = len(session.exec(select(Automation.id).where(Automation.workspace_id == ws.id)).all())
    a = Automation(workspace_id=ws.id, key=f"custom_{count + 1}", name=name, description=data.get("description") or "",
                   trigger="manual", steps=steps, enabled=bool(data.get("enabled", True)))
    _apply_trigger(a, data)
    session.add(a)
    session.commit()
    return {**a.model_dump(), "last_run": None, "trigger_status": trigger_status(session, ws, a), "built_in": False}


@router.delete("/automations/{auto_id}")
def delete_automation(auto_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                      user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Deleting automations")
    a = get_or_404(session, Automation, auto_id, ws)
    if a.key in BUILT_IN_KEYS:
        raise HTTPException(409, {"code": "built_in", "message": "Built-in workflows can be switched off, not deleted."})
    session.delete(a)
    session.commit()
    return {"deleted": True}


@router.get("/automations/{auto_id}")
def get_automation(auto_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    a = get_or_404(session, Automation, auto_id, ws)
    runs = session.exec(select(AutomationRun).where(AutomationRun.automation_id == a.id)
                        .order_by(col(AutomationRun.started_at).desc()).limit(30)).all()
    return {"automation": a, "runs": runs, "trigger_status": trigger_status(session, ws, a),
            "built_in": a.key in BUILT_IN_KEYS}


@router.patch("/automations/{auto_id}")
def edit_automation(auto_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                    ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Editing automations")
    a = get_or_404(session, Automation, auto_id, ws)
    if "enabled" in data:
        a.enabled = bool(data["enabled"])
    _apply_trigger(a, data)
    if isinstance(data.get("steps"), list):
        steps = _clean_steps(data["steps"])
        if not steps:
            raise HTTPException(400, {"code": "steps_required", "message": "A workflow needs at least one step."})
        a.steps = steps
    for k in ("name", "description"):
        if k in data:
            setattr(a, k, data[k])
    a.updated_at = utcnow()
    session.add(a)
    session.commit()
    return {**a.model_dump(), "trigger_status": trigger_status(session, ws, a), "built_in": a.key in BUILT_IN_KEYS}


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
