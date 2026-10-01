"""Qualification exam: a perfect model passes, a sloppy model fails with critical failures."""
from __future__ import annotations

import copy

import pytest

from ess.ai import store
from ess.ai.engine import AIEngine, ProviderResponse
from ess.ai.errors import AuthError, RefusedByPolicy
from ess.ai.exam_cases import EXAM_CASES, EXAM_VERSION, golden_answer, select_cases
from ess.ai.policy import DEFAULT_POLICY, TASKS, Policy, evaluate_model
from ess.ai.qualification import exam_requests, run_qualification, score_external_exam, self_check
from ess.ai.testing import GoldenTransport, ScriptedTransport, SloppyTransport, http_error


def make_engine(transport, provider="anthropic", model="claude-opus-5-5", **kwargs) -> AIEngine:
    return AIEngine(provider, model, api_key="test", transport=transport, policy=DEFAULT_POLICY, exam=None, **kwargs)


def test_exam_has_at_least_14_cases_covering_every_task_and_trap():
    assert len(EXAM_CASES) >= 14
    assert {c.task for c in EXAM_CASES} == set(TASKS)
    ids = " ".join(c.id for c in EXAM_CASES)
    for topic in ("bmu_tender", "wce_monorail_ar", "vendor_pitch", "invoice", "newsletter", "deadline_extension",
                  "addendum", "missing_information", "price_trap", "evidence_trap", "drawing", "boq", "mixed_scope"):
        assert topic in ids
    assert all(any(k.critical for k in c.checks) for c in EXAM_CASES)
    assert EXAM_VERSION.startswith("ess-exam-1.")


def test_exam_material_uses_invented_parties_only():
    import json
    import re

    blob = json.dumps([c.inputs() if not c.needs_vision else {} for c in EXAM_CASES], ensure_ascii=False)
    domains = set(re.findall(r"@([a-z0-9.-]+)", blob)) | set(re.findall(r"https?://([a-z0-9.-]+)", blob))
    assert domains and all(d.endswith(".example") or d == "medmack.com" for d in domains), domains


def test_golden_answers_pass_every_check():
    for result in self_check():
        assert result["passed"] and result["score"] == 1.0, result


def test_perfect_model_passes_and_becomes_eligible():
    eng = make_engine(GoldenTransport())
    progress = []
    result = run_qualification(eng, save=False, progress=lambda i, n, entry: progress.append((i, n, entry["id"])))
    assert result["passed"] is True and result["score"] == 1.0 and result["critical_failures"] == []
    assert len(result["cases"]) == len(EXAM_CASES) and len(progress) == len(EXAM_CASES)
    assert {"model", "provider", "score", "passed", "critical_failures", "cases", "ran_at"} <= set(result)
    assert all({"id", "task", "passed", "details"} <= set(c) for c in result["cases"])
    assert result["exam_version"] == EXAM_VERSION and set(result["tasks"]) == set(TASKS)
    assert result["served_models"] == ["claude-opus-5-5"] and result["usage"]["calls"] == len(EXAM_CASES)
    # pinned on the engine: production calls are now allowed
    res = eng.eligibility()
    assert res.status == "eligible" and set(res.allowed_tasks) == set(TASKS)


def test_sloppy_model_fails_with_critical_failures():
    eng = make_engine(SloppyTransport())
    result = run_qualification(eng, save=False)
    assert result["passed"] is False and result["score"] < 0.9
    failed_checks = {(f["case"], f["check"]) for f in result["critical_failures"]}
    failed_cases = {case for case, _ in failed_checks}
    for case_id in ("C05_vendor_pitch", "C06_invoice", "C07_newsletter", "C08_deadline_extension",
                    "C10_missing_information", "C11_price_trap", "C12_evidence_trap", "C14_boq_snippet",
                    "C16_customer_research", "C17_business_discovery", "C18_drawing_image"):
        assert case_id in failed_cases, case_id
    assert ("C11_price_trap", "no prices produced") in failed_checks
    assert ("C12_evidence_trap", "no fabricated or paraphrased quotes") in failed_checks
    # the guessed height is removed from the output by the guard, and the attempt is a critical failure
    assert ("C18_drawing_image", "no value reported without transcription") in failed_checks
    drawing = next(c for c in result["cases"] if c["id"] == "C18_drawing_image")
    assert next(d for d in drawing["details"] if d["check"] == "hidden building height left null")["passed"]
    res = evaluate_model(eng.spec, DEFAULT_POLICY, result, "classify_email")
    assert res.status == "failed_evaluation"
    with pytest.raises(RefusedByPolicy):
        eng.complete_json("s", "real mail", {"type": "object", "properties": {}}, task="classify_email")


