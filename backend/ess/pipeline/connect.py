"""Turn stored Connection rows into live objects: mail sources and policy-checked AI engines."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from sqlmodel import Session, select

from ..models import AIModelState, Connection, Workspace
from ..secrets import get_secret, set_secret


class NotConnected(RuntimeError):
    """No usable connection of the requested kind (message is shown to the user)."""


def active_connection(session: Session, ws: Workspace, kind: str, method: Optional[str] = None) -> Optional[Connection]:
    q = select(Connection).where(Connection.workspace_id == ws.id, Connection.kind == kind, Connection.is_active == True)  # noqa: E712
    if method:
        q = q.where(Connection.method == method)
    rows = session.exec(q.order_by(Connection.created_at.desc())).all()
    connected = [c for c in rows if c.status == "connected"]
    return (connected or rows or [None])[0]


def secret_name(conn: Connection, field: str) -> str:
    return f"{conn.id}:{field}"


# --------------------------------------------------------------------------- mail


def mail_source_for(session: Session, ws: Workspace, conn: Optional[Connection] = None):
    conn = conn or active_connection(session, ws, "mail")
    if conn is None:
        raise NotConnected("No mailbox connected. Connect Gmail (API or MCP) or IMAP in Settings → Connections.")
    cfg = conn.config or {}
    if conn.method == "oauth" and conn.provider == "gmail":
        from ..sources.gmail_api import GmailApiSource

        token = get_secret(secret_name(conn, "token"))
        client_config = get_secret(secret_name(conn, "client_config"))
        if not token or not client_config:
            raise NotConnected("Gmail is not authorised yet. Finish the Google sign-in in Settings → Connections.")
        token_name = secret_name(conn, "token")
        return GmailApiSource(token=token, client_config=client_config, account=conn.account,
                              own_domains=tuple(ws.own_domains or ()),
                              on_token_refresh=lambda fresh: set_secret(token_name, fresh))
    if conn.method == "imap":
        from ..sources.imap import ImapSource

        return ImapSource(host=cfg["host"], port=int(cfg.get("port") or 993), username=cfg["username"],
                          password=get_secret(secret_name(conn, "password")) or "", ssl=cfg.get("ssl", True),
                          smtp_host=cfg.get("smtp_host"), smtp_port=int(cfg.get("smtp_port") or 587),
                          own_domains=tuple(ws.own_domains or ()), account=conn.account or cfg["username"])
    if conn.method == "mcp":
        from ..sources.mcp_mail import McpMailSource

        headers = dict(cfg.get("headers") or {})
        token = get_secret(secret_name(conn, "token"))
        if token:
            headers.setdefault("Authorization", f"Bearer {token}")
        return McpMailSource(transport=cfg.get("transport", "http"), url=cfg.get("url"), headers=headers or None,
                             command=cfg.get("command"), args=cfg.get("args"), env=cfg.get("env"),
                             tool_map=cfg.get("tool_map"), account=conn.account,
                             own_domains=tuple(ws.own_domains or ()))
    raise NotConnected(f"Unsupported mail connection {conn.provider}/{conn.method}")


# --------------------------------------------------------------------------- AI


@dataclass
class EngineChoice:
    engine: Any
    connection: Connection
    model: str
    status: str
    reasons: list[str]


def _policy(ws: Workspace):
    from ..ai import policy as pol

    data = (ws.settings or {}).get("ai_policy") or {}
    loader = getattr(pol, "Policy", None)
    if data and loader is not None and hasattr(loader, "from_dict"):
        return loader.from_dict(data)
    return pol.DEFAULT_POLICY


def _spec(provider: str, model: str):
    from ..ai.registry import get_spec

    return get_spec(provider, model)


def model_eligibility(session: Session, ws: Workspace, provider: str, model: str, task: Optional[str] = None) -> tuple[str, list[str]]:
    from ..ai.policy import evaluate_model

    state = session.get(AIModelState, f"{ws.id}:{provider}:{model}")
    exam = state.exam if state and state.exam else None
    result = evaluate_model(_spec(provider, model), _policy(ws), exam=exam, task=task)
    return result.status, list(result.reasons)


def engine_for(session: Session, ws: Workspace, task: str, *, required: bool = False) -> Optional[EngineChoice]:
    """Return an AI engine allowed to run `task`, or None (or raise when required)."""
    conn = active_connection(session, ws, "ai", "api")
    if conn is None or not (conn.config or {}).get("model"):
        if required:
            raise NotConnected("No AI engine selected. Connect a provider and pick an eligible model in Settings → AI.")
        return None
    model = conn.config["model"]
    try:
        status, reasons = model_eligibility(session, ws, conn.provider, model, task)
    except ImportError:
        status, reasons = "refused", ["AI policy module unavailable"]
    if status != "eligible":
        if required:
            raise NotConnected(f"Model {model} cannot run '{task}': " + "; ".join(reasons))
        return None
    from ..ai.engine import AIEngine

    state = session.get(AIModelState, f"{ws.id}:{conn.provider}:{model}")
    engine = AIEngine(provider=conn.provider, model=model, api_key=get_secret(secret_name(conn, "api_key")),
                      base_url=(conn.config or {}).get("base_url"), extra=(conn.config or {}).get("extra") or {},
                      policy=_policy(ws), exam=(state.exam or None) if state else None)
    return EngineChoice(engine=engine, connection=conn, model=model, status=status, reasons=reasons)
