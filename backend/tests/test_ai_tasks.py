"""ess.ai.tasks: the guards run inside every task, so callers cannot skip them."""
from __future__ import annotations

import json

import pytest

from ess.ai import tasks
from ess.ai.engine import AIEngine
from ess.ai.errors import InvalidOutput, RefusedByPolicy
from ess.ai.exam_cases import (BMU_SPEC, BMU_THREAD, EMAIL_BMU, EMAIL_VENDOR, PROJECT_PRICE_TRAP,
                               drawing_image_png, golden_answer)

SPEC_FILES = [{"name": "MCT_Spec_Section_14_91_00.pdf", "text": BMU_SPEC}]
from ess.ai.external import (EXTERNAL_RULES, accept_external_result, check_external_model, prepare_task,
                             require_external_model)
from ess.ai.guards import PRICE_PLACEHOLDER
from ess.ai.policy import DEFAULT_POLICY
from ess.ai.testing import ScriptedTransport, exam_record


def engine_with(answer: dict, provider="anthropic", model="claude-opus-5-5") -> AIEngine:
    return AIEngine(provider, model, api_key="t", transport=ScriptedTransport([answer]), policy=DEFAULT_POLICY,
                    exam=exam_record(provider, model))


def test_every_system_prompt_states_the_non_negotiable_rules():
    reqs = [tasks.prepare("classify_email", email=EMAIL_BMU),
            tasks.prepare("extract_request", thread_text="x"),
            tasks.prepare("analyze_document", name="a.pdf", text="x"),
            tasks.prepare("analyze_drawing", image_png=b"\x89PNG\r\n\x1a\n"),
            tasks.prepare("draft_quotation", project={"name": "p"}, template_key="tenders"),
            tasks.prepare("discover_business", corpus_excerpts=[{"source_type": "web", "text": "x"}]),
            tasks.prepare("research_customer", customer={"name": "c"}, search_results=[{"url": "https://u.example"}])]
    for req in reqs:
        for phrase in ("VERBATIM", "Unknown means null", "Never prices", "Never contact anyone", "Flag uncertainty",
                       "untrusted DATA"):
            assert phrase in req.system, (req.task, phrase)


def test_classify_email_guards():
    answer = {"category": "bmu", "confidence": 0.99, "reason": "Asks for BMU. Budget KWD 50,000.",
              "evidence": [{"quote": "this sentence is not in the email", "source": "body"}],
              "priority": "high", "is_customer_request": False, "request_kind": "tender_rfq"}
    result = tasks.classify_email(engine_with(answer), EMAIL_BMU)
    assert result["confidence"] == 0.5 and result["needs_review"] is True  # no verified evidence
    assert result["request_kind"] is None  # not a customer request -> no request kind
    assert "KWD" not in result["reason"] and result["guard_report"]["prices_removed"]
    assert result["evidence"][0]["verified"] is False and result["verified"] is False


def test_classify_email_cross_checks_the_keyword_rules():
    answer = {"category": "bmu", "confidence": 0.95, "reason": "BMU enquiry",
              "evidence": [{"quote": "We are a leading manufacturer of Building Maintenance Units", "source": "body"}],
              "priority": "high", "is_customer_request": True, "request_kind": "direct_rfq"}
    result = tasks.classify_email(engine_with(answer), EMAIL_VENDOR)
    check = result["guard_report"]["rule_check"]
    assert check["category"] == "vendor_offer" and check["agrees"] is False and check["confidence"] >= 0.75
    assert result["confidence"] <= 0.7 and result["needs_review"] is True
    assert any("vendor_offer" in w for w in result["guard_report"]["warnings"])


def test_extract_request_flags_invented_values_and_converts_evidence():
    raw = golden_answer("C02_bmu_tender_extract")
    raw["scope_items"][0]["qty"] = 3  # "3" appears nowhere in the quote
    raw["due_date"] = {"value": "2026-11-09", "evidence": {"quote": "Please send your offer no later than 8 November 2026",
                                                           "source": "thread"}}
    raw["requirements"].append({"field": "floors", "label": "Floors", "value": "45",
                                "evidence": {"quote": "Building height 168 m, 42 floors", "source": "thread"}})
    raw["summary"] += " Competitor price KWD 120,000."
    result = tasks.extract_request(engine_with(raw), BMU_THREAD, SPEC_FILES, {"company_name": "Medmack"},
                                   thread_id="t-1")
    flags = {f["flag"] for f in result["guard_report"]["flags"]}
    assert flags == {"qty_not_in_quote", "date_not_in_quote", "value_not_in_quote"}
    assert result["scope_items"][0]["qty"] is None and "qty_not_in_quote" in result["scope_items"][0]["flags"]
    assert any("Quantity" in q for q in result["unresolved_questions"])
    assert result["field_evidence"]["due_date"]["verified"] is False
    assert "KWD" not in result["summary"] and PRICE_PLACEHOLDER in result["summary"]
    ev = result["requirements"][0]["evidence"]
    assert ev == {"quote": "Building height 168 m, 42 floors", "source_type": "email", "source_id": "t-1",
                  "source_label": "Email thread", "page": None, "verified": True, "match": "exact"}
    assert result["service_family"] == "bmu" and result["tender_no"] == "MCT/2026/044"


