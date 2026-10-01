"""ess.knowledge.base / ess.knowledge.text: normalisation, data loading, term index, quote helpers."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from ess.knowledge import base
from ess.knowledge.text import (
    SentenceIndex,
    extract_signature,
    find_verbatim,
    quote_in_text,
    quoted_cut,
    registrable_domain,
    sentence_spans,
)

FIXTURES = Path(__file__).parent / "fixtures" / "knowledge"
SHIPPED = Path(base.__file__).parent / "data"


@pytest.fixture()
def fixture_data(monkeypatch):
    monkeypatch.setattr(base, "DATA_DIR", FIXTURES / "data")
    base.clear_caches()
    yield FIXTURES / "data"
    base.clear_caches()


@pytest.fixture()
def empty_data(monkeypatch, tmp_path):
    monkeypatch.setattr(base, "DATA_DIR", tmp_path)
    base.clear_caches()
    yield tmp_path
    base.clear_caches()


# --------------------------------------------------------------------------- normalisation
@pytest.mark.parametrize("raw, expected", [
    ("أَحْمَد", "احمد"),  # harakat + hamza on alef
    ("مـــدرسة", "مدرسه"),  # tatweel + teh marbuta
    ("مستشفى", "مستشفي"),  # alef maqsura -> yeh
    ("إلى آخر", "الي اخر"),  # alef variants
    ("مؤسسة", "موسسه"),  # hamza on waw
    ("٢٠٢٦/٠٨", "2026/08"),  # Arabic-Indic digits
    ("  Façade \t “Access”  —  Ltd ", 'facade "access" - ltd'),
    ("STRASSE", "strasse"),
])
def test_normalize_text(raw, expected):
    assert base.normalize_text(raw) == expected


def test_normalize_text_handles_none_and_presentation_forms():
    assert base.normalize_text(None) == ""
    assert base.normalize_text("ﻻ") == "لا"  # lam-alef ligature (presentation form)


def test_detect_language():
    assert base.detect_language("Dear Sir, please quote for the BMU") == "en"
    assert base.detect_language("نرجو تزويدنا بعرض سعر") == "ar"
    assert base.detect_language("Просим предоставить коммерческое предложение") == "ru"
    assert base.detect_language("12 / 34") is None


# --------------------------------------------------------------------------- loaders
def test_loaders_validate_fixture_files(fixture_data):
    rt = base.load_region_terms()
    keys = [c["key"] for c in rt["concepts"]]
    assert "bmu" in keys and "broken_concept" not in keys and len(keys) == 10
    assert {r["key"] for r in rt["regions"]} >= {"GCC", "UK_EU", "US"}  # case preserved
    rental = [t for c in rt["concepts"] if c["key"] == "equipment_hire" for t in c["terms"] if t["term"] == "rental"]
    assert sorted(t["region"] for t in rental) == ["GCC", "US"]  # list regions expanded
    assert all(t["language"] for c in rt["concepts"] for t in c["terms"])

    st = base.load_standards()
    assert isinstance(st, dict) and len(st["standards"]) == 7
    cats = base.default_categories()
    assert isinstance(cats, list) and {c["key"] for c in cats} >= {"bmu", "bills", "other_work"}
    assert next(c for c in cats if c["key"] == "bills")["is_work_type"] is False
    cs = base.load_cross_sell()
    assert len(cs["service_adjacency"]) == 6 and "consultant" in cs["customer_kind_needs"]

    issues = base.load_issues()
    assert any("broken_concept" in m for m in issues["region_terms.json"])
    assert issues["standards.json"] and issues["default_categories.json"] and issues["cross_sell.json"]
    assert set(base.data_sources().values()) == {"file"}


def test_loaders_fall_back_to_builtin_defaults(empty_data):
    assert set(base.data_sources().values()) == {"builtin"}
    rt = base.load_region_terms()
    assert any(c["category"] == "cradle" for c in rt["concepts"])
    assert base.load_standards()["standards"]
    cats = base.default_categories()
    assert {"bmu", "bills", "promotions", "other"} <= {c["key"] for c in cats}
    assert base.load_cross_sell()["service_adjacency"]


def test_corrupt_file_falls_back_and_reports(empty_data):
    (empty_data / base.STANDARDS_FILE).write_text("{not json", encoding="utf-8")
    st = base.load_standards()
    assert st["standards"]  # built-in
    assert base.data_sources()[base.STANDARDS_FILE] == "builtin"
    assert any("unreadable" in m for m in base.load_issues()[base.STANDARDS_FILE])


def test_cache_follows_file_changes_and_returns_copies(empty_data):
    path = empty_data / base.STANDARDS_FILE
    path.write_text(json.dumps({"version": 1, "standards": [{"code": "EN 1808"}]}), encoding="utf-8")
    first = base.load_standards()
    assert [s["code"] for s in first["standards"]] == ["EN 1808"]
    first["standards"].clear()  # callers get copies
    assert base.load_standards()["standards"]
    path.write_text(json.dumps({"version": 1, "standards": [{"code": "EN 1808"}, {"code": "EN 795"}]}),
                    encoding="utf-8")
    st = os.stat(path)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    assert [s["code"] for s in base.load_standards()["standards"]] == ["EN 1808", "EN 795"]


@pytest.mark.skipif(not (SHIPPED / base.REGION_TERMS_FILE).exists(), reason="shipped data not present")
def test_shipped_data_files_load(monkeypatch):
    monkeypatch.setattr(base, "DATA_DIR", SHIPPED)
    base.clear_caches()
    try:
        sources = base.data_sources()
        assert all(v == "file" for k, v in sources.items() if (SHIPPED / k).exists())
        idx = base.term_index()
        assert len(idx) > 50
        assert base.default_categories() and base.load_standards()["standards"]
    finally:
        base.clear_caches()


# --------------------------------------------------------------------------- term index
def test_term_index_lookup(fixture_data):
    idx = base.term_index()
    gondola = idx.lookup("Gondolas")
    assert any(e.category == "cradle" and e.region == "GCC" for e in gondola)
    assert any(e.category == "access_rental" for e in idx.lookup("man-lift"))
    assert any(e.category == "access_rental" for e in idx.lookup("manlifts"))  # joined compound
    arabic = idx.lookup("وَحْدَة صِيَانَة المَبَانِي")  # with harakat
    assert any(e.category == "bmu" and e.language == "ar" for e in arabic)
    hire = idx.lookup("hire")
    assert any(e.origin == "region_terms" and e.region == "UK_EU" for e in hire)
    assert idx is base.term_index()  # cached


def test_term_index_find_longest_match_and_arabic_proclitics(fixture_data):
    idx = base.term_index()
    text = "Kindly quote a building maintenance unit and 2 suspended scaffolds.\nنرجو توريد وجندولا للمشروع"
    found = {m.surface: {e.category for e in m.entries} for m in idx.find(text)}
    assert "building maintenance unit" in found and "bmu" in found["building maintenance unit"]
    assert "cradle" in found["suspended scaffolds"]  # longest match wins over "scaffold"
    assert any("cradle" in cats for surf, cats in found.items() if "جندولا" in surf)


def test_term_index_does_not_cross_lines(fixture_data):
    idx = base.term_index()
    assert not [m for m in idx.find("building maintenance\nunit") if m.surface == "building maintenance\nunit"]


# --------------------------------------------------------------------------- text helpers
def test_sentence_spans_respect_abbreviations():
    text = "Gulf Horizon Contracting Co. W.L.L. is a contractor. It builds towers.\nTel: +965 1234"
    sents = [text[s:e] for s, e in sentence_spans(text)]
    assert sents[0] == "Gulf Horizon Contracting Co. W.L.L. is a contractor."
    assert sents[1] == "It builds towers."
    assert SentenceIndex(text).quote(text.index("towers"), text.index("towers") + 6) == "It builds towers."


def test_find_verbatim_and_quote_in_text():
    src = "Our   offer covers the  BMU.\nوحدةُ صيانةِ المباني متوفرة"
    assert find_verbatim("our offer covers the BMU", src) == "Our   offer covers the  BMU"
    assert find_verbatim("وحدة صيانة المباني", src) is not None
    assert quote_in_text("OFFER covers the bmu", src)
    assert not quote_in_text("we offer tower cranes", src)
    assert find_verbatim("we offer tower cranes", src) is None


def test_quoted_cut_reply_vs_forward():
    reply = "Thanks, noted.\n\nOn Tue, 18 Aug 2026 at 10:00, James <j@n.example> wrote:\n> our old text"
    assert reply[:quoted_cut(reply, "reply")].strip() == "Thanks, noted."
    fwd = ("Please see the RFQ below.\n\n---------- Forwarded message ---------\nFrom: Client <c@x.example>\n"
           "Date: Mon, 1 Sep 2026\nSubject: RFQ for BMU\nTo: <a@b.example>\n\nPlease quote for one BMU.")
    assert quoted_cut(fwd, "reply") == len(fwd)  # forwarded customer text is kept
    assert fwd[:quoted_cut(fwd, "all")].strip() == "Please see the RFQ below."  # own mail keeps own words only
    outlook = "OK.\n________________________________\nFrom: X <x@y.example>\nSent: Monday\nTo: Z\nSubject: Re: offer\nold"
    assert outlook[:quoted_cut(outlook, "reply")].strip() == "OK."


def test_extract_signature_and_domains():
    text = "Dear Sir,\nPlease quote.\n\nBest regards,\nAhmed Saleh\nEstimation Engineer\nAl Safwa Contracting Co.\nTel: +965 2222 3333"
    s, e = extract_signature(text)
    assert "Estimation Engineer" in text[s:e] and text[s:e].startswith("Best regards")
    assert registrable_domain("https://news.example.co.uk/a") == "example.co.uk"
    assert registrable_domain("www.builders-kw.example") == "builders-kw.example"
    assert registrable_domain("mpw.gov.kw") == "mpw.gov.kw"
