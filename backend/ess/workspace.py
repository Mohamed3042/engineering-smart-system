"""Workspace lifecycle: active workspace, defaults for new workspaces, activity log."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException
from sqlmodel import Session, select

from .models import (
    Activity,
    AppState,
    Automation,
    Category,
    Signatory,
    TeamMember,
    Workspace,
    utcnow,
)

# Used when the knowledge package data files are not available.
FALLBACK_CATEGORIES: list[dict[str, Any]] = [
    {"key": "bmu", "label": "Building Maintenance Units", "group": "work", "icon": "building-2", "is_work_type": True},
    {"key": "wce", "label": "Window Cleaning Equipment", "group": "work", "icon": "app-window", "is_work_type": True},
    {"key": "cradle", "label": "Suspended platforms / cradles", "group": "work", "icon": "rows-3", "is_work_type": True},
    {"key": "hoist", "label": "Construction hoists", "group": "work", "icon": "arrow-up-from-line", "is_work_type": True},
    {"key": "crane", "label": "Cranes & lifting", "group": "work", "icon": "construction", "is_work_type": True},
    {"key": "access_rental", "label": "Man lifts & access rental", "group": "work", "icon": "forklift", "is_work_type": True},
    {"key": "scaffolding", "label": "Scaffolding", "group": "work", "icon": "grid-3x3", "is_work_type": True},
    {"key": "space_frame", "label": "Space frames & shades", "group": "work", "icon": "network", "is_work_type": True},
    {"key": "other_work", "label": "Other work requests", "group": "work", "icon": "briefcase", "is_work_type": True},
    {"key": "vendor_offer", "label": "Supplier & OEM offers", "group": "other", "icon": "store"},
    {"key": "bills", "label": "Bills & payments", "group": "bills", "icon": "receipt"},
    {"key": "promotions", "label": "Promotions & newsletters", "group": "promotions", "icon": "megaphone", "visible": False},
    {"key": "internal", "label": "Internal", "group": "other", "icon": "users"},
    {"key": "notifications", "label": "Notifications", "group": "other", "icon": "bell", "visible": False},
    {"key": "other", "label": "Other", "group": "other", "icon": "inbox"},
]

DEFAULT_SETTINGS: dict[str, Any] = {
    "visibility": {"groups": {"work": True, "bills": True, "promotions": False, "other": True}},
    "scan_scope": {"months": 2, "include_sent": True, "max_threads": 2000},
    "downloads": {
        # Files customers send through these hosts are fetched automatically; any other host
        # waits for a person to approve the download.
        "auto_approve_hosts": ["drive.google.com", "docs.google.com", "wetransfer.com", "we.tl",
                                "dropbox.com", "www.dropbox.com", "onedrive.live.com", "1drv.ms"],
        "max_file_mb": 2000,
    },
    "quotations": {"default_language": "en", "default_currency": "USD", "require_engineer_review": True},
    "review_checklist": [
        {"key": "scope", "label": "Scope accuracy"},
        {"key": "drawings", "label": "Drawing revision"},
        {"key": "loads", "label": "Load assumptions"},
        {"key": "standards", "label": "Standards & compliance"},
        {"key": "exclusions", "label": "Exclusions"},
        {"key": "commercial", "label": "Commercial terms"},
    ],
}

DEFAULT_AUTOMATIONS: list[dict[str, Any]] = [
    {
        "key": "enquiry_intake",
        "name": "New enquiry intake",
        "description": "Classify new mail, open a project, fetch files, study them and draft the quotation for engineer review.",
        "trigger": "new_email",
        "steps": [
            {"key": "classify", "label": "Classify email", "type": "classify"},
            {"key": "link_project", "label": "Link to project and enquiry", "type": "link_project"},
            {"key": "attachments", "label": "Save attachments", "type": "fetch_attachments"},
            {"key": "links", "label": "Download shared links", "type": "fetch_links", "requires_approval": False},
            {"key": "extract", "label": "Read documents and drawings", "type": "extract_files"},
            {"key": "analyze", "label": "Analyse scope", "type": "analyze_project"},
            {"key": "draft", "label": "Draft quotation (no prices)", "type": "draft_quotation"},
            {"key": "review", "label": "Engineer review", "type": "request_review", "requires_approval": True},
        ],
    },
    {
        "key": "change_watch",
        "name": "Deadline and revision watch",
        "description": "Detect closing-date extensions, addenda, reminders and technical revisions; flag affected projects.",
        "trigger": "schedule",
        "interval_minutes": 60,
        "steps": [
            {"key": "scan_new", "label": "Read new mail", "type": "sync_mail"},
            {"key": "detect_changes", "label": "Detect changes", "type": "detect_changes"},
            {"key": "notify", "label": "Notify owners", "type": "notify"},
        ],
    },
    {
        "key": "customer_watch",
        "name": "Customer updates",
        "description": "Check monitored customers for news, new projects and tenders.",
        "trigger": "schedule",
        "interval_minutes": 7 * 24 * 60,
        "enabled": False,
        "steps": [{"key": "monitor", "label": "Search for updates", "type": "monitor_customers"}],
    },
    {
        "key": "inbox_hygiene",
        "name": "Inbox hygiene",
        "description": "Hide promotions, group bills, and suggest unsubscribe candidates (unsubscribing needs approval).",
        "trigger": "schedule",
        "interval_minutes": 24 * 60,
        "steps": [
            {"key": "classify_rest", "label": "Classify non-work mail", "type": "classify"},
            {"key": "unsubscribe", "label": "Suggest unsubscribes", "type": "suggest_unsubscribe", "requires_approval": True},
        ],
    },
]


def _default_categories() -> list[dict[str, Any]]:
    try:
        from .knowledge.base import default_categories

        cats = default_categories()
        if cats:
            return cats
    except Exception:
        pass
    return FALLBACK_CATEGORIES


def default_ai_policy() -> dict[str, Any]:
    try:
        from .ai.policy import DEFAULT_POLICY

        return DEFAULT_POLICY.to_dict() if hasattr(DEFAULT_POLICY, "to_dict") else dict(DEFAULT_POLICY)
    except Exception:
        return {}


def create_workspace(session: Session, data: dict[str, Any], *, owner_name: str = "Owner") -> Workspace:
    settings = {**DEFAULT_SETTINGS, **(data.pop("settings", None) or {})}
    settings.setdefault("ai_policy", default_ai_policy())
    ws = Workspace(**data, settings=settings)
    if ws.primary_email and "@" in ws.primary_email and not ws.own_domains:
        ws.own_domains = [ws.primary_email.split("@", 1)[1].lower()]
    if ws.currency == "USD" and (ws.country or "").upper() == "KW":
        ws.currency = "KWD"
    session.add(ws)
    session.flush()

    for order, cat in enumerate(_default_categories()):
        session.add(
            Category(
                id=f"{ws.id}:{cat['key']}",
                workspace_id=ws.id,
                key=cat["key"],
                label=cat.get("label", cat["key"]),
                label_ar=cat.get("label_ar", ""),
                group=cat.get("group", "other"),
                icon=cat.get("icon", "mail"),
                # noise is hidden on day one; the user can show it from the filters panel
                visible=cat.get("visible", True) and cat["key"] not in ("promotions", "notifications"),
                is_work_type=cat.get("is_work_type", cat.get("group") == "work"),
                description=cat.get("description", ""),
                keywords=cat.get("keywords", {}),
                negative_keywords=cat.get("negative_keywords", {}),
                order=order,
                source="default",
            )
        )
    for auto in DEFAULT_AUTOMATIONS:
        session.add(Automation(workspace_id=ws.id, enabled=auto.get("enabled", True),
                               **{k: v for k, v in auto.items() if k != "enabled"}))
    initials = "".join(p[0] for p in owner_name.split()[:2]).upper() or "OW"
    session.add(TeamMember(workspace_id=ws.id, name=owner_name, email=ws.primary_email, role="owner", initials=initials))
    set_active_workspace(session, ws.id)
    session.commit()
    return ws


def set_active_workspace(session: Session, workspace_id: str) -> None:
    state = session.get(AppState, "active_workspace") or AppState(key="active_workspace")
    state.value = workspace_id
    session.add(state)


def get_active_workspace(session: Session, *, required: bool = True) -> Optional[Workspace]:
    state = session.get(AppState, "active_workspace")
    ws = session.get(Workspace, state.value) if state and state.value else None
    if ws is None:
        ws = session.exec(select(Workspace).order_by(Workspace.created_at)).first()
        if ws is not None:
            set_active_workspace(session, ws.id)
            session.commit()
    if ws is None and required:
        raise HTTPException(status_code=409, detail={"code": "no_workspace", "message": "Create a workspace first."})
    return ws


def current_user(session: Session, ws: Workspace) -> TeamMember:
    state = session.get(AppState, f"current_user:{ws.id}")
    user = session.get(TeamMember, state.value) if state and state.value else None
    if user is None:
        user = session.exec(
            select(TeamMember).where(TeamMember.workspace_id == ws.id, TeamMember.active == True)  # noqa: E712
            .order_by(TeamMember.created_at)
        ).first()
    if user is None:
        user = TeamMember(workspace_id=ws.id, name="Owner", role="owner", initials="OW")
        session.add(user)
        session.commit()
    return user


def default_signatory(session: Session, ws: Workspace) -> Optional[Signatory]:
    sigs = session.exec(select(Signatory).where(Signatory.workspace_id == ws.id)).all()
    for s in sigs:
        if s.is_default:
            return s
    return sigs[0] if sigs else None


def log_activity(session: Session, ws_id: str, kind: str, title: str, **fields: Any) -> Activity:
    act = Activity(workspace_id=ws_id, kind=kind, title=title, **fields)
    session.add(act)
    return act


def touch(obj: Any) -> Any:
    if hasattr(obj, "updated_at"):
        obj.updated_at = utcnow()
    return obj
