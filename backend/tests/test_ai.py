"""Core quality gates of ess.ai: engine, policy, registry. No network, no API keys."""
from __future__ import annotations

import inspect
import json

import pytest

from ess.ai.engine import AIEngine, ProviderResponse, exam_session, provider_schema
from ess.ai.errors import (AuthError, InputTooLarge, InvalidOutput, ModelDeclined, ModelNotFound, PolicyError,
                           ProviderError, QuotaError, RefusedByPolicy)
from ess.ai.policy import (CRITICAL_TASKS, DEFAULT_POLICY, MIN_CONTEXT_FLOOR, MIN_SCORE_FLOOR, TASKS, Policy,
                           eligibility_table, evaluate_model)
from ess.ai.registry import Capabilities, classify_unknown, get_spec, load_registry, parse_registry
from ess.ai.testing import ScriptedTransport, exam_record, http_error

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["category", "confidence"],
          "properties": {"category": {"type": "string", "enum": ["bmu", "wce"]},
                         "confidence": {"type": "number", "minimum": 0, "maximum": 1}}}
GOOD = {"category": "bmu", "confidence": 0.9}


def engine(provider="anthropic", model="claude-opus-5-5", items=(), *, exam="passed", policy=None, sleeps=None,
           **kwargs) -> AIEngine:
    record = exam_record(provider, model) if exam == "passed" else exam
    sleeps = [] if sleeps is None else sleeps
    return AIEngine(provider, model, api_key="test", transport=ScriptedTransport(list(items)), exam=record,
                    policy=policy if policy is not None else DEFAULT_POLICY, sleep=sleeps.append, **kwargs)


# ============================================================================ engine

def test_valid_output_is_returned_and_usage_counted():
    eng = engine(items=[GOOD])
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD
    assert eng.usage == {"calls": 1, "input_tokens": 10, "output_tokens": 5, "retries": 0, "repairs": 0, "failures": 0}


def test_invalid_output_gets_one_repair_retry_with_the_errors():
    eng = engine(items=['{"category": "crane", "confidence": 2}', GOOD])
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD
    second = eng._transport.requests[1]
    assert "CORRECTION REQUIRED" in second.user and "'crane' is not one of" in second.user
    assert eng.usage["repairs"] == 1 and eng.usage["calls"] == 2


def test_invalid_twice_raises_invalid_output():
    eng = engine(items=["not json at all", '{"category": "bmu"}'])
    with pytest.raises(InvalidOutput) as exc:
        eng.complete_json("sys", "user", SCHEMA, task="classify_email")
    assert any("confidence" in e for e in exc.value.errors)
    assert eng.usage["failures"] == 1


def test_json_inside_code_fence_is_accepted():
    eng = engine(items=["```json\n" + json.dumps(GOOD) + "\n```"])
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD


def test_truncated_output_retries_with_more_tokens():
    eng = engine(items=[ProviderResponse(text='{"category": "bm', finish_reason="length"), GOOD])
    eng.complete_json("sys", "user", SCHEMA, task="classify_email", max_tokens=1000)
    first, second = eng._transport.requests
    assert second.max_tokens - first.max_tokens == 1000  # headroom constant, max_tokens doubled
    assert "token limit" in second.user


def test_backoff_on_429_and_5xx_then_success():
    sleeps: list[float] = []
    eng = engine(items=[http_error(429, "rate limited"), http_error(503, "overloaded"), GOOD], sleeps=sleeps)
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD
    assert len(sleeps) == 2 and 0.75 <= sleeps[0] <= 1.25 and 1.5 <= sleeps[1] <= 2.5
    assert eng.usage["retries"] == 2 and eng.usage["calls"] == 1


def test_retry_after_header_is_honoured():
    sleeps: list[float] = []
    eng = engine(items=[http_error(429, "slow down", retry_after=7), GOOD], sleeps=sleeps)
    eng.complete_json("sys", "user", SCHEMA, task="classify_email")
    assert sleeps[0] >= 7


def test_server_errors_exhaust_retries():
    sleeps: list[float] = []
    eng = engine(items=[http_error(500, "boom")] * 5, sleeps=sleeps, max_retries=4)
    with pytest.raises(ProviderError):
        eng.complete_json("sys", "user", SCHEMA, task="classify_email")
    assert len(sleeps) == 4


