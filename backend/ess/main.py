"""FastAPI application: REST API, MCP endpoint, scheduler, and the built frontend."""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import os

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import FileResponse, JSONResponse

from .api import ai, automations, connections, customers, inbox, knowledge, learning, projects, quotations, workspace
from .config import get_settings
from .db import init_db

log = logging.getLogger("ess")


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    stop = asyncio.Event()
    tasks = []
    if os.environ.get("ESS_SCHEDULER", "1") == "1":
        from .automations.runner import scheduler_loop

        tasks.append(asyncio.create_task(scheduler_loop(stop)))
    async with contextlib.AsyncExitStack() as stack:
        manager = getattr(app.state, "mcp_server", None)
        if manager is not None:
            await stack.enter_async_context(manager.session_manager.run())
        yield
        stop.set()
        for t in tasks:
            t.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="Engineering Smart System", version="0.1.0", lifespan=lifespan)

    access_token = os.environ.get("ESS_ACCESS_TOKEN")
    mcp_token = os.environ.get("ESS_MCP_TOKEN")

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        if path.startswith("/mcp") and mcp_token:
            supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
            if not hmac.compare_digest(supplied, mcp_token):
                return JSONResponse({"detail": "MCP token required"}, status_code=401)
        elif access_token and path.startswith("/api") and path != "/api/health" and not path.startswith("/api/oauth/"):
            supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip() or request.cookies.get("ess_token", "")
            if not hmac.compare_digest(supplied, access_token):
                return JSONResponse({"detail": {"code": "unauthorized", "message": "Access token required"}}, status_code=401)
        return await call_next(request)

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse({"detail": detail}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def unexpected(_request: Request, exc: Exception):
        from .pipeline.connect import NotConnected

        if isinstance(exc, NotConnected):
            return JSONResponse({"detail": {"code": "not_connected", "message": str(exc)}}, status_code=409)
        log.exception("unhandled error")
        return JSONResponse({"detail": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"}}, status_code=500)

    for module in (workspace, inbox, projects, quotations, customers, knowledge, connections, ai, automations, learning):
        app.include_router(module.router)

    try:
        from .mcp_server import get_server, http_app

        app.mount("/mcp", http_app())
        app.state.mcp_server = get_server()
    except Exception as exc:  # the REST app still works without MCP
        log.warning("MCP endpoint disabled: %s", exc)

    dist = get_settings().frontend_dist
    if dist.exists():
        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            target = (dist / full_path).resolve()
            if full_path and target.is_file() and dist.resolve() in target.parents:
                return FileResponse(target)
            if full_path.startswith(("api/", "mcp")):
                return JSONResponse({"detail": {"code": "not_found", "message": full_path}}, status_code=404)
            return FileResponse(dist / "index.html")

    return app


app = create_app()


def run() -> None:
    import uvicorn

    s = get_settings()
    uvicorn.run("ess.main:app", host=s.host, port=s.port, reload=False)


if __name__ == "__main__":
    run()
