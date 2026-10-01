"""Qualification exam runner.

``run_qualification(engine)`` runs every synthetic case of :mod:`ess.ai.exam_cases` through the real
task code (prompts + guards) on the engine's model and scores it deterministically:

* case score = weighted share of passed checks; a case passes with no failed critical check and a
  score ≥ 0.75;
* exam score = mean case score; the exam passes with score ≥ the policy's ``min_score`` (never
  below 0.90) and **zero** critical failures. Invalid JSON after the repair retry or a refusal is a
  critical failure of that case.
* the record is signed (HMAC, per-installation key): hand-made records are ignored by the policy.

The model may answer the exam before it is qualified (the engine allows exactly these synthetic
prompts), but a refused model cannot even take it. Auth, quota, network and unknown-model errors
abort the exam without recording a result: they say nothing about the model's quality.

For an external AI client connected over MCP, ``exam_requests()`` hands out the same prompts and
``score_external_exam()`` scores the client's answers with the same checks.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Callable

from .engine import exam_session
from .errors import InvalidOutput, ModelDeclined, RefusedByPolicy
from .exam_cases import CASE_PASS_SCORE, EXAM_CASES, EXAM_VERSION, ExamCase, select_cases
from .policy import DEFAULT_POLICY, Policy, evaluate_model, sign_exam
from .registry import get_spec
from .tasks import finalize


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def score_case(case: ExamCase, result: dict | None, error: BaseException | str | None = None) -> dict:
    """Score one case from its finalised result (or the error that prevented one)."""
    if result is None:
        kind = "declined" if isinstance(error, ModelDeclined) else "invalid_output"
        message = getattr(error, "message", None) or str(error or "no answer")
        return {"id": case.id, "task": case.task, "title": case.title, "passed": False, "score": 0.0,
                "details": [{"check": kind, "passed": False, "critical": True, "weight": 1.0, "info": message[:300]}],
                "error": f"{type(error).__name__ if isinstance(error, BaseException) else 'Error'}: {message[:300]}"}
    details = []
    total = earned = 0.0
    critical_failed = False
    for check in case.checks:
        try:
            ok, info = check.fn(result)
        except Exception as exc:  # a malformed answer must fail the check, not crash the exam
            ok, info = False, f"check error: {type(exc).__name__}: {exc}"
        ok = bool(ok)
        total += check.weight
        earned += check.weight if ok else 0.0
        critical_failed |= check.critical and not ok
        details.append({"check": check.name, "passed": ok, "critical": check.critical, "weight": check.weight,
                        "info": str(info)[:300]})
    score = round(earned / total, 4) if total else 0.0
    return {"id": case.id, "task": case.task, "title": case.title, "passed": not critical_failed and score >= CASE_PASS_SCORE,
            "score": score, "details": details, "error": None}


def _assemble(provider: str, model: str, cases: list[dict], policy: Policy, *, mode: str,
              served_models: list[str], usage: dict | None, started: float) -> dict:
    pol = policy.effective()
    score = round(sum(c["score"] for c in cases) / len(cases), 4) if cases else 0.0
    critical = [{"case": c["id"], "check": d["check"], "detail": d["info"]}
                for c in cases for d in c["details"] if d["critical"] and not d["passed"]]
    task_results: dict[str, dict] = {}
    for c in cases:
        tr = task_results.setdefault(c["task"], {"cases": 0, "passed": 0, "score": 0.0})
        tr["cases"] += 1
        tr["passed"] += int(c["passed"])
        tr["score"] += c["score"]
    for tr in task_results.values():
        tr["score"] = round(tr["score"] / tr["cases"], 4)
    return sign_exam({
        "provider": provider, "model": model, "score": score,
        "passed": bool(cases) and score >= pol.min_score and not critical,
        "critical_failures": critical, "cases": cases, "ran_at": _now_iso(),
        "exam_version": EXAM_VERSION, "tasks": sorted(task_results), "task_results": task_results,
        "threshold": pol.min_score, "mode": mode, "served_models": served_models, "usage": usage or {},
        "duration_s": round(time.monotonic() - started, 2),
    })


def run_qualification(engine: Any, tasks: list[str] | None = None, *, policy: Policy | None = None,
                      save: bool = True, progress: Callable[[int, int, dict], None] | None = None) -> dict:
    """Run the exam on ``engine`` -> ``{model, provider, score, passed, critical_failures, cases, ran_at, ...}``.

    ``tasks`` limits the exam (e.g. ``["classify_email"]`` to qualify a standard model for mail
    classification only); eligibility for a task always requires that its cases were examined and
    passed. The result is saved to the local store (``save=True``) and pinned on the engine.
    """
    pol = policy or engine.policy
    pre = evaluate_model(engine.spec, pol, None, None)
    if pre.status == "refused":
        raise RefusedByPolicy(f"{engine.provider}:{engine.model} is refused and cannot take the exam: "
                              f"{'; '.join(pre.reasons)}", reasons=pre.reasons, eligibility=pre.to_dict(),
                              provider=engine.provider, model=engine.model)
    cases = select_cases(tasks, vision=engine.spec.capabilities.vision is not False)
    if not cases:
        raise ValueError(f"no exam cases for tasks {tasks!r}")
    requests = [(case, case.request()) for case in cases]
    usage_before = dict(engine.usage)
    started = time.monotonic()
    scored: list[dict] = []
    with exam_session(engine, [req.user for _, req in requests]) as ctx:
        for i, (case, req) in enumerate(requests, 1):
            try:
                raw = engine.complete_json(req.system, req.user, req.schema, images=req.images or None,
                                           max_tokens=req.max_tokens, task=req.task, effort=req.effort)
                result = finalize(req, raw)
                entry = score_case(case, result)
            except (InvalidOutput, ModelDeclined) as exc:
                entry = score_case(case, None, exc)
            scored.append(entry)
            if progress:
                progress(i, len(requests), entry)
        served = sorted(ctx["served_models"])
    usage = {k: engine.usage.get(k, 0) - usage_before.get(k, 0) for k in engine.usage}
    result = _assemble(engine.provider, engine.model, scored, pol, mode="api", served_models=served, usage=usage,
                       started=started)
    if save:
        from .store import save_exam

        save_exam(result)
    engine.set_exam(result)
    return result


# ------------------------------------------------------------------ external (MCP) clients

def exam_requests(tasks: list[str] | None = None, *, vision: bool = True) -> list[dict]:
    """The exam prompts for an external AI client: ``[{case_id, task, system, user, schema,
    images_base64, max_tokens}]``. The client answers each with one JSON object."""
    return [{"case_id": c.id, **c.request().to_dict()} for c in select_cases(tasks, vision=vision)]


def score_external_exam(provider: str, model: str, answers: dict[str, Any], tasks: list[str] | None = None, *,
                        vision: bool = True, policy: Policy | None = None, save: bool = True) -> dict:
    """Score an external client's answers (``{case_id: json-object-or-string}``) with the same checks.
    Missing or invalid answers fail their case critically. The declared model must not be refused."""
    pol = policy or DEFAULT_POLICY
    spec = get_spec(provider, model)
    pre = evaluate_model(spec, pol, None, None)
    if pre.status == "refused":
        raise RefusedByPolicy(f"{provider}:{model} is refused and cannot take the exam: {'; '.join(pre.reasons)}",
                              reasons=pre.reasons, eligibility=pre.to_dict(), provider=provider, model=model)
    started = time.monotonic()
    scored = []
    for case in select_cases(tasks, vision=vision):
        answer = answers.get(case.id)
        if answer is None:
            scored.append(score_case(case, None, InvalidOutput("no answer submitted for this case")))
            continue
        try:
            scored.append(score_case(case, finalize(case.request(), answer)))
        except InvalidOutput as exc:
            scored.append(score_case(case, None, exc))
    result = _assemble(provider, model, scored, pol, mode="external", served_models=[], usage=None, started=started)
    if save:
        from .store import save_exam

        save_exam(result)
    return result


def self_check() -> list[dict]:
    """Score every golden answer (all must pass) - used by the test-suite and by reviewers."""
    return [score_case(c, finalize(c.request(), c.golden)) for c in EXAM_CASES]