def test_network_error_is_retried():
    sleeps: list[float] = []
    eng = engine(items=[http_error(None, "connection reset"), GOOD], sleeps=sleeps)
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD
    assert len(sleeps) == 1


@pytest.mark.parametrize("err, exc_type", [
    (http_error(429, "You exceeded your current quota", code="insufficient_quota"), QuotaError),
    (http_error(401, "invalid x-api-key"), AuthError),
    (http_error(403, "permission denied"), AuthError),
    (http_error(404, "model not found"), ModelNotFound),
    (http_error(400, "The model `gpt-9` does not exist"), ModelNotFound),
    (http_error(400, "prompt is too long: 250000 tokens > 200000 maximum"), InputTooLarge),
    (http_error(400, "messages: unexpected field"), ProviderError),
])
def test_fail_fast_errors_are_not_retried(err, exc_type):
    sleeps: list[float] = []
    eng = engine(items=[err], sleeps=sleeps)
    with pytest.raises(exc_type):
        eng.complete_json("sys", "user", SCHEMA, task="classify_email")
    assert sleeps == []


def test_rejected_native_schema_falls_back_to_json_mode():
    eng = engine(items=[http_error(400, "Invalid schema for response_format 'ess_classify_email'"), GOOD])
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD
    first, second = eng._transport.requests
    assert first.json_mode is False and first.schema is not None
    assert second.json_mode is True and second.schema is None and "JSON SCHEMA:" in second.system
    assert eng.describe()["structured_output_mode"] == "json_mode"


def test_model_refusal_raises_model_declined():
    eng = engine(items=[ProviderResponse(text="", finish_reason="refusal", refusal="policy")])
    with pytest.raises(ModelDeclined):
        eng.complete_json("sys", "user", SCHEMA, task="classify_email")


def test_answer_from_another_model_is_discarded():
    eng = AIEngine("openai", "gpt-5", api_key="k", policy=DEFAULT_POLICY, exam=exam_record("openai", "gpt-5"),
                   transport=ScriptedTransport([GOOD], served_model="gpt-4o-mini-2024-07-18"))
    with pytest.raises(RefusedByPolicy, match="instead of"):
        eng.complete_json("sys", "user", SCHEMA, task="classify_email")


def test_dated_snapshot_of_the_same_model_is_accepted():
    eng = AIEngine("openai", "gpt-5", api_key="k", policy=DEFAULT_POLICY, exam=exam_record("openai", "gpt-5"),
                   transport=ScriptedTransport([GOOD], served_model="gpt-5-2025-08-07"))
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD


def test_snapshot_change_after_qualification_requires_requalification():
    record = exam_record("openai", "gpt-5", served_models=["gpt-5-2025-08-07"])
    eng = AIEngine("openai", "gpt-5", api_key="k", policy=DEFAULT_POLICY, exam=record,
                   transport=ScriptedTransport([GOOD], served_model="gpt-5-2026-03-01"))
    with pytest.raises(RefusedByPolicy, match="re-run the qualification"):
        eng.complete_json("sys", "user", SCHEMA, task="classify_email")


def test_azure_deployment_is_evaluated_as_the_model_behind_it():
    from ess.ai.registry import register_azure_deployments

    register_azure_deployments({"chat-main": "gpt-5", "chat-cheap": "gpt-4o-mini"}, persist=False)
    eng = AIEngine("azure_openai", "chat-main", api_key="k", base_url="https://res.openai.azure.com",
                   policy=DEFAULT_POLICY, exam=exam_record("azure_openai", "chat-main"),
                   transport=ScriptedTransport([GOOD], served_model="gpt-5-2025-08-07"))
    assert eng.spec.tier == "frontier" and eng.spec.canonical_id == "gpt-5" and eng._api_model() == "chat-main"
    assert eng.complete_json("sys", "user", SCHEMA, task="extract_request") == GOOD
    with pytest.raises(RefusedByPolicy):
        AIEngine("azure_openai", "chat-cheap", api_key="k", base_url="https://res.openai.azure.com",
                 policy=DEFAULT_POLICY, exam=exam_record("azure_openai", "chat-cheap"), transport=ScriptedTransport([]))
    declared = AIEngine("azure_openai", "team-deploy", api_key="k", base_url="https://res.openai.azure.com",
                        extra={"model": "o3"}, policy=DEFAULT_POLICY, exam=exam_record("azure_openai", "team-deploy"),
                        transport=ScriptedTransport([GOOD], served_model="gpt-4o-mini"))
    assert declared.spec.canonical_id == "o3"
    with pytest.raises(RefusedByPolicy, match="instead of"):  # the deployment does not serve what it claims
        declared.complete_json("sys", "user", SCHEMA, task="classify_email")


