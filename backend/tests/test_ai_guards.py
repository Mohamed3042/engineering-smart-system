"""ess.ai.guards: verbatim evidence (EN + AR), price stripping, schema validation, numbers/dates."""
from __future__ import annotations

from ess.ai.guards import (PRICE_PLACEHOLDER, date_supported, find_price_mentions, find_quote, normalize_text,
                           number_supported, numbers_in, quote_in, strip_prices, validate_schema, verify_evidence)


# ---------------------------------------------------------------- normalisation

def test_arabic_diacritics_tatweel_and_letter_variants():
    assert normalize_text("مُهَنْدِسُ الْمَشْرُوعِ") == normalize_text("مهندس المشروع")
    assert normalize_text("تـــنظيف الواجهـات") == normalize_text("تنظيف الواجهات")
    assert normalize_text("أإآٱا") == "ااااا"
    assert normalize_text("مدرسة") == normalize_text("مدرسه")  # ta marbuta / ha
    assert normalize_text("مبنى") == normalize_text("مبني")  # alef maqsura / ya
    assert normalize_text("مسئول") == normalize_text("مسيول")  # hamza seat
    assert normalize_text("٢٠٢٦/١٠/٢٠ و ۱۲۳") == "2026/10/20 و 123"
    assert normalize_text("ﻻ") == "لا"  # presentation-form ligature from PDF text layers


def test_latin_normalisation():
    assert normalize_text("  Façade  CLEANING\n\tsystem ") == "facade cleaning system"
    assert normalize_text("“quoted” ‘text’ — dash") == '"quoted" \'text\' - dash'
    assert normalize_text("ﬁnal​ize") == "finalize"


# ---------------------------------------------------------------- quote matching

def test_verbatim_quote_is_found_and_original_span_returned():
    src = "Dear Sir,\nThe tender closing date is 15 November 2026.\nRegards"
    m = find_quote(src, "the tender closing  date is 15 November 2026")
    assert m and m["method"] == "exact" and m["text"] == "The tender closing date is 15 November 2026"


def test_arabic_quote_with_different_spelling_variants_is_found():
    src = "آخر موعد لاستلام العروض: ٢٠٢٦/١٠/٢٠ – مستشفى النخيل الأزرق"
    assert quote_in(src, "اخر موعد لاستلام العروض: 2026/10/20")
    assert quote_in(src, "مُسْتَشْفَى النخيل الازرق")
    m = find_quote(src, "اخر موعد لاستلام العروض: 2026/10/20")
    assert m["text"] == "آخر موعد لاستلام العروض: ٢٠٢٦/١٠/٢٠"


def test_smart_quotes_and_line_breaks():
    src = "He wrote “Building\nMaintenance Unit (BMU)” in the subject"
    assert quote_in(src, '"Building Maintenance Unit (BMU)"')


def test_pdf_hyphenation_is_tolerated_by_fuzzy_match_on_long_quotes():
    src = "Monorail track, stain-\nless steel 316, including brackets and fixings"
    m = find_quote(src, "Monorail track, stainless steel 316, including brackets and fixings")
    assert m and m["method"] == "fuzzy" and m["score"] >= 97


def test_paraphrases_and_invented_quotes_fail():
    src = "The tower rises to roughly one hundred and forty-five metres (145 m) above the podium roof."
    assert not quote_in(src, "building height is 145 m")
    assert not quote_in(src, "The tower is about 145 metres high")
    assert not quote_in(src, "rises to roughly ... (145 m)")  # ellipsis is not verbatim
    assert not quote_in("short", "a much longer quote than the source itself")
    assert not quote_in(src, "14")  # too short to be evidence
    assert not quote_in(src, "rises to roughly one hundred and forty-six metres")  # one digit word changed


# ---------------------------------------------------------------- verify_evidence

def test_verify_evidence_marks_items_and_facts():
    sources = {"thread": "Please send your offer no later than 8 November 2026.", "file-1": "SWL 250 kg per cage."}
    data = {
        "due_date": {"value": "2026-11-08", "evidence": {"quote": "no later than 8 November 2026", "source": "thread"}},
        "tender_no": {"value": None, "evidence": None},
        "location": {"value": "Kuwait City", "evidence": None},
        "requirements": [
            {"field": "swl", "value": "250 kg", "evidence": {"quote": "SWL 250 kg per cage", "source": "thread"}},
            {"field": "height", "value": "120 m", "evidence": {"quote": "building height 120 m", "source": "thread"}},
        ],
        "evidence": [{"quote": "Please send your offer", "source": "thread"}],
    }
    stats = verify_evidence(data, sources)
    assert data["due_date"]["verified"] is True and data["due_date"]["evidence"]["verified"] is True
    assert data["tender_no"]["verified"] is None  # unknown value: nothing to verify
    assert data["location"]["verified"] is False and "no_evidence" in data["location"]["flags"]
    swl = data["requirements"][0]
    assert swl["verified"] is True and swl["evidence"]["source"] == "file-1" and swl["evidence"]["source_claimed"] == "thread"
    bad = data["requirements"][1]
    assert bad["verified"] is False and "evidence_not_found" in bad["flags"]
    assert stats["quotes_failed"] == 1 and stats["sources_corrected"] == 1 and stats["facts_without_evidence"] == 1
    assert stats["all_verified"] is False and stats["failures"][0]["quote"] == "building height 120 m"


