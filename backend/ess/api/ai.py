"""AI engine: providers, model catalogue with eligibility, qualification exams, model choice, quality policy."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, select

from .. import jobs
from ..db import get_session, session_scope
from ..models import AIModelState, AppState, Connection, TeamMember, Workspace, utcnow
from ..pipeline.connect import _policy, _spec, active_connection, secret_name
from ..secrets import get_secret
from ..workspace import log_activity
from .deps import get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api/ai", tags=["ai"])

from ..ai.hosted import HOSTED

PROVIDERS = [
    *[{"key": key, "label": spec["label"], "fields": ["api_key"], "optional": [],
       "signup_url": spec["signup_url"], "hint": spec["hint"], "base_url": spec["base_url"]}
      for key, spec in HOSTED.items()],
    {"key": "openai", "label": "OpenAI", "fields": ["api_key"], "optional": ["base_url"]},
    {"key": "anthropic", "label": "Anthropic (Claude)", "fields": ["api_key"], "optional": []},
    {"key": "google", "label": "Google (Gemini)", "fields": ["api_key"], "optional": []},
    {"key": "azure_openai", "label": "Azure OpenAI", "fields": ["api_key", "base_url"], "optional": ["api_version"]},
    {"key": "openai_compatible", "label": "OpenAI-compatible (e.g. OpenRouter)", "fields": ["api_key", "base_url"], "optional": []},
]

CRITICAL_TASKS = ("extract_request", "analyze_document", "analyze_drawing", "draft_quotation", "discover_business",
                  "research_customer")


def _spec_dict(spec: Any) -> dict:
    if hasattr(spec, "to_dict"):
        return spec.to_dict()
    if hasattr(spec, "model_dump"):
        return spec.model_dump()
    if hasattr(spec, "__dataclass_fields__"):
        from dataclasses import asdict

        return asdict(spec)
    return dict(getattr(spec, "__dict__", {}))


def _evaluate_all(session: Session, ws: Workspace, provider: str, model_id: str, exam: Optional[dict]) -> dict:
    from ..ai.policy import evaluate_model

    state = session.get(AIModelState, f"{ws.id}:{provider}:{model_id}")
    spec = _spec(provider, model_id, state.capabilities if state else None)
    policy = _policy(ws)
    per_task = {}
    for task in ("classify_email", *CRITICAL_TASKS):
        r = evaluate_model(spec, policy, exam=exam, task=task)
        per_task[task] = {"status": r.status, "reasons": list(r.reasons)}
    overall = evaluate_model(spec, policy, exam=exam, task=None)
    return {"spec": spec, "overall": overall, "per_task": per_task}


def upsert_model_state(session: Session, ws: Workspace, provider: str, model_id: str, source: str = "registry",
                       exam: Optional[dict] = None, remote_info: Optional[dict] = None) -> AIModelState:
    sid = f"{ws.id}:{provider}:{model_id}"
    state = session.get(AIModelState, sid) or AIModelState(id=sid, workspace_id=ws.id, provider=provider, model_id=model_id)
    if remote_info is not None:
        state.capabilities = remote_info
        session.add(state)
        session.flush()
    if exam is not None:
        state.exam = exam
        state.evaluated_at = utcnow()
    ev = _evaluate_all(session, ws, provider, model_id, state.exam or None)
    spec = _spec_dict(ev["spec"])
    state.display_name = spec.get("display_name") or model_id
    state.tier = spec.get("tier") or "standard"
    caps = spec.get("capabilities") or {}
    state.capabilities = caps if isinstance(caps, dict) else _spec_dict(caps)
    state.status = ev["overall"].status
    state.reasons = [*ev["overall"].reasons, *[f"{t}: {v['status']}" for t, v in ev["per_task"].items()]]
    state.source = source if source != "registry" else state.source
    state.updated_at = utcnow()
    session.add(state)
    return state


def upsert_remote_models(session: Session, ws: Workspace, conn: Connection, models: list) -> list[AIModelState]:
    return [upsert_model_state(session, ws, conn.provider, m["id"] if isinstance(m, dict) else m,
                               source="remote", remote_info=m if isinstance(m, dict) else None) for m in models]


@router.get("/providers")
def providers() -> list[dict]:
    return PROVIDERS


@router.get("/models")
def models(provider: Optional[str] = None, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    from ..ai.registry import load_registry

    conn = active_connection(session, ws, "ai", "api")
    provider = provider or (conn.provider if conn else None)
    for spec in load_registry().all(provider):
        if not session.get(AIModelState, f"{ws.id}:{spec.provider}:{spec.model_id}"):
            upsert_model_state(session, ws, spec.provider, spec.model_id)
    session.commit()
    q = select(AIModelState).where(AIModelState.workspace_id == ws.id)
    if provider:
        q = q.where(AIModelState.provider == provider)
    rows = session.exec(q).all()
    order = {"eligible": 0, "needs_evaluation": 1, "failed_evaluation": 2, "refused": 3}
    rows = sorted(rows, key=lambda r: (order.get(r.status, 9), r.tier != "frontier", r.model_id))
    selected = (conn.config or {}).get("model") if conn else None
    return {"provider": provider, "selected": selected,
            "items": [{**r.model_dump(), "is_selected": r.model_id == selected} for r in rows]}


@router.post("/models/refresh")
def refresh(data: dict = Body(default={}), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    from ..ai.providers import list_remote_model_details

    conn = get_or_404(session, Connection, data["connection_id"], ws) if data.get("connection_id") else active_connection(session, ws, "ai", "api")
    if conn is None:
        raise HTTPException(409, {"code": "no_connection", "message": "Connect an AI provider first"})
    try:
        remote = list_remote_model_details(conn.provider, get_secret(secret_name(conn, "api_key")),
                                    (conn.config or {}).get("base_url"), (conn.config or {}).get("extra"))
    except Exception as exc:
        raise HTTPException(502, {"code": "provider_error", "message": str(exc)[:500]})
    states = upsert_remote_models(session, ws, conn, remote)
    session.commit()
    return {"models": len(states), "eligible": sum(1 for s in states if s.status == "eligible")}


def run_exam(ws_id: str, conn_id: str, model_id: str) -> dict:
    from ..ai.engine import AIEngine
    from ..ai.qualification import run_qualification

    with session_scope() as s:
        conn = s.get(Connection, conn_id)
        ws = s.get(Workspace, ws_id)
        model_state = s.get(AIModelState, f"{ws.id}:{conn.provider}:{model_id}")
        spec = _spec(conn.provider, model_id, model_state.capabilities if model_state else None)
        tier = getattr(spec, "tier", "standard")
        if tier == "refused":
            raise ValueError(f"{model_id} is refused by policy and cannot be examined")
        policy = _policy(ws)
        engine = AIEngine(provider=conn.provider, model=model_id, api_key=get_secret(secret_name(conn, "api_key")),
                          base_url=(conn.config or {}).get("base_url"), extra=(conn.config or {}).get("extra") or {},
                          policy=policy, exam=None, remote_info=model_state.capabilities if model_state else None)
    try:
        exam = run_qualification(engine, policy=policy)
    except Exception as exc:
        exam = {"model": model_id, "provider": conn.provider, "score": 0.0, "passed": False,
                "critical_failures": [f"exam could not run: {exc}"], "cases": [], "ran_at": utcnow().isoformat()}
    exam = exam if isinstance(exam, dict) else exam.__dict__
    with session_scope() as s:
        ws = s.get(Workspace, ws_id)
        state = upsert_model_state(s, ws, conn.provider, model_id, exam=exam)
        log_activity(s, ws_id, "model_exam", f"{model_id}: {'passed' if exam.get('passed') else 'failed'} qualification",
                     detail=f"score {exam.get('score')}", severity="success" if exam.get("passed") else "warning")
        return {"status": state.status, "score": exam.get("score")}


@router.post("/models/evaluate")
def evaluate(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
             user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Running the model exam")
    conn = get_or_404(session, Connection, data.get("connection_id") or "", ws)
    model_id = data.get("model_id") or ""
    if getattr(_spec(conn.provider, model_id), "tier", "") == "refused":
        raise HTTPException(409, {"code": "model_refused", "message": f"{model_id} is refused by policy"})
    started = jobs.submit(f"exam:{ws.id}:{model_id}", run_exam, ws.id, conn.id, model_id)
    return {"started": started}


@router.post("/models/select")
def select_model(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                 user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Choosing the AI model")
    conn = get_or_404(session, Connection, data.get("connection_id") or "", ws)
    model_id = data.get("model_id") or ""
    state = upsert_model_state(session, ws, conn.provider, model_id)
    if state.status != "eligible":
        raise HTTPException(409, {"code": "not_eligible",
                                  "message": f"{model_id} is {state.status}: " + "; ".join(state.reasons[:3])})
    conn.config = {**(conn.config or {}), "model": model_id}
    conn.updated_at = utcnow()
    session.add(conn)
    log_activity(session, ws.id, "model_selected", f"AI model set to {model_id}", actor=user.name)
    session.commit()
    return {"selected": model_id}


@router.get("/policy")
def get_policy(ws: Workspace = Depends(ws_dep)) -> dict:
    from ..ai import policy as policy_mod

    pol = _policy(ws)
    out = pol.to_dict() if hasattr(pol, "to_dict") else dict(pol)
    # the hard floor the form must not go below (the server enforces it again on PUT)
    out["floor"] = {"min_score": policy_mod.MIN_SCORE_FLOOR, "max_critical_failures": policy_mod.MAX_CRITICAL_FAILURES,
                    "max_exam_age_days": policy_mod.MAX_EXAM_AGE_CEILING_DAYS,
                    "min_context_tokens": policy_mod.MIN_CONTEXT_FLOOR,
                    "mandatory_capabilities": sorted(policy_mod.MANDATORY_CAPABILITIES),
                    "never_tiers": sorted(policy_mod.NEVER_TIERS)}
    return out


@router.put("/policy")
def put_policy(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
               user: TeamMember = Depends(user_dep)) -> dict:
    """Admins may make the policy stricter. The hard floor (no light/refused tiers on critical work,
    minimum exam score, mandatory evidence) is enforced by ess.ai.policy and cannot be lowered."""
    require_role(user, "admin", "Changing the AI quality policy")
    from ..ai import policy as pol

    try:
        new = pol.Policy.from_dict(data)
        if hasattr(pol, "enforce_floor"):
            new = pol.enforce_floor(new)
    except Exception as exc:
        raise HTTPException(400, {"code": "bad_policy", "message": str(exc)})
    settings = dict(ws.settings or {})
    settings["ai_policy"] = new.to_dict()
    ws.settings = settings
    session.add(ws)
    for state in session.exec(select(AIModelState).where(AIModelState.workspace_id == ws.id)).all():
        upsert_model_state(session, ws, state.provider, state.model_id)
    log_activity(session, ws.id, "policy", "AI quality policy updated", actor=user.name)
    session.commit()
    return settings["ai_policy"]


@router.get("/status")
def status(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    conn_api = active_connection(session, ws, "ai", "api")
    conn_mcp = active_connection(session, ws, "ai", "mcp")
    model = (conn_api.config or {}).get("model") if conn_api else None
    state = session.get(AIModelState, f"{ws.id}:{conn_api.provider}:{model}") if conn_api and model else None
    # An MCP client declares its model (declare_engine) and takes the exam; eligibility is per task.
    decl_row = session.get(AppState, f"mcp:engine:{ws.id}")
    decl = decl_row.value if decl_row and isinstance(decl_row.value, dict) else None
    mcp = None
    if conn_mcp or decl:
        exam_state = (session.get(AIModelState, f"{ws.id}:{decl.get('provider')}:{decl.get('model_id')}")
                      if decl else None)
        mcp = {
            "status": conn_mcp.status if conn_mcp else "declared",
            "declared": {k: decl.get(k) for k in ("provider", "model_id", "client", "declared_at")} if decl else None,
            "tasks": (decl or {}).get("tasks") or {},
            "eligibility": exam_state.status if exam_state else None,
            "reasons": exam_state.reasons if exam_state else [],
            "exam": exam_state.exam if exam_state else None,
            "evaluated_at": exam_state.evaluated_at if exam_state else None,
        }
    privacy_ready = not (conn_api and conn_api.provider == "mistral" and not conn_api.config.get("training_opt_out_confirmed"))
    mcp_ready = bool(mcp and any(t.get("status") == "eligible" for t in mcp["tasks"].values()))
    return {
        "method": "api" if conn_api and conn_api.is_active else ("mcp" if mcp else None),
        "api": {"provider": conn_api.provider, "model": model, "status": conn_api.status,
                "eligibility": (state.status if state else None) if privacy_ready else "needs_evaluation",
                "reasons": (state.reasons if state else []) if privacy_ready else ["Confirm API data training is disabled in Mistral settings."]} if conn_api else None,
        "mcp": mcp,
        "rules_only": not (conn_api and privacy_ready and state and state.status == "eligible") and not mcp_ready,
    }
