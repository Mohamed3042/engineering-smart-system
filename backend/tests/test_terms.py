"""Requested quotation terms: detected with the customer's sentence, agreed only by a person."""
import pytest

from ess.pipeline.terms import decide_term_change, detect_term_requirements, open_term_requests, record_term_requests

MAIL = ("Dear Sir,\nPlease quote the works below.\n"
        "*2- We need a confirmation about the validity of your offers to be 120 days from closing date\n"
        "- Contract period: 36 months from site handover, with a client option to extend\n"
        "Scope: comprehensive O&M with spares for 36 months.\nRegards")


def _data():
    return {"terms": [{"key": "validity", "label": "Validity", "text": "One month."},
                      {"key": "contract_period", "label": "Contract period", "text": "One year"},
                      {"key": "spare_parts", "label": "Spare parts", "text": "Excluded — quoted separately"}]}


def test_detects_validity_period_and_spares_with_verbatim_quotes():
    found = {t["key"]: t for t in detect_term_requirements({"m1": MAIL})}
    assert found["validity"]["text"] == "120 days from the closing date."
    assert found["contract_period"]["text"].startswith("36 months from site handover")
    assert "Included" in found["spare_parts"]["text"]
    for t in found.values():
        assert " ".join(t["evidence"]["quote"].split()) in " ".join(MAIL.split())
        assert t["evidence"]["source_id"] == "m1"


def test_plain_validity_line_and_no_false_positive():
    assert detect_term_requirements({"m": "- Validity of the offer: 120 days"})[0]["text"] == "120 days."
    assert detect_term_requirements({"m": "Valid third-party inspection and certification documents"}) == []


def test_requests_are_recorded_not_applied_and_prices_or_unsourced_quotes_are_rejected():
    data = _data()
    result = record_term_requests(data, [
        {"key": "validity", "text": "120 days from the tender closing date.",
         "evidence": {"quote": "validity of your offers to be 120 days from closing date"}},
        {"key": "payment", "text": "KWD 5,000 advance", "evidence": {"quote": "Please quote"}},
        {"key": "contract_period", "text": "Five years", "evidence": {"quote": "five years please"}},
    ], actor="mcp:test", sources={"m1": MAIL}, enquiry_id="e1")
    assert {t["key"]: t["text"] for t in data["terms"]}["validity"] == "One month."  # a request is not a term
    reasons = {r["key"]: r["reason"] for r in result["rejected"]}
    assert "price" in reasons["payment"] and "not found" in reasons["contract_period"]
    change = data["term_changes"][0]
    assert (change["from"], change["status"], change["by"], change["enquiry_id"]) == ("One month.", "pending", "mcp:test", "e1")
    assert change["evidence"]["verified"] is True and open_term_requests(data) == [change]


def test_a_person_accepts_keeps_or_clarifies_with_who_when_and_revision():
    data = _data()
    record_term_requests(data, detect_term_requirements({"m1": MAIL}), actor="rules")
    assert decide_term_change(data, "validity", "accept", actor="Eng. A", revision="AA/26/0001 v1") is True
    assert {t["key"]: t["text"] for t in data["terms"]}["validity"] == "120 days from the closing date."
    with pytest.raises(ValueError):  # keeping the template wording needs a reason
        decide_term_change(data, "contract_period", "retain", actor="Eng. A", revision="AA/26/0001 v1")
    assert decide_term_change(data, "contract_period", "retain", actor="Eng. A", revision="AA/26/0001 v1",
                              reason="Our maintenance contracts run one year") is False
    decide_term_change(data, "spare_parts", "clarify", actor="Eng. A", revision="AA/26/0001 v1", reason="Which parts?")
    by_key = {c["key"]: c for c in data["term_changes"]}
    assert by_key["validity"]["status"] == "accepted" and by_key["validity"]["decided_by"] == "Eng. A"
    assert by_key["validity"]["revision"] == "AA/26/0001 v1" and by_key["validity"]["decided_at"]
    assert by_key["contract_period"]["status"] == "retained" and by_key["contract_period"]["reason"]
    assert [c["key"] for c in open_term_requests(data)] == ["spare_parts"]  # a clarification still blocks
    # keeping the template wording after an acceptance undoes it
    assert decide_term_change(data, "validity", "retain", actor="Eng. B", revision="AA/26/0001 v1", reason="Policy")
    assert {t["key"]: t["text"] for t in data["terms"]}["validity"] == "One month."
    # the same request detected again keeps its decision
    record_term_requests(data, detect_term_requirements({"m1": MAIL}), actor="rules")
    assert {c["key"]: c["status"] for c in data["term_changes"]}["validity"] == "retained"