def test_rejected_optional_parameter_is_dropped_and_retried():
    eng = engine("openai", "gpt-4.1", items=[
        http_error(400, "Unsupported value: 'temperature' does not support 0 with this model."), GOOD, GOOD])
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email", temperature=0) == GOOD
    first, second = eng._transport.requests
    assert first.temperature == 0 and second.temperature is None
    eng.complete_json("sys", "user", SCHEMA, task="classify_email", temperature=0)
    assert eng._transport.requests[-1].temperature is None  # remembered for this engine
    eng2 = engine("anthropic", "claude-opus-4-8", items=[
        http_error(400, "thinking.type.adaptive is not supported for this model"), GOOD])
    eng2.complete_json("sys", "user", SCHEMA, task="classify_email", effort="high")
    assert eng2._transport.requests[0].hints["thinking"] == "adaptive"
    assert eng2._transport.requests[1].hints["thinking"] == "omit"


def test_images_must_be_png_or_jpeg_and_small():
    eng = engine(items=[GOOD, GOOD])
    with pytest.raises(ValueError, match="PNG or JPEG"):
        eng.complete_json("sys", "user", SCHEMA, images=[b"GIF89a...."], task="analyze_drawing")
    with pytest.raises(ValueError, match="exceeds"):
        eng.complete_json("sys", "user", SCHEMA, images=[b"\x89PNG\r\n\x1a\n" + b"0" * (6 * 1024 * 1024)],
                          task="analyze_drawing")
    assert eng.complete_json("sys", "user", SCHEMA, images=[b"\xff\xd8\xff\xe0jpeg"], task="analyze_drawing") == GOOD
    assert eng._transport.requests[-1].images[0][1] == "image/jpeg"


def test_input_is_never_truncated_silently():
    eng = engine("anthropic", "claude-haiku-4-5", items=[GOOD])  # 200k context
    with pytest.raises(InputTooLarge):
        eng.complete_json("sys", "x" * 700_000, SCHEMA, task="classify_email")
    assert eng._transport.requests == []


def test_user_content_parts_are_supported():
    eng = engine(items=[GOOD])
    eng.complete_json("sys", [{"type": "text", "text": "part one"}, {"type": "image", "data": b"\x89PNG\r\n\x1a\nxx"},
                              {"type": "text", "text": "part two"}], SCHEMA, task="analyze_drawing")
    req = eng._transport.requests[0]
    assert req.user == "part one\n\npart two" and len(req.images) == 1


def test_request_parameters_follow_the_model():
    eng = engine("anthropic", "claude-opus-5-5", items=[GOOD])
    eng.complete_json("sys", "user", SCHEMA, task="classify_email", temperature=0, effort="low")
    req = eng._transport.requests[0]
    assert req.temperature is None  # current Claude models reject sampling parameters
    assert req.effort == "low" and req.max_tokens == 4000 + 8000  # thinking headroom
    assert req.schema["additionalProperties"] is False
    eng41 = engine("openai", "gpt-4.1", items=[GOOD])
    eng41.complete_json("sys", "user", SCHEMA, task="classify_email", temperature=0)
    assert eng41._transport.requests[0].temperature == 0


def test_provider_schema_is_strict_compatible():
    schema = {"type": "object", "properties": {"a": {"type": "string", "minLength": 3, "format": "date"},
                                               "b": {"type": "array", "maxItems": 2, "items": {
                                                   "type": "object", "properties": {"c": {"type": "number",
                                                                                          "minimum": 0}}}}}}
    ps = provider_schema(schema)
    assert ps["required"] == ["a", "b"] and ps["additionalProperties"] is False
    assert "minLength" not in ps["properties"]["a"] and "format" not in ps["properties"]["a"]
    inner = ps["properties"]["b"]["items"]
    assert inner["required"] == ["c"] and "minimum" not in inner["properties"]["c"] and "maxItems" not in ps["properties"]["b"]
    assert schema["properties"]["a"]["minLength"] == 3  # original untouched


