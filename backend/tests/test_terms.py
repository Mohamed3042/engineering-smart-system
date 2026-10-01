"""Quotation terms follow what the customer asked for, with the customer's sentence as evidence."""
from ess.pipeline.terms import apply_term_proposals, detect_term_requirements

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


def test_apply_records_change_and_rejects_prices_and_unsourced_quotes():
    data = _data()
    sources = {"m1": MAIL}
    result = apply_term_proposals(data, [
        {"key": "validity", "text": "120 days from the tender closing date.",
         "evidence": {"quote": "validity of your offers to be 120 days from closing date"}},
        {"key": "payment", "text": "KWD 5,000 advance", "evidence": {"quote": "Please quote"}},
        {"key": "contract_period", "text": "Five years", "evidence": {"quote": "five years please"}},
    ], actor="mcp:test", sources=sources)
    terms = {t["key"]: t["text"] for t in data["terms"]}
    assert terms["validity"] == "120 days from the tender closing date."
    assert terms["contract_period"] == "One year"
    reasons = {r["key"]: r["reason"] for r in result["rejected"]}
    assert "price" in reasons["payment"] and "not found" in reasons["contract_period"]
    change = data["term_changes"][0]
    assert change["from"] == "One month." and change["by"] == "mcp:test" and change["evidence"]["verified"] is True
