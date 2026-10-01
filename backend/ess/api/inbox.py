"""Classified inbox, categories (show/hide), category corrections, unsubscribe with approval."""
from __future__ import annotations

from collections import Counter
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, col, func, or_, select

from ..db import get_session
from ..models import Approval, Category, Customer, Email, Project, TeamMember, Workspace, utcnow
from ..workspace import log_activity
from .deps import get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["inbox"])


def _categories(session: Session, ws: Workspace) -> list[Category]:
    return list(session.exec(select(Category).where(Category.workspace_id == ws.id).order_by(Category.order)).all())


@router.get("/categories")
def list_categories(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[dict]:
    counts = dict(session.exec(select(Email.category, func.count()).where(Email.workspace_id == ws.id)
                               .group_by(Email.category)).all())
    return [{**c.model_dump(), "count": counts.get(c.key, 0)} for c in _categories(session, ws)]


@router.patch("/categories/{key}")
def update_category(key: str, data: dict = Body(...), session: Session = Depends(get_session),
                    ws: Workspace = Depends(ws_dep)) -> Category:
    cat = get_or_404(session, Category, f"{ws.id}:{key}", ws)
    for field in ("visible", "label", "label_ar", "icon", "description", "order"):
        if field in data:
            setattr(cat, field, data[field])
    if "keywords" in data and isinstance(data["keywords"], dict):
        cat.keywords = data["keywords"]
        cat.source = "user"
    session.add(cat)
    session.commit()
    return cat


@router.post("/categories")
def add_category(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                 user: TeamMember = Depends(user_dep)) -> Category:
    require_role(user, "admin", "Adding categories")
    key = (data.get("key") or "").strip().lower().replace(" ", "_")
    if not key or session.get(Category, f"{ws.id}:{key}"):
        raise HTTPException(400, {"code": "bad_key", "message": "Category key missing or already used"})
    cat = Category(id=f"{ws.id}:{key}", workspace_id=ws.id, key=key, label=data.get("label") or key,
                   group=data.get("group") or "work", is_work_type=data.get("group", "work") == "work",
                   icon=data.get("icon") or "tag", keywords=data.get("keywords") or {}, source="user", order=500)
    session.add(cat)
    session.commit()
    return cat


@router.get("/visibility")
def get_visibility(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    return {"groups": (ws.settings or {}).get("visibility", {}).get("groups", {}),
            "categories": {c.key: c.visible for c in _categories(session, ws)}}


@router.put("/visibility")
def set_visibility(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    settings = dict(ws.settings or {})
    vis = dict(settings.get("visibility") or {})
    if isinstance(data.get("groups"), dict):
        vis["groups"] = {**vis.get("groups", {}), **{k: bool(v) for k, v in data["groups"].items()}}
    settings["visibility"] = vis
    ws.settings = settings
    session.add(ws)
    for key, visible in (data.get("categories") or {}).items():
        cat = session.get(Category, f"{ws.id}:{key}")
        if cat:
            cat.visible = bool(visible)
            session.add(cat)
    session.commit()
    return get_visibility(session, ws)


@router.get("/emails")
def list_emails(group: Optional[str] = None, category: Optional[str] = None, state: Optional[str] = None,
                q: Optional[str] = None, project_id: Optional[str] = None, customer_id: Optional[str] = None,
                thread_id: Optional[str] = None, include_hidden: bool = False, sort: str = "newest",
                page: int = 1, page_size: int = 50, session: Session = Depends(get_session),
                ws: Workspace = Depends(ws_dep)) -> dict:
    cats = {c.key: c for c in _categories(session, ws)}
    groups_visible = (ws.settings or {}).get("visibility", {}).get("groups", {})
    query = select(Email).where(Email.workspace_id == ws.id)
    if category:
        query = query.where(col(Email.category).in_(category.split(",")))
    elif group:
        keys = [k for k, c in cats.items() if c.group == group]
        query = query.where(col(Email.category).in_(keys))
    if not include_hidden and not category:
        hidden = [k for k, c in cats.items() if not c.visible or groups_visible.get(c.group) is False]
        if group and groups_visible.get(group) is False:
            hidden = [k for k in hidden if cats[k].group != group]  # the user opened that tab on purpose
        if hidden:
            query = query.where(col(Email.category).not_in(hidden))
    if state:
        query = query.where(col(Email.state).in_(state.split(",")))
    if project_id:
        query = query.where(Email.project_id == project_id)
    if customer_id:
        query = query.where(Email.customer_id == customer_id)
    if thread_id:
        query = query.where(Email.thread_id == thread_id)
    if q:
        like = f"%{q}%"
        query = query.where(or_(col(Email.subject).ilike(like), col(Email.from_email).ilike(like),
                                col(Email.from_name).ilike(like), col(Email.snippet).ilike(like)))
    total = session.exec(select(func.count()).select_from(query.subquery())).one()
    order = col(Email.date).desc() if sort != "oldest" else col(Email.date).asc()
    rows = session.exec(query.order_by(order).offset(max(page - 1, 0) * page_size).limit(page_size)).all()
    projects = {p.id: p for p in session.exec(select(Project).where(
        col(Project.id).in_([r.project_id for r in rows if r.project_id]))).all()}
    customers = {c.id: c for c in session.exec(select(Customer).where(
        col(Customer.id).in_([r.customer_id for r in rows if r.customer_id]))).all()}
    items = []
    for r in rows:
        d = r.model_dump(exclude={"body_text"})
        p = projects.get(r.project_id or "")
        c = customers.get(r.customer_id or "")
        d["project"] = {"id": p.id, "name": p.name, "service_family": p.service_family} if p else None
        d["customer"] = {"id": c.id, "name": c.name} if c else None
        d["category_label"] = cats[r.category].label if r.category in cats else r.category
        items.append(d)
    return {"total": total, "page": page, "page_size": page_size, "items": items}


@router.get("/inbox/summary")
def inbox_summary(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    cats = _categories(session, ws)
    counts = dict(session.exec(select(Email.category, func.count()).where(Email.workspace_id == ws.id)
                               .group_by(Email.category)).all())
    new_counts = dict(session.exec(select(Email.category, func.count()).where(
        Email.workspace_id == ws.id, Email.state == "new").group_by(Email.category)).all())
    groups: dict[str, dict] = {}
    for c in cats:
        g = groups.setdefault(c.group, {"total": 0, "new": 0, "categories": []})
        g["total"] += counts.get(c.key, 0)
        g["new"] += new_counts.get(c.key, 0)
        g["categories"].append({"key": c.key, "label": c.label, "icon": c.icon, "visible": c.visible,
                                "count": counts.get(c.key, 0), "new": new_counts.get(c.key, 0)})
    promo = session.exec(select(Email).where(Email.workspace_id == ws.id, Email.category == "promotions",
                                             Email.unsubscribed_at == None)).all()  # noqa: E711
    senders = Counter(e.from_email for e in promo)
    candidates = []
    for sender, n in senders.most_common(15):
        sample = next(e for e in promo if e.from_email == sender)
        candidates.append({"sender": sender, "name": sample.from_name, "count": n, "sample_subject": sample.subject,
                           "email_id": sample.id, "can_unsubscribe": bool(sample.list_unsubscribe)})
    return {"groups": groups, "unsubscribe_candidates": candidates,
            "group_visibility": (ws.settings or {}).get("visibility", {}).get("groups", {})}


@router.get("/emails/{email_id}")
def get_email(email_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    email = get_or_404(session, Email, email_id, ws)
    thread = session.exec(select(Email).where(Email.thread_id == email.thread_id).order_by(col(Email.date))).all()
    project = session.get(Project, email.project_id) if email.project_id else None
    customer = session.get(Customer, email.customer_id) if email.customer_id else None
    cat = session.get(Category, f"{ws.id}:{email.category}")
    return {
        "email": email,
        "thread": [{"id": t.id, "from_name": t.from_name, "from_email": t.from_email, "date": t.date,
                    "subject": t.subject, "direction": t.direction, "snippet": t.snippet, "body_text": t.body_text,
                    "attachments": t.attachments} for t in thread],
        "category": cat,
        "project": project,
        "customer": customer,
    }


def _correct_category(session: Session, ws: Workspace, email: Email, category: str, user: TeamMember) -> None:
    """A person files a message under another category: logged, and learned for the next similar mail."""
    if category == email.category:
        return
    if not session.get(Category, f"{ws.id}:{category}"):
        raise HTTPException(400, {"code": "bad_category", "message": "Unknown category"})
    log_activity(session, ws.id, "category_corrected", f"Category corrected: {email.subject[:60]}",
                 detail=f"{email.category} → {category}", actor=user.name, email_id=email.id)
    from ..learning import on_category_corrected

    on_category_corrected(session, ws, email, email.category, category, user.name)
    email.category = category
    email.category_source = "user"
    email.category_confidence = 1.0
    email.category_reason = f"Corrected by {user.name}"


@router.patch("/emails/{email_id}")
def update_email(email_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                 ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Email:
    email = get_or_404(session, Email, email_id, ws)
    if "category" in data:
        _correct_category(session, ws, email, data["category"], user)
    for field in ("state", "priority", "project_id", "customer_id"):
        if field in data:
            setattr(email, field, data[field])
    email.updated_at = utcnow()
    session.add(email)
    session.commit()
    return email


@router.post("/emails/bulk")
def bulk_emails(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                user: TeamMember = Depends(user_dep)) -> dict:
    ids = data.get("ids") or []
    action = data.get("action")
    rows = session.exec(select(Email).where(Email.workspace_id == ws.id, col(Email.id).in_(ids))).all()
    for e in rows:
        if action == "archive":
            e.state = "archived"
        elif action == "mark_reviewed":
            e.state = "linked" if e.project_id else "needs_review"
        elif action == "set_category" and data.get("category"):
            _correct_category(session, ws, e, data["category"], user)  # same rule and lesson as one message
        session.add(e)
    session.commit()
    return {"updated": len(rows)}


@router.post("/emails/{email_id}/unsubscribe")
def unsubscribe(email_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
                ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    """Unsubscribing contacts a third party, so it needs an explicit confirmation from a person."""
    email = get_or_404(session, Email, email_id, ws)
    if not data.get("confirm"):
        return {"needs_confirmation": True, "sender": email.from_email, "method": _unsub_method(email)}
    method = _unsub_method(email)
    result = {"status": "not_available", "method": method}
    if method == "one_click":
        import httpx

        url = _first_https(email.list_unsubscribe or "")
        try:
            r = httpx.post(url, data={"List-Unsubscribe": "One-Click"}, timeout=20, follow_redirects=True)
            result = {"status": "done" if r.status_code < 400 else "failed", "method": method, "http_status": r.status_code}
        except httpx.HTTPError as exc:
            result = {"status": "failed", "method": method, "error": str(exc)}
    elif method == "link":
        result = {"status": "open_link", "method": method, "url": _first_https(email.list_unsubscribe or "")}
    elif method == "mailto":
        result = {"status": "needs_mail", "method": method,
                  "message": "Sender asks for an unsubscribe e-mail; send it from your mailbox."}
    session.add(Approval(workspace_id=ws.id, action="unsubscribe", target_type="email", target_id=email.id,
                         decided_by=user.name, decision="approved", note=str(result)))
    if result["status"] in ("done", "open_link"):
        others = session.exec(select(Email).where(Email.workspace_id == ws.id, Email.from_email == email.from_email)).all()
        for e in others:
            e.unsubscribed_at = utcnow()
            e.state = "archived"
            session.add(e)
    log_activity(session, ws.id, "unsubscribe", f"Unsubscribe from {email.from_email}", detail=result["status"],
                 actor=user.name, email_id=email.id)
    session.commit()
    return result


def _first_https(header: str) -> Optional[str]:
    for part in header.split(","):
        part = part.strip().strip("<>")
        if part.startswith("https://"):
            return part
    return None


def _unsub_method(email: Email) -> str:
    header = email.list_unsubscribe or ""
    if _first_https(header) and (email.list_unsubscribe_post or "").lower().startswith("list-unsubscribe=one-click"):
        return "one_click"
    if _first_https(header):
        return "link"
    if "mailto:" in header:
        return "mailto"
    return "none"