def test_describe_reports_model_and_eligibility_without_the_key():
    d = engine(items=[]).describe()
    assert d["provider"] == "anthropic" and d["model"] == "claude-opus-5-5" and d["tier"] == "frontier"
    assert d["api_key_set"] is True and "test" not in json.dumps(d)
    assert d["eligibility"]["status"] == "eligible" and d["capabilities"]["structured_output"] is True
    az = AIEngine("azure_openai", "gpt-5", api_key="k", base_url="https://res.openai.azure.com",
                  extra={"deployment": "prod-gpt5", "api_version": "2024-10-21"}, policy=DEFAULT_POLICY,
                  exam=exam_record("azure_openai", "gpt-5"), transport=ScriptedTransport([]))
    assert az.describe()["deployment"] == "prod-gpt5" and az._api_model() == "prod-gpt5"


# ============================================================================ policy gate on every call

@pytest.mark.parametrize("provider, model", [
    ("openai", "gpt-5-mini"), ("openai", "gpt-5-nano"), ("openai", "gpt-4o-mini"), ("openai", "o4-mini"),
    ("openai", "gpt-3.5-turbo"), ("openai", "gpt-3.5-turbo-instruct"), ("openai", "text-embedding-3-large"),
    ("openai", "whisper-1"), ("openai", "tts-1"), ("openai", "dall-e-3"), ("openai", "gpt-4o-realtime-preview"),
    ("openai", "omni-moderation-latest"), ("openai", "gpt-4o-search-preview"), ("openai", "computer-use-preview"),
    ("openai", "davinci-002"), ("openai", "chatgpt-4o-latest"), ("openai", "o3-deep-research"),
    ("google", "gemini-2.5-flash-lite"), ("google", "gemini-2.0-flash"), ("google", "gemini-1.5-pro"),
    ("google", "gemini-embedding-001"), ("anthropic", "claude-3-haiku-20240307"), ("anthropic", "claude-opus-4-1"),
    ("openai_compatible", "openrouter/auto"), ("openai_compatible", "openai/gpt-5:free"),
    ("openai_compatible", "meta-llama/llama-3.1-8b-instruct"),
])
def test_refused_models_cannot_even_be_constructed(provider, model):
    with pytest.raises(RefusedByPolicy):
        AIEngine(provider, model, api_key="k", base_url="https://gw.example/v1", policy=DEFAULT_POLICY,
                 exam=exam_record(provider, model), transport=ScriptedTransport([GOOD]))


def test_no_bypass_parameter_exists():
    params = set(inspect.signature(AIEngine.__init__).parameters) | set(inspect.signature(AIEngine.complete_json).parameters)
    assert not params & {"bypass", "force", "skip_policy", "unsafe", "override", "allow_refused", "ignore_policy"}


def test_unqualified_model_is_refused_on_every_call():
    eng = engine(items=[GOOD], exam=None)
    assert eng.eligibility().status == "needs_evaluation"
    with pytest.raises(RefusedByPolicy, match="needs_evaluation"):
        eng.complete_json("sys", "user", SCHEMA, task="classify_email")
    assert eng._transport.requests == []


def test_exam_session_only_admits_the_registered_exam_prompts():
    eng = engine(items=[GOOD], exam=None)
    with exam_session(eng, ["exam prompt"]):
        with pytest.raises(RefusedByPolicy):
            eng.complete_json("sys", "real customer mail", SCHEMA, task="classify_email")
        assert eng.complete_json("sys", "exam prompt", SCHEMA, task="draft_quotation") == GOOD


def test_standard_model_may_classify_but_never_run_critical_tasks():
    eng = engine("openai", "gpt-4.1", items=[GOOD, GOOD])
    assert eng.complete_json("sys", "user", SCHEMA, task="classify_email") == GOOD
    for task in sorted(CRITICAL_TASKS):
        with pytest.raises(RefusedByPolicy, match="frontier models only"):
            eng.complete_json("sys", "user", SCHEMA, task=task)


def test_unknown_or_missing_task_is_treated_as_critical():
    eng = engine("openai", "gpt-4.1", items=[GOOD])
    with pytest.raises(RefusedByPolicy):
        eng.complete_json("sys", "user", SCHEMA)
    with pytest.raises(RefusedByPolicy):
        eng.complete_json("sys", "user", SCHEMA, task="summarise_everything")