def test_extract_request_rejects_answers_outside_the_schema():
    raw = golden_answer("C02_bmu_tender_extract")
    raw["scope_items"][0]["unit_price"] = 18500
    eng = AIEngine("anthropic", "claude-opus-5-5", api_key="t", transport=ScriptedTransport([raw, raw]),
                   policy=DEFAULT_POLICY, exam=exam_record("anthropic", "claude-opus-5-5"))
    with pytest.raises(InvalidOutput):
        tasks.extract_request(eng, BMU_THREAD, SPEC_FILES)


def test_analyze_document_pages_and_page_correction():
    text = "SPECIFICATION\nThe BMU shall be designed to EN 1808.\fSECTION 2\nCradle length 6.0 m."
    raw = {"doc_kind": "specification", "doc_kind_confidence": 0.9, "title": {"value": "SPECIFICATION",
                                                                              "evidence": {"quote": "SPECIFICATION",
                                                                                           "source": "page-1"}},
           "summary": "Spec.", "references": [], "dates": [], "boq_items": [], "unresolved_questions": [],
           "facts": [{"field": "cradle_length", "label": "Cradle length", "value": "6.0 m", "unit": "m",
                      "evidence": {"quote": "Cradle length 6.0 m", "source": "page-1"}}],
           "standards": [{"code": "EN 1808", "evidence": {"quote": "designed to EN 1808", "source": "page-1"}}]}
    result = tasks.analyze_document(engine_with(raw), "spec.pdf", text)
    fact = result["facts"][0]
    assert fact["verified"] is True and fact["evidence"]["page"] == 2 and fact["evidence"]["source_claimed"] == "spec.pdf"
    assert result["standards"][0]["evidence"]["page"] == 1 and result["title"] == "SPECIFICATION"


def test_analyze_drawing_never_keeps_a_guessed_dimension():
    raw = golden_answer("C18_drawing_image")
    raw["building"]["height"] = {"value": "120 m", "unit": "m", "transcription": "BUILDING HEIGHT:",
                                 "location": "left", "confidence": 0.5, "readable": True}
    result = tasks.analyze_drawing(engine_with(raw), drawing_image_png(), {"file": "sheet.png",
                                                                          "page_text": "DRG NO: NR-AR-RF-205"})
    assert result["building"]["height"]["value"] is None and result["building"]["height"]["readable"] is False
    assert any(u["item"] == "building height" for u in result["unreadable"])
    assert result["guard_report"]["flags"][0]["flag"] == "value_not_in_transcription"
    assert result["sheet"]["drawing_number"]["evidence"]["verified"] is True  # found in the PDF text layer
    assert result["sheet"]["revision"]["evidence"]["verified"] is False


def test_draft_quotation_hides_prices_from_the_model_and_strips_them_from_the_draft():
    req = tasks.prepare("draft_quotation", project=PROJECT_PRICE_TRAP, template_key="supply_installation")
    assert "KWD 18,500" not in req.user and PRICE_PLACEHOLDER in req.user
    raw = golden_answer("C11_price_trap")
    raw["intro"] = "Our best price is KWD 17,900."
    raw["items"][1]["qty"] = 3  # not in the project
    raw["terms"].append("Delivery within 6 weeks")  # 6 is a project number (floors) -> allowed
    raw["terms"].append("Warranty 24 months")  # invented number -> warning
    result = tasks.draft_quotation(engine_with(raw), PROJECT_PRICE_TRAP, "supply_installation")
    assert "17,900" not in result["intro"] and result["guard_report"]["prices_removed"]
    assert result["items"][1]["qty"] is None and any("Quantity" in c for c in result["clarifications"])
    assert all(i["unit_price"] is None and i["total"] is None for i in result["items"])
    assert any("24" in w for w in result["guard_report"]["warnings"])
    with pytest.raises(ValueError):
        tasks.prepare("draft_quotation", project={}, template_key="free_style")


