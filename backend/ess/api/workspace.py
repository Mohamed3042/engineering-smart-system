"""Workspace, session, team, dashboard, notifications, search, import/export."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, col, or_, select

from ..db import get_session
from ..models import (
    Activity,
    AppState,
    Connection,
    Customer,
    Email,
    Enquiry,
    Project,
    Quotation,
    TeamMember,
    Workspace,
    utcnow,
)
from ..pipeline.importer import export_snapshot, import_snapshot
from ..pipeline.state import STAGE_LABELS, attention_bucket
from ..workspace import create_workspace, current_user, get_active_workspace, set_active_workspace
from ..version import VERSION
from .deps import apply_patch, get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["workspace"])


class WorkspaceIn(BaseModel):
    name: str
    company_name: str = ""
    primary_email: str = ""
    region: str = ""
    country: str = ""
    languages: list[str] = ["en"]
    currency: str = "USD"
    timezone: str = "UTC"
    owner_name: str = "Owner"


@router.get("/health")
def health(request: Request) -> dict:
    return {"ok": True, "time": utcnow().isoformat(), "version": VERSION,
            "build_commit": getattr(request.app.state, "build_commit", "unknown")}


@router.get("/session")
def session_info(session: Session = Depends(get_session)) -> dict:
    ws = get_active_workspace(session, required=False)
    workspaces = session.exec(select(Workspace).order_by(Workspace.created_at)).all()
    if ws is None:
        return {"workspace": None, "user": None, "workspaces": [], "setup_step": "workspace"}
    user = current_user(session, ws)
    conns = session.exec(select(Connection).where(Connection.workspace_id == ws.id)).all()
    mail = next((c for c in conns if c.kind == "mail" and c.is_active), None)
    ai = next((c for c in conns if c.kind == "ai" and c.is_active), None)
    return {
        "workspace": ws,
        "user": user,
        "workspaces": [{"id": w.id, "name": w.name, "company_name": w.company_name, "primary_email": w.primary_email}
                       for w in workspaces],
        "setup_step": ws.setup_step,
        "mail": {"status": mail.status, "account": mail.account, "provider": mail.provider,
                 "last_sync": (ws.settings or {}).get("last_sync")} if mail else None,
        "ai": {"status": ai.status, "provider": ai.provider, "method": ai.method,
               "model": (ai.config or {}).get("model")} if ai else None,
    }


@router.get("/workspaces")
def list_workspaces(session: Session = Depends(get_session)) -> list[Workspace]:
    return list(session.exec(select(Workspace).order_by(Workspace.created_at)).all())


@router.post("/workspaces")
def new_workspace(body: WorkspaceIn, session: Session = Depends(get_session)) -> Workspace:
    data = body.model_dump()
    owner = data.pop("owner_name")
    return create_workspace(session, data, owner_name=owner)


@router.post("/workspaces/{workspace_id}/activate")
def activate_workspace(workspace_id: str, session: Session = Depends(get_session)) -> Workspace:
    ws = get_or_404(session, Workspace, workspace_id)
    set_active_workspace(session, ws.id)
    session.commit()
    return ws


@router.patch("/workspace")
def update_workspace(data: dict = Body(...), session: Session = Depends(get_session),
                     ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Workspace:
    require_role(user, "admin", "Changing workspace settings")
    apply_patch(ws, data, {"name", "company_name", "primary_email", "region", "country", "languages", "currency",
                           "timezone", "own_domains", "setup_step"})
    if "settings" in data and isinstance(data["settings"], dict):
        merged = dict(ws.settings or {})
        for k, v in data["settings"].items():
            if k == "ai_policy":
                continue  # changed only through /api/ai/policy (hard floor enforced there)
            merged[k] = {**merged.get(k, {}), **v} if isinstance(v, dict) and isinstance(merged.get(k), dict) else v
        ws.settings = merged
    ws.updated_at = utcnow()
    session.add(ws)
    session.commit()
    return ws


@router.get("/workspace/export")
def export_workspace(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    return export_snapshot(session, ws)


@router.post("/workspace/import")
async def import_workspace(file: Optional[UploadFile] = File(None), session: Session = Depends(get_session),
                           ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Importing a snapshot")
    if file is None:
        raise HTTPException(400, {"code": "no_file", "message": "Upload a snapshot .json file"})
    try:
        snap = json.loads(await file.read())
        return import_snapshot(session, ws, snap)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, {"code": "bad_snapshot", "message": str(exc)}) from exc


# --------------------------------------------------------------------------- team


@router.get("/team")
def team(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[TeamMember]:
    return list(session.exec(select(TeamMember).where(TeamMember.workspace_id == ws.id).order_by(TeamMember.created_at)).all())


@router.post("/team")
def add_member(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
               user: TeamMember = Depends(user_dep)) -> TeamMember:
    require_role(user, "admin", "Inviting team members")
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(400, {"code": "name_required", "message": "Name is required"})
    role = data.get("role") or "engineer"
    if role not in ("admin", "engineer", "sales", "viewer"):
        raise HTTPException(400, {"code": "bad_role", "message": f"Unknown role {role}"})
    member = TeamMember(workspace_id=ws.id, name=name, email=data.get("email") or "", role=role,
                        initials=data.get("initials") or "".join(p[0] for p in name.split()[:2]).upper())
    session.add(member)
    session.commit()
    return member


@router.patch("/team/{member_id}")
def update_member(member_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                  ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> TeamMember:
    require_role(user, "admin", "Changing team members")
    member = get_or_404(session, TeamMember, member_id, ws)
    if member.role == "owner" and data.get("role") not in (None, "owner"):
        raise HTTPException(400, {"code": "owner_role", "message": "The owner role cannot be changed"})
    apply_patch(member, data, {"name", "email", "role", "initials", "active"})
    session.add(member)
    session.commit()
    return member


@router.post("/team/{member_id}/act-as")
def act_as(member_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> TeamMember:
    member = get_or_404(session, TeamMember, member_id, ws)
    state = session.get(AppState, f"current_user:{ws.id}") or AppState(key=f"current_user:{ws.id}")
    state.value = member.id
    session.add(state)
    session.commit()
    return member


# --------------------------------------------------------------------------- dashboard


def _project_row(p: Project, customers: dict[str, Customer], today) -> dict:
    cust = customers.get(p.customer_id or "")
    return {
        "id": p.id, "code": p.code, "name": p.name, "customer": cust.name if cust else None,
        "customer_id": p.customer_id, "service_family": p.service_family, "work_type": p.work_type,
        "stage": p.stage, "stage_label": STAGE_LABELS.get(p.stage, p.stage), "review_status": p.review_status,
        "due_date": p.due_date, "priority": p.priority, "next_action": p.next_action, "blockers": p.blockers,
        "open_changes": [c for c in (p.changes or []) if not c.get("acknowledged")],
        "updated_at": p.updated_at, "bucket": attention_bucket(p, p.stage, p.blockers or [], today),
    }


@router.get("/dashboard")
def dashboard(date_from: Optional[str] = None, date_to: Optional[str] = None,
              session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    today = datetime.now(timezone.utc).date()
    customers = {c.id: c for c in session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()}
    projects = list(session.exec(select(Project).where(Project.workspace_id == ws.id)).all())
    if date_from or date_to:
        lo = datetime.fromisoformat(date_from[:10]).date() if date_from else None
        hi = datetime.fromisoformat(date_to[:10]).date() if date_to else None
        received: dict[str, list] = {}
        for e in session.exec(select(Enquiry).where(Enquiry.workspace_id == ws.id)).all():
            if e.received_at:
                received.setdefault(e.project_id, []).append(e.received_at.date())

        def in_range(p: Project) -> bool:
            days = received.get(p.id) or [p.created_at.date()]
            return any((lo is None or d >= lo) and (hi is None or d <= hi) for d in days)

        projects = [p for p in projects if in_range(p)]
    rows = [_project_row(p, customers, today) for p in projects]
    rows.sort(key=lambda r: (r["due_date"] is None, r["due_date"] or today, r["name"]))
    buckets = {b: [r for r in rows if r["bucket"] == b] for b in ("needs_attention", "in_progress", "completed")}
    since = utcnow() - timedelta(days=2)
    activity = session.exec(
        select(Activity).where(Activity.workspace_id == ws.id).order_by(col(Activity.created_at).desc()).limit(25)
    ).all()
    email_q = select(Email).where(Email.workspace_id == ws.id)
    emails = session.exec(email_q).all()
    work_cats = {"bmu", "wce", "cradle", "hoist", "crane", "access_rental", "scaffolding", "space_frame", "other_work"}
    by_family: dict[str, int] = {}
    for p in projects:
        if not p.archived_at:
            by_family[p.service_family] = by_family.get(p.service_family, 0) + 1
    quotes = session.exec(select(Quotation).where(Quotation.workspace_id == ws.id)).all()
    return {
        "workspace": {"name": ws.name, "company_name": ws.company_name, "primary_email": ws.primary_email},
        "range": {"from": date_from, "to": date_to},
        "counts": {k: len(v) for k, v in buckets.items()},
        "buckets": buckets,
        "by_service_family": by_family,
        "inbox": {
            "total": len(emails),
            "work": sum(1 for e in emails if e.category in work_cats),
            "unread_work": sum(1 for e in emails if e.category in work_cats and e.state == "new"),
        },
        "quotations": {s: sum(1 for q in quotes if q.status == s) for s in
                       ("draft", "needs_review", "changes_requested", "approved", "sent")},
        "today": [a for a in activity if a.created_at and a.created_at.replace(tzinfo=a.created_at.tzinfo or timezone.utc) >= since] or list(activity[:8]),
        "sync": (ws.settings or {}).get("last_sync"),
    }


# --------------------------------------------------------------------------- notifications & search


@router.get("/notifications")
def notifications(limit: int = 50, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    items = session.exec(select(Activity).where(Activity.workspace_id == ws.id)
                         .order_by(col(Activity.created_at).desc()).limit(limit)).all()
    return {"unread": sum(1 for a in items if not a.is_read), "items": items}


@router.post("/notifications/read-all")
def read_all(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    items = session.exec(select(Activity).where(Activity.workspace_id == ws.id, Activity.is_read == False)).all()  # noqa: E712
    for a in items:
        a.is_read = True
        session.add(a)
    session.commit()
    return {"updated": len(items)}


@router.get("/search")
def search(q: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    like = f"%{q.strip()}%"
    if len(q.strip()) < 2:
        return {"projects": [], "emails": [], "customers": [], "quotations": []}
    projects = session.exec(select(Project).where(Project.workspace_id == ws.id, or_(
        col(Project.name).ilike(like), col(Project.tender_no).ilike(like), col(Project.code).ilike(like),
        col(Project.location).ilike(like))).limit(8)).all()
    emails = session.exec(select(Email).where(Email.workspace_id == ws.id, or_(
        col(Email.subject).ilike(like), col(Email.from_email).ilike(like), col(Email.from_name).ilike(like)))
        .order_by(col(Email.date).desc()).limit(8)).all()
    customers = session.exec(select(Customer).where(Customer.workspace_id == ws.id, or_(
        col(Customer.name).ilike(like), col(Customer.domain).ilike(like))).limit(8)).all()
    quotations = session.exec(select(Quotation).where(Quotation.workspace_id == ws.id,
                                                     col(Quotation.reference).ilike(like)).limit(8)).all()
    return {
        "projects": [{"id": p.id, "name": p.name, "code": p.code, "service_family": p.service_family, "stage": p.stage} for p in projects],
        "emails": [{"id": e.id, "subject": e.subject, "from": e.from_name or e.from_email, "date": e.date, "category": e.category} for e in emails],
        "customers": [{"id": c.id, "name": c.name, "domain": c.domain} for c in customers],
        "quotations": [{"id": x.id, "reference": x.reference, "status": x.status, "project_id": x.project_id} for x in quotations],
    }


@router.patch("/enquiries/{enquiry_id}")
def update_enquiry(enquiry_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Enquiry:
    """Our status and the customer's answer are separate facts (sent ≠ accepted)."""
    from ..pipeline.state import refresh_project_state

    enq = get_or_404(session, Enquiry, enquiry_id, ws)
    if data.get("status") in ("open", "quoted", "declined", "lost", "won", "closed"):
        enq.status = data["status"]
    if data.get("customer_response") in ("none", "awaiting", "clarification", "accepted", "rejected"):
        enq.customer_response = data["customer_response"]
        enq.customer_response_at = utcnow()
        from ..workspace import log_activity

        log_activity(session, ws.id, "customer_response", f"Customer response: {enq.customer_response}",
                     detail=data.get("note", ""), actor=user.name, project_id=enq.project_id)
    if data.get("due_date"):
        from datetime import date as _date

        new = _date.fromisoformat(str(data["due_date"])[:10])
        if new != enq.due_date:
            enq.due_date_history = [*(enq.due_date_history or []), {"value": enq.due_date.isoformat() if enq.due_date else None,
                                                                    "changed_at": utcnow().isoformat(), "confirmed_by": user.name}]
            enq.due_date = new
    enq.updated_at = utcnow()
    session.add(enq)
    project = session.get(Project, enq.project_id)
    if project:
        refresh_project_state(session, project)
    session.commit()
    return enq


@router.get("/enquiries")
def enquiries(project_id: Optional[str] = None, session: Session = Depends(get_session),
              ws: Workspace = Depends(ws_dep)) -> list[Enquiry]:
    q = select(Enquiry).where(Enquiry.workspace_id == ws.id)
    if project_id:
        q = q.where(Enquiry.project_id == project_id)
    return list(session.exec(q).all())