def test_images_need_proven_vision():
    eng = AIEngine("openai_compatible", "qwen/qwen3-235b-a22b", base_url="https://gw.example/v1",
                   policy=DEFAULT_POLICY, exam=exam_record("openai_compatible", "qwen/qwen3-235b-a22b",
                                                           tasks=["classify_email"]),
                   transport=ScriptedTransport([GOOD]))
    with pytest.raises(RefusedByPolicy, match="analyze_drawing"):
        eng.complete_json("sys", "user", SCHEMA, images=[b"\x89PNG\r\n\x1a\nxx"], task="classify_email")


def test_policy_and_exam_are_read_from_the_store_by_default():
    from ess.ai import store

    eng = AIEngine("google", "gemini-2.5-pro", api_key="k", transport=ScriptedTransport([GOOD]))
    assert eng.eligibility("classify_email").status == "needs_evaluation"
    store.save_exam(exam_record("google", "gemini-2.5-pro"))
    assert eng.eligibility("classify_email").status == "eligible"
    store.save_policy(Policy(blocked_patterns=["gemini-2.5-*"]))
    try:
        assert eng.eligibility("classify_email").status == "refused"
    finally:
        store.save_policy(Policy())


# ============================================================================ policy decisions

def spec(provider, model):
    return get_spec(provider, model)


def test_light_models_are_refused_even_with_a_perfect_exam():
    for provider, model in [("openai", "gpt-5-mini"), ("openai", "gpt-5-nano"), ("google", "gemini-2.5-flash-lite"),
                            ("openai", "gpt-4.1-nano")]:
        for task in TASKS:
            res = evaluate_model(spec(provider, model), DEFAULT_POLICY, exam_record(provider, model), task)
            assert res.status == "refused" and any("light" in r for r in res.reasons)


def test_frontier_model_needs_the_exam_then_is_eligible_everywhere():
    s = spec("anthropic", "claude-opus-5-5")
    assert evaluate_model(s, DEFAULT_POLICY, None, "draft_quotation").status == "needs_evaluation"
    res = evaluate_model(s, DEFAULT_POLICY, exam_record("anthropic", "claude-opus-5-5"))
    assert res.status == "eligible" and set(res.allowed_tasks) == set(TASKS)


def test_unknown_model_starts_needs_evaluation_and_stays_out_of_critical_tasks():
    s = spec("openai", "gpt-5.5")
    assert s.source == "rules" and s.tier == "standard" and s.needs_evaluation
    assert evaluate_model(s, DEFAULT_POLICY, None, "classify_email").status == "needs_evaluation"
    record = exam_record("openai", "gpt-5.5")
    assert evaluate_model(s, DEFAULT_POLICY, record, "classify_email").status == "eligible"
    assert evaluate_model(s, DEFAULT_POLICY, record, "extract_request").status == "refused"


def test_admin_promotion_requires_full_exam_at_095():
    s = spec("openai", "gpt-6-astra")
    pol = Policy(promoted_models=["openai:gpt-6-astra"])
    high = exam_record("openai", "gpt-6-astra", score=0.97)
    assert evaluate_model(s, pol, high, "draft_quotation").status == "eligible"
    low = exam_record("openai", "gpt-6-astra", score=0.92)
    res = evaluate_model(s, pol, low, "draft_quotation")
    assert res.status == "refused" and any("promotion not applied" in w for w in res.warnings)
    partial = exam_record("openai", "gpt-6-astra", score=0.99, tasks=["classify_email", "extract_request"])
    assert evaluate_model(s, pol, partial, "extract_request").status == "refused"


def test_light_and_refused_models_can_never_be_promoted_or_allowed():
    pol = Policy(promoted_models=["openai:gpt-5.4-mini", "openai:text-embedding-3-large"],
                 allowed_tiers={t: ["frontier", "standard", "light", "refused"] for t in TASKS})
    for model in ("gpt-5.4-mini", "text-embedding-3-large"):
        for task in TASKS:
            assert evaluate_model(spec("openai", model), pol, exam_record("openai", model, score=1.0),
                                  task).status == "refused"


