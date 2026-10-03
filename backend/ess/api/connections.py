"""Connections: AI engine (API or MCP), mailbox (Gmail OAuth, IMAP, MCP), web search. Secrets stay encrypted."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import RedirectResponse
from sqlmodel import Session, select

from ..db import get_session
from ..models import AppState, Connection, TeamMember, Workspace, utcnow
from ..pipeline.connect import mail_source_for, secret_name
from ..secrets import delete_secret, get_secret, secret_hint, set_secret
from ..workspace import log_activity
from .deps import get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["connections"])

SECRET_FIELDS = {"api_key", "password", "token", "client_config"}
VALID = {
    "ai": {"api": {"openai", "anthropic", "google", "azure_openai", "openai_compatible", "groq", "mistral", "sambanova"}, "mcp": {"mcp"}},
    "mail": {"oauth": {"gmail"}, "imap": {"imap"}, "mcp": {"mcp", "gmail"}},
    "search": {"api": {"brave", "tavily", "serpapi", "duckduckgo", "exa", "firecrawl"}},
    "reader": {"api": {"firecrawl"}},
}


def public(conn: Connection) -> dict:
    d = conn.model_dump()
    d["secrets"] = {name.split(":", 1)[1]: secret_hint(name) for name in conn.secret_names or []}
    return d


@router.get("/connections")
def list_connections(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[dict]:
    rows = session.exec(select(Connection).where(Connection.workspace_id == ws.id).order_by(Connection.created_at)).all()
    return [public(c) for c in rows]


@router.post("/connections")
def create_connection(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                      user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Adding connections")
    kind, method, provider = data.get("kind"), data.get("method"), data.get("provider")
    if provider not in VALID.get(kind, {}).get(method, set()):
        raise HTTPException(400, {"code": "bad_connection", "message": f"Unsupported {kind}/{method}/{provider}"})
    # Saving a spare key must not switch the current service.
    active = bool(data.get("is_active", True))
    if active:
        _deactivate_kind(session, ws, kind)
    conn = Connection(workspace_id=ws.id, kind=kind, method=method, provider=provider,
                      name=data.get("name") or f"{provider} ({method})", config=data.get("config") or {},
                      status="not_connected" if method != "oauth" else "needs_auth", is_active=active)
    session.add(conn)
    session.flush()
    _store_secrets(conn, data.get("secrets") or {})
    session.add(conn)
    log_activity(session, ws.id, "connection_added", f"{conn.name} added", actor=user.name)
    session.commit()
    return public(conn)


def _deactivate_kind(session: Session, ws: Workspace, kind: str) -> None:
    for other in session.exec(select(Connection).where(Connection.workspace_id == ws.id, Connection.kind == kind)).all():
        other.is_active = False
        session.add(other)


def _store_secrets(conn: Connection, secrets: dict[str, Any]) -> None:
    names = set(conn.secret_names or [])
    for field, value in secrets.items():
        if field not in SECRET_FIELDS or value in (None, ""):
            continue
        if field == "client_config" and isinstance(value, str):
            value = json.loads(value)
        set_secret(secret_name(conn, field), value)
        names.add(secret_name(conn, field))
    conn.secret_names = sorted(names)


@router.patch("/connections/{conn_id}")
def update_connection(conn_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                      ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Changing connections")
    conn = get_or_404(session, Connection, conn_id, ws)
    if isinstance(data.get("config"), dict):
        cfg = {**(conn.config or {}), **data["config"]}
        if "model" in data["config"] and conn.kind == "ai":
            from ..pipeline.connect import model_eligibility

            status, reasons = model_eligibility(session, ws, conn.provider, data["config"]["model"], "classify_email")
            if status == "refused":
                raise HTTPException(409, {"code": "model_refused", "message": "; ".join(reasons)})
        conn.config = cfg
    if "name" in data:
        conn.name = data["name"]
    if "is_active" in data:
        conn.is_active = bool(data["is_active"])
    if "is_active" in data and conn.is_active:
        _deactivate_kind(session, ws, conn.kind)
        conn.is_active = True
    if data.get("secrets") or data.get("config"):
        conn.status, conn.last_error = "not_connected", None
    _store_secrets(conn, data.get("secrets") or {})
    conn.updated_at = utcnow()
    session.add(conn)
    session.commit()
    return public(conn)


@router.delete("/connections/{conn_id}")
def delete_connection(conn_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                      user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Removing connections")
    conn = get_or_404(session, Connection, conn_id, ws)
    for name in conn.secret_names or []:
        delete_secret(name)
    session.delete(conn)
    session.commit()
    return {"deleted": conn_id}


@router.post("/connections/{conn_id}/client-config")
async def upload_client_config(conn_id: str, file: UploadFile = File(...), session: Session = Depends(get_session),
                               ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    """Upload the OAuth client JSON downloaded from Google Cloud Console (Desktop or Web app client)."""
    require_role(user, "admin", "Configuring Google sign-in")
    conn = get_or_404(session, Connection, conn_id, ws)
    try:
        cfg = json.loads(await file.read())
        assert "installed" in cfg or "web" in cfg
    except Exception:
        raise HTTPException(400, {"code": "bad_client_config", "message": "Upload the client_secret_*.json from Google Cloud"})
    _store_secrets(conn, {"client_config": cfg})
    session.add(conn)
    session.commit()
    return public(conn)


def _redirect_uri(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/oauth/google/callback"


@router.post("/connections/{conn_id}/oauth/start")
def oauth_start(conn_id: str, request: Request, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    from ..sources.gmail_api import gmail_auth_url

    conn = get_or_404(session, Connection, conn_id, ws)
    client_config = get_secret(secret_name(conn, "client_config"))
    if not client_config:
        raise HTTPException(409, {"code": "client_config_missing",
                                  "message": "Upload the Google OAuth client JSON first (Settings → Connections → Gmail)."})
    import secrets as pysecrets

    verifier = pysecrets.token_urlsafe(64)[:96]
    state_row = session.get(AppState, f"oauth:{conn.id}") or AppState(key=f"oauth:{conn.id}")
    state_row.value = {"code_verifier": verifier, "at": utcnow().isoformat()}
    session.add(state_row)
    session.commit()
    url = gmail_auth_url(client_config, _redirect_uri(request), state=conn.id, code_verifier=verifier,
                         login_hint=conn.account or (conn.config or {}).get("account"))
    return {"auth_url": url, "redirect_uri": _redirect_uri(request)}


@router.get("/oauth/google/callback")
def oauth_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None,
                   session: Session = Depends(get_session)):
    from ..sources.gmail_api import GmailApiSource, gmail_exchange_code

    conn = session.get(Connection, state or "")
    if conn is None:
        raise HTTPException(400, {"code": "bad_state", "message": "Unknown connection"})
    if error or not code:
        conn.status, conn.last_error = "error", error or "No code returned"
        session.add(conn)
        session.commit()
        return RedirectResponse("/settings/connections?gmail=error")
    client_config = get_secret(secret_name(conn, "client_config"))
    state_row = session.get(AppState, f"oauth:{conn.id}")
    verifier = (state_row.value or {}).get("code_verifier") if state_row else None
    token = gmail_exchange_code(client_config, _redirect_uri(request), code, code_verifier=verifier)
    if state_row is not None:
        session.delete(state_row)
    set_secret(secret_name(conn, "token"), token)
    conn.secret_names = sorted(set(conn.secret_names or []) | {secret_name(conn, "token")})
    try:
        info = GmailApiSource(token=token, client_config=client_config).test()
        conn.status = "connected" if info.get("ok") else "error"
        conn.account = info.get("account")
        conn.last_error = info.get("error")
    except Exception as exc:
        conn.status, conn.last_error = "error", str(exc)[:500]
    conn.last_checked_at = utcnow()
    session.add(conn)
    session.commit()
    return RedirectResponse(f"/settings/connections?gmail={conn.status}")


@router.post("/connections/{conn_id}/test")
def test_connection(conn_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    conn = get_or_404(session, Connection, conn_id, ws)
    result: dict[str, Any]
    try:
        if conn.kind == "mail":
            source = mail_source_for(session, ws, conn)
            result = source.test()
            conn.account = result.get("account") or conn.account
        elif conn.kind == "ai" and conn.method == "api":
            from ..ai.providers import list_remote_model_details

            models = list_remote_model_details(conn.provider, get_secret(secret_name(conn, "api_key")),
                                        (conn.config or {}).get("base_url"), (conn.config or {}).get("extra"))
            result = {"ok": True, "models": len(models)}
            from .ai import upsert_remote_models

            upsert_remote_models(session, ws, conn, models)
        elif conn.kind == "ai" and conn.method == "mcp":
            last = session.get(AppState, f"mcp:last_client:{ws.id}")
            result = {"ok": bool(last and last.value), "client": last.value if last else None,
                      "message": "Connect your AI client to the MCP endpoint shown below." if not last else "Client seen"}
        elif conn.kind in ("search", "reader"):
            from ..customers.search import get_search_provider

            provider = get_search_provider({**(conn.config or {}), "provider": conn.provider,
                                            "api_key": get_secret(secret_name(conn, "api_key"))})
            try:
                if conn.kind == "reader":
                    page = provider.fetch_page("https://example.com")
                    result = {"ok": page.ok, "message": "Public example page read successfully.", "error": page.error}
                else:
                    hits = provider.search("engineering public information", max_results=1)
                    result = {"ok": True, "results": len(hits)}
            finally:
                if callable(getattr(provider, "close", None)):
                    provider.close()
        else:
            result = {"ok": False, "error": "Unknown connection type"}
    except Exception as exc:
        result = {"ok": False, "error": str(exc)[:500]}
    conn.status = "connected" if result.get("ok") else "error"
    conn.last_error = None if result.get("ok") else result.get("error")
    conn.last_checked_at = utcnow()
    session.add(conn)
    session.commit()
    return {**result, "connection": public(conn)}


@router.get("/mcp/info")
def mcp_info(request: Request, ws: Workspace = Depends(ws_dep)) -> dict:
    import os

    from ..config import get_settings

    base = str(request.base_url).rstrip("/")
    url = f"{base}/mcp/"
    token = bool(os.environ.get("ESS_MCP_TOKEN"))
    auth = " --header \"Authorization: Bearer $ESS_MCP_TOKEN\"" if token else ""
    backend_dir = str(Path(__file__).resolve().parents[2])
    stdio_env = {"ESS_DATA_DIR": str(get_settings().data_dir)}
    return {
        "url": url,
        "stdio_command": "python -m ess.mcp_server",
        "token_required": token,
        # ready-to-copy client setups (the person still approves the client's own permission prompts)
        "clients": [
            {"name": "Claude Code", "kind": "command",
             "value": f"claude mcp add --transport http engineering-smart-system {url}{auth}"},
            {"name": "Claude Desktop / other MCP clients (HTTP)", "kind": "json",
             "value": {"mcpServers": {"engineering-smart-system": {
                 "type": "http", "url": url,
                 **({"headers": {"Authorization": "Bearer <ESS_MCP_TOKEN>"}} if token else {})}}}},
            {"name": "Local stdio (same computer)", "kind": "json",
             "value": {"mcpServers": {"engineering-smart-system": {
                 "command": str(Path(backend_dir) / ".venv" / "bin" / "python"),
                 "args": ["-m", "ess.mcp_server"], "cwd": backend_dir, "env": stdio_env}}}},
        ],
        "rules": ["Declare your model with declare_engine before submitting work.",
                  "Submissions are validated: verbatim evidence, no prices, schema checks.",
                  "Nothing is sent to customers from MCP; sending needs a person in the app."],
    }