def test_a_single_non_critical_miss_still_passes():
    class AlmostPerfect(GoldenTransport):
        def answer(self, case_id, golden):
            data = copy.deepcopy(golden)
            if case_id == "C02_bmu_tender_extract":
                data["work_type"] = {"value": None, "evidence": None}
            return data

    result = run_qualification(make_engine(AlmostPerfect()), save=False)
    assert result["passed"] is True and 0.9 <= result["score"] < 1.0 and result["critical_failures"] == []


def test_invalid_json_twice_is_a_critical_failure_of_the_case():
    class Broken(GoldenTransport):
        def __call__(self, req):
            if "Faisal" in req.user:  # C10
                return ProviderResponse(text="I think the due date is next week", served_model=req.model)
            return super().__call__(req)

    result = run_qualification(make_engine(Broken()), save=False)
    case = next(c for c in result["cases"] if c["id"] == "C10_missing_information")
    assert case["passed"] is False and case["details"][0]["check"] == "invalid_output"
    assert result["passed"] is False


def test_auth_error_aborts_the_exam_without_a_record():
    eng = make_engine(ScriptedTransport([http_error(401, "invalid api key")]), model="claude-opus-4-8")
    with pytest.raises(AuthError):
        run_qualification(eng, save=True)
    assert store.latest_exam("anthropic", "claude-opus-4-8") is None


def test_refused_model_cannot_take_the_exam():
    eng = AIEngine("anthropic", "claude-haiku-4-5", api_key="t", transport=GoldenTransport(), exam=None,
                   policy=DEFAULT_POLICY)
    with pytest.raises(RefusedByPolicy):
        run_qualification(eng, policy=Policy(blocked_patterns=["claude-haiku-*"]), save=False)


def test_standard_model_can_qualify_for_classification_only():
    eng = make_engine(GoldenTransport(), provider="openai", model="gpt-4.1")
    result = run_qualification(eng, tasks=["classify_email"], save=False)
    assert result["passed"] and result["tasks"] == ["classify_email"] and len(result["cases"]) == 5
    assert eng.eligibility("classify_email").status == "eligible"
    assert eng.eligibility("extract_request").status == "refused"


def test_unknown_model_full_exam_then_admin_promotion():
    eng = make_engine(GoldenTransport(), provider="openai", model="gpt-5.5")
    result = run_qualification(eng, save=False)
    pol = Policy(promoted_models=["openai:gpt-5.5"])
    assert evaluate_model(eng.spec, DEFAULT_POLICY, result, "draft_quotation").status == "refused"
    assert evaluate_model(eng.spec, pol, result, "draft_quotation").status == "eligible"


def test_model_without_vision_skips_the_image_case():
    cases = select_cases(vision=False)
    assert all(not c.needs_vision for c in cases) and len(cases) == len(EXAM_CASES) - 1
    assert "analyze_drawing" not in {c.task for c in cases}


def test_exam_result_is_saved_and_read_back_by_new_engines():
    eng = make_engine(GoldenTransport(), provider="google", model="gemini-3-pro-preview")
    run_qualification(eng, save=True)
    fresh = AIEngine("google", "gemini-3-pro-preview", api_key="k", transport=GoldenTransport(),
                     policy=DEFAULT_POLICY)  # exam read from the local store
    assert fresh.eligibility("analyze_drawing").status == "eligible"
    assert store.exam_history("google", "gemini-3-pro-preview")[-1]["passed"] is True


def test_external_client_exam_over_mcp():
    requests = exam_requests()
    assert len(requests) == len(EXAM_CASES)
    assert all({"case_id", "system", "user", "schema", "images_base64"} <= set(r) for r in requests)
    assert "NON-NEGOTIABLE RULES" in requests[0]["system"]
    drawing = next(r for r in requests if r["task"] == "analyze_drawing")
    assert drawing["images_base64"] and drawing["images_base64"][0].startswith("iVBOR")  # PNG
    answers = {c.id: golden_answer(c.id) for c in EXAM_CASES}
    good = score_external_exam("anthropic", "claude-sonnet-5-5", answers, save=False)
    assert good["passed"] is True and good["mode"] == "external"
    answers.pop("C11_price_trap")
    answers["C05_vendor_pitch"]["is_customer_request"] = True
    bad = score_external_exam("anthropic", "claude-sonnet-5-5", answers, save=False)
    assert bad["passed"] is False and {f["case"] for f in bad["critical_failures"]} >= {"C11_price_trap",
                                                                                         "C05_vendor_pitch"}
    with pytest.raises(RefusedByPolicy):
        score_external_exam("openai", "gpt-5-nano", answers, save=False)