def test_policy_cannot_go_below_the_hard_floor():
    weak = Policy(min_score=0.5, max_exam_age_days=365, min_context_tokens=8000, required_capabilities=[],
                  task_capabilities={}, allowed_tiers={t: ["frontier", "standard", "light"] for t in TASKS})
    eff = weak.effective()
    assert eff.min_score == MIN_SCORE_FLOOR and eff.max_exam_age_days == 30 and eff.min_context_tokens == MIN_CONTEXT_FLOOR
    assert eff.required_capabilities == ["structured_output"] and eff.task_capabilities["analyze_drawing"] == ["vision"]
    assert all(eff.allowed_tiers[t] == ["frontier"] for t in CRITICAL_TASKS)
    assert eff.allowed_tiers["classify_email"] == ["frontier", "standard"]
    assert len(weak.violations()) >= 6
    with pytest.raises(PolicyError):
        Policy.from_dict(weak.to_dict() | {"max_critical_failures": 2}, strict=True)
    s = spec("anthropic", "claude-opus-5-5")
    assert evaluate_model(s, weak, exam_record("anthropic", "claude-opus-5-5", score=0.85, passed=True),
                          "classify_email").status == "failed_evaluation"
    with pytest.raises(PolicyError):
        from ess.ai import store
        store.save_policy({"min_score": 0.8})


def test_admins_can_tighten_the_policy():
    s = spec("anthropic", "claude-sonnet-5-5")
    record = exam_record("anthropic", "claude-sonnet-5-5", score=0.93)
    assert evaluate_model(s, DEFAULT_POLICY, record, "extract_request").status == "eligible"
    assert evaluate_model(s, Policy(min_score=0.95), record, "extract_request").status == "failed_evaluation"
    assert evaluate_model(s, Policy(blocked_patterns=["claude-sonnet-*"]), record).status == "refused"
    assert evaluate_model(s, Policy(blocked_patterns=["re:sonnet-5"]), record).status == "refused"
    assert evaluate_model(s, Policy(blocked_providers=["anthropic"]), record).status == "refused"
    assert evaluate_model(s, Policy(allowed_tiers={"classify_email": ["frontier"]}), record).status == "eligible"
    stale = exam_record("anthropic", "claude-sonnet-5-5", days_old=10)
    assert evaluate_model(s, Policy(max_exam_age_days=7), stale, "classify_email").status == "needs_evaluation"
    pol = Policy.from_dict({"min_score": 0.97, "blocked_patterns": ["*preview*"]}, strict=True)
    assert pol.violations() == []


def test_exam_validity_rules():
    s = spec("google", "gemini-2.5-pro")
    ok = exam_record("google", "gemini-2.5-pro")
    assert evaluate_model(s, DEFAULT_POLICY, ok, "analyze_drawing").status == "eligible"
    assert evaluate_model(s, DEFAULT_POLICY, exam_record("google", "gemini-2.5-pro", days_old=31)).status == "needs_evaluation"
    assert evaluate_model(s, DEFAULT_POLICY, exam_record("google", "gemini-2.5-pro", days_old=-1)).status == "needs_evaluation"
    assert evaluate_model(s, DEFAULT_POLICY, exam_record("google", "gemini-2.5-pro", exam_version="old")).status == "needs_evaluation"
    assert evaluate_model(s, DEFAULT_POLICY, exam_record("google", "gemini-2.5-flash")).status == "needs_evaluation"
    crit = exam_record("google", "gemini-2.5-pro", score=0.97, critical_failures=[{"case": "C11", "check": "no prices"}])
    res = evaluate_model(s, DEFAULT_POLICY, crit, "classify_email")
    assert res.status == "failed_evaluation" and "critical failure" in res.reasons[0]
    partial = exam_record("google", "gemini-2.5-pro", tasks=["classify_email"])
    assert evaluate_model(s, DEFAULT_POLICY, partial, "classify_email").status == "eligible"
    assert evaluate_model(s, DEFAULT_POLICY, partial, "extract_request").status == "needs_evaluation"
    failed_drawing = exam_record("google", "gemini-2.5-pro", failed_cases={"analyze_drawing": 1})
    res = evaluate_model(s, DEFAULT_POLICY, failed_drawing)
    assert res.status == "eligible" and "analyze_drawing" not in res.allowed_tasks
    assert evaluate_model(s, DEFAULT_POLICY, failed_drawing, "analyze_drawing").status == "needs_evaluation"


