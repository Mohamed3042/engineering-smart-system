"""Shared FastAPI dependencies and small helpers for routers."""
from __future__ import annotations

from typing import Any, Optional, TypeVar

from fastapi import Depends, HTTPException
from sqlmodel import Session, SQLModel

from ..db import get_session
from ..models import TeamMember, Workspace
from ..workspace import current_user, get_active_workspace

T = TypeVar("T", bound=SQLModel)

ROLE_RANK = {"viewer": 0, "sales": 1, "engineer": 2, "admin": 3, "owner": 4}


def ws_dep(session: Session = Depends(get_session)) -> Workspace:
    ws = get_active_workspace(session)
    assert ws is not None
    return ws


def user_dep(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> TeamMember:
    return current_user(session, ws)


def require_role(user: TeamMember, minimum: str, action: str) -> None:
    if ROLE_RANK.get(user.role, 0) < ROLE_RANK[minimum]:
        raise HTTPException(status_code=403, detail={
            "code": "forbidden", "message": f"{action} needs the {minimum} role (you are {user.role})."})


def get_or_404(session: Session, model: type[T], obj_id: str, ws: Optional[Workspace] = None) -> T:
    obj = session.get(model, obj_id)
    if obj is None or (ws is not None and getattr(obj, "workspace_id", ws.id) != ws.id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": f"{model.__name__} {obj_id} not found"})
    return obj


def apply_patch(obj: Any, data: dict[str, Any], allowed: set[str]) -> list[str]:
    changed = []
    for key, value in data.items():
        if key in allowed and getattr(obj, key) != value:
            setattr(obj, key, value)
            changed.append(key)
    return changed
