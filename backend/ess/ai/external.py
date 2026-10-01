"""Policy checks for "Engine via MCP": an external AI client drives the app.

The MCP server (``ess/mcp_server.py``, built by the lead) calls these functions so that a model
connected over MCP faces exactly the same gate as a model called through an API key:

1. ``check_external_model`` / ``require_external_model`` – the client must DECLARE its provider and
   model; the declaration is evaluated with the same registry, refusal rules, workspace policy and
   qualification exam (``exam_requests`` / ``score_external_exam`` run that exam over MCP).
   Undeclared models are refused.
2. ``prepare_task`` – the server hands the client the same system prompt (non-negotiable rules),
   user prompt and JSON schema that the API engine would use.
3. ``accept_external_result`` – every answer the client submits is schema-validated and passed
   through the same guards (evidence verification, price stripping, number/date checks) before it
   touches the database. There is no way to submit "already verified" facts.
"""
from __future__ import annotations

from typing import Any

from .errors import RefusedByPolicy
from .policy import EligibilityResult, Policy, evaluate_model
from .registry import PROVIDERS, get_spec
from .tasks import RULES, TaskRequest, finalize, prepare

EXTERNAL_RULES = (
    "You are connected to Engineering Smart System as its AI engine. Before any task, declare your provider "
    "and exact model ID; only models that pass the workspace AI policy and its qualification exam may work. "
    "Every answer you submit is validated by software:\n" + RULES +
    "\n7. You never send, reply, forward or delete mail and never approve anything: a human engineer approves "
    "every quotation and every outgoing message."
)


def check_external_model(provider: str | None, model: str | None, *, task: str | None = None,
                         policy: Policy | None = None, exam: dict | None | object = ...) -> EligibilityResult:
    """Eligibility of the model an MCP client declares (``exam=...`` reads the local exam store)."""
    if not provider or not model or provider not in PROVIDERS:
        return EligibilityResult("refused", [
            "the AI client must declare its provider (one of: " + ", ".join(PROVIDERS) + ") and exact model ID"],
            provider=str(provider or ""), model=str(model or ""), task=task)
    from .store import latest_exam, load_policy

    spec = get_spec(provider, model)
    pol = policy if policy is not None else load_policy()
    record = latest_exam(provider, model) if exam is ... else exam
    return evaluate_model(spec, pol, record, task)  # type: ignore[arg-type]


def require_external_model(provider: str | None, model: str | None, *, task: str | None = None,
                           policy: Policy | None = None, exam: dict | None | object = ...) -> EligibilityResult:
    """Like :func:`check_external_model` but raises :class:`RefusedByPolicy` unless eligible."""
    result = check_external_model(provider, model, task=task, policy=policy, exam=exam)
    if result.status != "eligible":
        raise RefusedByPolicy(f"{provider}:{model} may not run {task or 'tasks'} ({result.status}): "
                              f"{'; '.join(result.reasons)}", reasons=result.reasons, eligibility=result.to_dict(),
                              provider=provider, model=model)
    return result


def prepare_task(task: str, **inputs: Any) -> TaskRequest:
    """The exact request (rules, prompt, schema, sources) the API engine would send for ``task``."""
    return prepare(task, **inputs)


def accept_external_result(request: TaskRequest, output: dict | str, *, provider: str | None = None,
                           model: str | None = None, policy: Policy | None = None,
                           exam: dict | None | object = ...) -> dict:
    """Validate and guard an answer submitted by an MCP client. With ``provider``/``model`` the
    declared model is (re)checked for this task first. Raises RefusedByPolicy / InvalidOutput."""
    if provider is not None or model is not None:
        require_external_model(provider, model, task=request.task, policy=policy, exam=exam)
    result = finalize(request, output)
    result.setdefault("guard_report", {})["engine"] = {"mode": "mcp", "provider": provider, "model": model}
    return result