def test_hand_made_or_tampered_exam_records_are_ignored():
    s = spec("anthropic", "claude-opus-5-5")
    assert evaluate_model(s, DEFAULT_POLICY, exam_record("anthropic", "claude-opus-5-5"), "draft_quotation").status == "eligible"
    unsigned = exam_record("anthropic", "claude-opus-5-5", signed=False)
    res = evaluate_model(s, DEFAULT_POLICY, unsigned, "draft_quotation")
    assert res.status == "needs_evaluation" and "signature" in res.reasons[0]
    tampered = exam_record("anthropic", "claude-opus-5-5", score=0.5, passed=False)
    tampered.update(score=1.0, passed=True)
    assert evaluate_model(s, DEFAULT_POLICY, tampered, "draft_quotation").status == "needs_evaluation"
    foreign = exam_record("anthropic", "claude-opus-5-5")
    foreign["signature"] = "0" * 64  # signed elsewhere / forged
    assert evaluate_model(s, DEFAULT_POLICY, foreign).status == "needs_evaluation"
    stored = json.loads(json.dumps(exam_record("anthropic", "claude-opus-5-5")))  # DB/JSON round-trip keeps it valid
    stored["cases"] = [{"trimmed": True}]  # details may be trimmed for storage
    assert evaluate_model(s, DEFAULT_POLICY, stored, "draft_quotation").status == "eligible"


def test_capability_requirements():
    base = spec("anthropic", "claude-opus-5-5")
    from dataclasses import replace

    small = replace(base, capabilities=Capabilities(structured_output=True, vision=True, context_tokens=32_000))
    assert evaluate_model(small, DEFAULT_POLICY, exam_record("anthropic", "claude-opus-5-5")).status == "refused"
    no_so = replace(base, capabilities=Capabilities(structured_output=False, vision=True, context_tokens=1_000_000))
    assert evaluate_model(no_so, DEFAULT_POLICY, exam_record("anthropic", "claude-opus-5-5")).status == "refused"
    blind = replace(base, capabilities=Capabilities(structured_output=True, vision=False, context_tokens=1_000_000))
    record = exam_record("anthropic", "claude-opus-5-5")
    assert evaluate_model(blind, DEFAULT_POLICY, record, "analyze_drawing").status == "refused"
    assert evaluate_model(blind, DEFAULT_POLICY, record, "extract_request").status == "eligible"
    deprecated = replace(base, deprecated=True)
    assert evaluate_model(deprecated, DEFAULT_POLICY, record).status == "refused"


def test_enforce_floor_returns_what_will_actually_be_enforced():
    from ess.ai.policy import enforce_floor

    clamped = enforce_floor({"min_score": 0.4, "allowed_tiers": {"draft_quotation": ["light"]},
                             "blocked_patterns": ["*-preview"]})
    assert clamped.min_score == MIN_SCORE_FLOOR and clamped.allowed_tiers["draft_quotation"] == []
    assert clamped.blocked_patterns == ["*-preview"] and clamped.violations() == []
    stored = DEFAULT_POLICY.to_dict()  # what the workspace settings keep
    assert Policy.from_dict(stored, strict=True).effective().to_dict() == stored


def test_policy_json_roundtrip():
    pol = Policy(min_score=0.95, blocked_patterns=["*preview*"], promoted_models=["openai:gpt-5.5"])
    again = Policy.from_dict(json.loads(json.dumps(pol.to_dict())), strict=True)
    assert again.effective().to_dict() == pol.effective().to_dict()
    with pytest.raises(PolicyError, match="unknown policy key"):
        Policy.from_dict({"disable_policy": True}, strict=True)


def test_eligibility_table_orders_rows():
    rows = eligibility_table([spec("openai", "gpt-5-mini"), spec("anthropic", "claude-opus-5-5")],
                             DEFAULT_POLICY, {"anthropic:claude-opus-5-5": exam_record("anthropic", "claude-opus-5-5")})
    assert [r["model_id"] for r in rows] == ["claude-opus-5-5", "gpt-5-mini"]
    assert rows[0]["eligibility"]["status"] == "eligible" and rows[1]["eligibility"]["status"] == "refused"


# ============================================================================ registry

