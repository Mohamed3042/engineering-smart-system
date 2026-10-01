"""Template rules ('use this template for that kind of project') and the correction memory."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, col, select

from ..db import get_session
from ..learning import summary
from ..models import Lesson, Project, TeamMember, TemplateRule, Workspace, utcnow
from .deps import get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["learning"])

MATCH_KEYS = ("service_family", "work_type", "request_kind", "customer_id")


def _clean_match(match: dict) -> dict:
    return {k: v for k, v in (match or {}).items() if k in MATCH_KEYS and v}


def _check_template(key: str) -> None:
    from ..quotation.templates import TEMPLATES

    if key not in TEMPLATES:
        raise HTTPException(400, {"code": "bad_template", "message": f"Unknown template {key}"})


@router.get("/template-rules")
def list_rules(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[TemplateRule]:
    return list(session.exec(select(TemplateRule).where(TemplateRule.workspace_id == ws.id)
                             .order_by(TemplateRule.priority, col(TemplateRule.created_at))).all())


@router.post("/template-rules")
def add_rule(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
             user: TeamMember = Depends(user_dep)) -> TemplateRule:
    require_role(user, "engineer", "Adding template rules")
    _check_template(data.get("template_key") or "")
    rule = TemplateRule(workspace_id=ws.id, name=data.get("name") or "", match=_clean_match(data.get("match") or {}),
                        template_key=data["template_key"], language=data.get("language"), paper_id=data.get("paper_id"),
                        signatory_id=data.get("signatory_id"), priority=int(data.get("priority") or 100),
                        created_by=user.name)
    session.add(rule)
    session.commit()
    return rule


@router.patch("/template-rules/{rule_id}")
def edit_rule(rule_id: str, data: dict = Body(...), session: Session = Depends(get_session),
              ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> TemplateRule:
    require_role(user, "engineer", "Editing template rules")
    rule = get_or_404(session, TemplateRule, rule_id, ws)
    if "template_key" in data:
        _check_template(data["template_key"])
        rule.template_key = data["template_key"]
    if "match" in data:
        rule.match = _clean_match(data["match"])
    for k in ("name", "language", "paper_id", "signatory_id", "enabled"):
        if k in data:
            setattr(rule, k, data[k])
    if "priority" in data:
        rule.priority = int(data["priority"])
    rule.updated_at = utcnow()
    session.add(rule)
    session.commit()
    return rule


@router.delete("/template-rules/{rule_id}")
def delete_rule(rule_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "engineer", "Removing template rules")
    session.delete(get_or_404(session, TemplateRule, rule_id, ws))
    session.commit()
    return {"deleted": rule_id}


@router.post("/projects/{project_id}/template-preference")
def project_template_preference(project_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                                ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> TemplateRule:
    """'Use this template for projects like this one' — scope: same service family + work type, or this customer."""
    p = get_or_404(session, Project, project_id, ws)
    _check_template(data.get("template_key") or "")
    scope = data.get("scope") or "project_type"
    match = {"service_family": p.service_family, "work_type": p.work_type}
    if scope == "customer":
        if not p.customer_id:
            raise HTTPException(400, {"code": "no_customer", "message": "This project has no customer"})
        match["customer_id"] = p.customer_id
    existing = next((r for r in session.exec(select(TemplateRule).where(TemplateRule.workspace_id == ws.id)).all()
                     if (r.match or {}) == match), None)
    rule = existing or TemplateRule(workspace_id=ws.id, match=match, template_key=data["template_key"],
                                    created_by=user.name, priority=50 if scope == "customer" else 80)
    rule.template_key = data["template_key"]
    rule.language = data.get("language") or rule.language
    rule.paper_id = data.get("paper_id") or rule.paper_id
    rule.signatory_id = data.get("signatory_id") or rule.signatory_id
    rule.name = data.get("name") or (f"{p.service_family} / {p.work_type}" + (" / customer" if scope == "customer" else ""))
    rule.updated_at = utcnow()
    session.add(rule)
    session.commit()
    return rule


@router.get("/learning")
def lessons(kind: Optional[str] = None, scope: Optional[str] = None, scope_key: Optional[str] = None,
            session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    q = select(Lesson).where(Lesson.workspace_id == ws.id)
    if kind:
        q = q.where(col(Lesson.kind).in_(kind.split(",")))
    if scope:
        q = q.where(Lesson.scope == scope)
    if scope_key:
        q = q.where(Lesson.scope_key == scope_key)
    rows = session.exec(q.order_by(col(Lesson.last_seen_at).desc()).limit(500)).all()
    return {"items": rows, "summary": summary(session, ws)}


@router.patch("/learning/{lesson_id}")
def toggle_lesson(lesson_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                  ws: Workspace = Depends(ws_dep)) -> Lesson:
    lesson = get_or_404(session, Lesson, lesson_id, ws)
    if "active" in data:
        lesson.active = bool(data["active"])
    if "note" in data:
        lesson.note = str(data["note"])[:2000]
    session.add(lesson)
    session.commit()
    return lesson


@router.delete("/learning/{lesson_id}")
def forget(lesson_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
           user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Deleting lessons")
    session.delete(get_or_404(session, Lesson, lesson_id, ws))
    session.commit()
    return {"deleted": lesson_id}