def test_model_cannot_pre_mark_evidence_as_verified():
    data = {"evidence": [{"quote": "invented sentence that is nowhere", "source": "body", "verified": True}]}
    verify_evidence(data, {"body": "the real text"})
    assert data["evidence"][0]["verified"] is False and data["verified"] is False


# ---------------------------------------------------------------- prices

def test_strip_prices_nulls_price_fields_and_reports_them():
    data = {"items": [{"description": "BMU", "qty": 2, "total_qty": 3, "unit_price": 18500, "total": 37000,
                       "amount": "KWD 37,000", "rate": 12.5, "price_kwd": 1, "installation_cost": 400,
                       "evidence": {"quote": "unit price KWD 18,500", "source": "body"}}],
            "grand_total": 37000, "confidence": 0.9}
    removed = strip_prices(data)
    item = data["items"][0]
    assert {r["key"] for r in removed} == {"unit_price", "total", "amount", "rate", "price_kwd", "installation_cost",
                                           "grand_total"}
    assert item["unit_price"] is None and item["total"] is None and item["qty"] == 2 and item["total_qty"] == 3
    assert item["evidence"]["quote"] == "unit price KWD 18,500"  # evidence is verbatim source text: untouched
    assert data["confidence"] == 0.9


def test_strip_prices_redacts_currency_amounts_in_text():
    data = {"intro": "Our offer is KWD 17,900 (competitor: 18,500 د.ك).", "terms": ["Price: 950", "Validity 30 days"],
            "arabic": "السعر ١٢٬٥٠٠ دينار كويتي", "spec": "SWL 250 kg, 2,000 kg per cage, scale 1:100"}
    removed = strip_prices(data, scan_text=True)
    assert "17,900" not in data["intro"] and "18,500" not in data["intro"] and PRICE_PLACEHOLDER in data["intro"]
    assert data["terms"] == [PRICE_PLACEHOLDER, "Validity 30 days"]
    assert "دينار" not in data["arabic"]
    assert data["spec"] == "SWL 250 kg, 2,000 kg per cage, scale 1:100"  # quantities are not prices
    assert len(removed) == 3


def test_find_price_mentions():
    assert find_price_mentions("Amount due: KWD 1,850.000") == ["KWD 1,850.000"]
    assert find_price_mentions("US$ 5,000 or €4,500 or 3500 AED") == ["US$ 5,000", "€4,500", "3500 AED"]
    assert find_price_mentions("Dear Sales Team, 42 floors, 1.40 m, MCT/2026/044, KD-12 drawing") == []


# ---------------------------------------------------------------- schema, numbers, dates

def test_validate_schema_reports_readable_errors():
    schema = {"type": "object", "additionalProperties": False, "required": ["d", "n"],
              "properties": {"d": {"type": ["string", "null"], "format": "date"}, "n": {"type": "number", "maximum": 1}}}
    assert validate_schema({"d": None, "n": 0.5}, schema) == []
    errors = validate_schema({"d": "2026-13-45", "n": 3, "x": 1}, schema)
    assert any("$.d" in e and "date" in e for e in errors)
    assert any("$.n" in e for e in errors) and any("Additional properties" in e for e in errors)


def test_numbers_and_dates_must_be_readable_in_quotes():
    assert numbers_in("the two existing BMU gondolas") == {2.0}
    assert numbers_in("twenty-four hours, ٣٦ متر, 2,000 kg, 1.40 m") >= {24.0, 36.0, 2000.0, 1.4}
    assert numbers_in("ثلاثة مصاعد وخمسة") >= {3.0, 5.0}
    assert number_supported(2, "Two temporary suspended cradles")
    assert number_supported("1.40 m", "revised from 1.10 m to 1.40 m")
    assert not number_supported(6, "we need a cradle for our building")
    assert number_supported("unitised curtain wall", "anything")  # no digits: nothing to check
    assert date_supported("2026-11-08", "no later than 8 November 2026")
    assert date_supported("2026-10-20", "آخر موعد: ٢٠٢٦/١٠/٢٠")
    assert date_supported("2026-10-26", "extended to 26 October")
    assert date_supported("2026-11-08", "يوم 8 نوفمبر")
    assert not date_supported("2026-10-31", "by the end of next month")
    assert not date_supported("2026-11-09", "no later than 8 November 2026")
    assert not date_supported("15/11/2026", "15 November 2026")  # must be ISO