@pytest.mark.parametrize("provider, model, tier, rule", [
    ("openai", "text-embedding-3-small", "refused", "non_chat_modality"),
    ("openai", "gpt-4o-mini-tts", "refused", "non_chat_modality"),
    ("openai", "gpt-4o-transcribe", "refused", "non_chat_modality"),
    ("openai", "gpt-realtime", "refused", "non_chat_modality"),
    ("openai", "gpt-image-1", "refused", "non_chat_modality"),
    ("openai", "gpt-audio-mini", "refused", "non_chat_modality"),
    ("openai", "omni-moderation-2024-09-26", "refused", "non_chat_modality"),
    ("openai", "gpt-5-search-api", "refused", "non_chat_modality"),
    ("google", "gemini-2.5-computer-use-preview-10-2025", "refused", "non_chat_modality"),
    ("google", "imagen-4.0-generate-001", "refused", "non_chat_modality"),
    ("openai", "gpt-5.1-codex", "refused", "code_specialised"),
    ("openai", "o4-mini-deep-research", "refused", "autonomous_research"),
    ("openai", "gpt-5.3-chat-latest", "refused", "moving_alias"),
    ("openai_compatible", "meta-llama/llama-4-maverick:free", "refused", "free_or_online_variant"),
    ("google", "gemini-exp-1206", "refused", "experimental"),
    ("openai", "gpt-5.4-mini", "light", "light_model"),
    ("openai", "gpt-5.4-nano", "light", "light_model"),
    ("google", "gemini-3-flash-lite-preview", "light", "light_model"),
    ("anthropic", "claude-3-5-haiku-latest", "refused", "moving_alias"),
    ("openai_compatible", "mistralai/mistral-small-3.2", "light", "light_model"),
    ("openai_compatible", "qwen/qwen3-8b", "light", "light_model"),
    ("openai_compatible", "meta-llama/llama-3.2-3b-instruct", "light", "light_model"),
    ("openai_compatible", "tinyllama/tiny-chat", "light", "light_model"),
    ("openai", "gpt-5.5", "standard", "unknown_model"),
    ("openai", "gpt-6-astra", "standard", "unknown_model"),
    ("google", "gemini-3.5-pro", "standard", "unknown_model"),
    ("anthropic", "claude-opus-6", "standard", "unknown_model"),
])
def test_unknown_ids_are_classified_by_rules(provider, model, tier, rule):
    s = get_spec(provider, model)
    assert (s.tier, s.rule, s.source) == (tier, rule, "rules")
    assert s.needs_evaluation is True


def test_curated_entries_and_aliases():
    r = load_registry()
    assert get_spec("anthropic", "claude-opus-5-5").tier == "frontier"
    assert get_spec("anthropic", "claude-fable-5-1").tier == "frontier"
    assert get_spec("anthropic", "claude-sonnet-5-5").tier == "frontier"
    haiku = get_spec("anthropic", "claude-haiku-4-5-20251001")
    assert haiku.tier == "standard" and haiku.canonical_id == "claude-haiku-4-5" and haiku.source == "curated"
    assert get_spec("openai", "gpt-5-2025-08-07").canonical_id == "gpt-5"
    assert get_spec("openai", "gpt-4.1").tier == "standard" and get_spec("openai", "gpt-4o").tier == "standard"
    assert get_spec("openai", "o3").tier == "frontier" and get_spec("openai", "o4-mini").tier == "light"
    assert get_spec("google", "gemini-2.5-pro").tier == "frontier"
    assert get_spec("google", "gemini-2.5-flash").tier == "standard"
    assert get_spec("azure_openai", "gpt-35-turbo").tier == "refused"
    via = get_spec("openai_compatible", "anthropic/claude-opus-4.5")
    assert via.canonical_id == "claude-opus-4-5" and via.provider == "openai_compatible"
    assert r.same_model("openai", "gpt-5", "gpt-5-2025-08-07") and not r.same_model("openai", "gpt-5", "gpt-5-mini")
    assert all(s.capabilities.structured_output is not None for s in r.all())


def test_registry_rejects_bad_entries():
    with pytest.raises(ValueError, match="invalid tier"):
        parse_registry({"models": [{"provider": "openai", "id": "x", "tier": "super"}]})
    with pytest.raises(ValueError, match="duplicate"):
        parse_registry({"models": [{"provider": "openai", "id": "x", "tier": "standard"},
                                   {"provider": "openai", "id": "y", "aliases": ["x"], "tier": "standard"}]})
    with pytest.raises(ValueError):
        get_spec("unknown-provider", "unknown-model")


def test_classify_unknown_uses_remote_metadata():
    s = classify_unknown("openai_compatible", "deepseek/deepseek-v4",
                         {"context_tokens": 163_840, "vision": False, "structured_output": True})
    assert s.capabilities.context_tokens == 163_840 and s.capabilities.vision is False
    record = exam_record("openai_compatible", "deepseek/deepseek-v4")
    assert evaluate_model(s, DEFAULT_POLICY, record, "classify_email").status == "eligible"
    assert evaluate_model(s, DEFAULT_POLICY, record, "analyze_drawing").status == "refused"