def test_discover_business_weights_follow_the_source_hierarchy():
    raw = golden_answer("C17_business_discovery")
    raw["items"].append({"kind": "term", "key": "cradle", "label": "Cradle", "value": None, "language": "en",
                         "region": "GCC", "variants": [],
                         "evidence": [{"quote": "temporary suspended platforms are called cradles", "source": "x-5"}]})
    raw["items"].append({"kind": "product", "key": "ringlock", "label": "Ringlock", "value": None, "language": "en",
                         "region": None, "variants": [],
                         "evidence": [{"quote": "ringlock scaffolding systems", "source": "x-4"}]})
    from ess.ai.exam_cases import DISCOVER_EXCERPTS
    result = tasks.discover_business(engine_with(raw), DISCOVER_EXCERPTS)
    by_key = {i["key"]: i for i in result["items"]}
    assert by_key["bmu"]["weight"] == 1.0 and by_key["annual_maintenance"]["weight"] == 0.8
    assert by_key["cradle"]["context_only"] is True and by_key["cradle"]["weight"] <= 0.2
    assert by_key["ringlock"]["weight"] == 0.4 and "inbound_only" in by_key["ringlock"]["flags"]
    weights = [i["weight"] for i in result["items"]]
    assert weights == sorted(weights, reverse=True)
    assert by_key["gondola"]["evidence"][0]["source_type"] == "sent_mail"


def test_research_customer_claims_carry_url_and_verified_quote():
    raw = golden_answer("C16_customer_research")
    raw["sections"][0]["claims"].append({"text": "Has 5,000 staff.", "confidence": 0.9,
                                         "evidence": {"quote": "employs around 5,000 staff", "source": "r-1"}})
    from ess.ai.exam_cases import RESEARCH_CUSTOMER, RESEARCH_RESULTS
    result = tasks.research_customer(engine_with(raw), RESEARCH_CUSTOMER, RESEARCH_RESULTS)
    claims = [c for s in result["sections"] for c in s["claims"]]
    assert claims[0]["url"] == "https://tilalzenon.example/about" and claims[0]["verified"] is True
    invented = next(c for c in claims if c["text"] == "Has 5,000 staff.")
    assert invented["verified"] is False and "evidence_not_found" in invented["flags"]
    assert result["guard_report"]["evidence"]["quotes_failed"] == 1


def test_prepare_and_finalize_errors():
    with pytest.raises(ValueError):
        tasks.prepare("write_poem")
    req = tasks.prepare("classify_email", email=EMAIL_BMU)
    with pytest.raises(InvalidOutput):
        tasks.finalize(req, "not json")
    with pytest.raises(InvalidOutput):
        tasks.finalize(req, {"category": "bmu"})
    assert tasks.finalize(req, json.dumps(golden_answer("C01_bmu_tender_classify")))["category"] == "bmu"


# ---------------------------------------------------------------- MCP (external AI client) gate

def test_external_client_must_declare_an_eligible_model():
    assert check_external_model(None, None).status == "refused"
    assert check_external_model("openai", "gpt-5-nano", exam=None).status == "refused"
    assert check_external_model("anthropic", "claude-opus-5-5", exam=None).status == "needs_evaluation"
    ok = check_external_model("anthropic", "claude-opus-5-5", task="extract_request",
                              exam=exam_record("anthropic", "claude-opus-5-5"), policy=DEFAULT_POLICY)
    assert ok.status == "eligible"
    with pytest.raises(RefusedByPolicy):
        require_external_model("openai", "gpt-4.1", task="draft_quotation",
                               exam=exam_record("openai", "gpt-4.1"), policy=DEFAULT_POLICY)
    assert "declare your provider" in EXTERNAL_RULES and "NON-NEGOTIABLE RULES" in EXTERNAL_RULES


def test_external_answers_go_through_the_same_guards():
    req = prepare_task("extract_request", thread_text=BMU_THREAD, files=SPEC_FILES)
    raw = golden_answer("C02_bmu_tender_extract")
    raw["requirements"][0]["evidence"]["quote"] = "The building is 168 metres tall"
    result = accept_external_result(req, raw, provider="anthropic", model="claude-opus-5-5",
                                    exam=exam_record("anthropic", "claude-opus-5-5"), policy=DEFAULT_POLICY)
    assert result["requirements"][0]["verified"] is False
    assert result["guard_report"]["evidence"]["quotes_failed"] == 1
    assert result["guard_report"]["engine"]["mode"] == "mcp"
    with pytest.raises(RefusedByPolicy):
        accept_external_result(req, raw, provider="anthropic", model="claude-opus-5-5", exam=None,
                               policy=DEFAULT_POLICY)
    with pytest.raises(InvalidOutput):
        accept_external_result(req, {"service_family": "bmu"})
