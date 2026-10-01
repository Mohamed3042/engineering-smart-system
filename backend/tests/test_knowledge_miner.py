"""ess.knowledge.miner: learning a company's business identity from its own documents and mailbox.

Synthetic company "Northwind Access Ltd" (UK English): three own quotations, a company profile,
sent mail, inbound mail from Gulf customers (one in Arabic) and one web directory page.
"""
from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

from ess.knowledge import base, corpus
from ess.knowledge.corpus import CorpusDoc, build_corpus_from_folder, from_mail_messages
from ess.knowledge.miner import (
    KnowledgeItemDraft,
    build_identity,
    categories_from_identity,
    claim_basis_for,
    confidence_for,
    learn_business,
    mine_corpus,
)

FIXTURES = Path(__file__).parent / "fixtures" / "knowledge"
NW = FIXTURES / "northwind"


def northwind_docs() -> list[CorpusDoc]:
    docs = build_corpus_from_folder(NW / "quotations", source_type="own_quotation")
    docs += build_corpus_from_folder(NW / "company")
    docs += build_corpus_from_folder(NW / "web", source_type="web")
    mail = json.loads((NW / "mail.json").read_text(encoding="utf-8"))
    docs += from_mail_messages(mail["messages"], mail["own_domains"])
    return docs


@pytest.fixture(scope="module")
def fixture_data():
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(base, "DATA_DIR", FIXTURES / "data")
        mp.setattr(corpus, "_documents_extractor", lambda: None)
        base.clear_caches()
        yield
    base.clear_caches()


@pytest.fixture(scope="module")
def docs(fixture_data):
    return northwind_docs()


@pytest.fixture(scope="module")
def items(docs):
    return mine_corpus(docs)


@pytest.fixture(scope="module")
def identity(items):
    return build_identity(items)


def get(items, kind, key) -> KnowledgeItemDraft | None:
    return next((i for i in items if i.kind == kind and i.key == key), None)


# --------------------------------------------------------------------------- service families
def test_service_families_detected_with_delivered_work(items):
    for key in ("bmu", "cradle", "access_rental"):
        fam = get(items, "service_family", key)
        assert fam is not None, key
        assert fam.claim_basis == "delivered_work"
        assert fam.confidence >= 0.8
        assert fam.status == "suggested"
        assert any(e.source_type == "own_quotation" for e in fam.evidence)
    assert get(items, "service_family", "bmu").label == "Building Maintenance Units"  # category label


def test_every_item_has_verbatim_evidence(items, docs):
    texts = {d.source_id: d.text for d in docs}
    assert items
    for item in items:
        assert item.evidence, item.key
        for ev in item.evidence:
            assert ev.quote and ev.quote in texts[ev.source_id], (item.key, ev.quote)
            assert ev.weight == corpus.SOURCE_WEIGHTS[ev.source_type]


def test_web_only_claim_stays_low_confidence(items, identity):
    hoist = get(items, "service_family", "hoist")
    assert hoist is not None
    assert {e.source_type for e in hoist.evidence} == {"web"}
    assert hoist.confidence <= 0.3
    assert hoist.claim_basis != "delivered_work"
    assert any(g["key"] == "unconfirmed:hoist" and "online" in g["message"] for g in identity["gaps"])


def test_catalogue_claim_and_excluded_scope(items):
    wce = get(items, "service_family", "wce")
    assert wce.claim_basis == "catalogue_claim"  # only the company profile claims it
    scaffolding = get(items, "service_family", "scaffolding")  # quotations say "scaffolding by others"
    assert scaffolding is not None and scaffolding.claim_basis != "delivered_work"
    assert scaffolding.confidence <= 0.3
    assert all(getattr(e, "note", None) for e in scaffolding.evidence)


def test_work_types(items):
    for key in ("supply_installation", "equipment_rental", "annual_maintenance", "inspection_certification"):
        wt = get(items, "work_type", key)
        assert wt is not None and wt.claim_basis == "delivered_work", key
    rental = get(items, "service_family", "access_rental")
    assert "equipment_rental" in rental.meta["work_types"]


# --------------------------------------------------------------------------- vocabulary
def test_uk_vs_gcc_vocabulary(items, identity):
    rv = identity["regions_vocab"]
    assert rv["company_primary"] == "UK_EU"
    assert rv["customers_primary"] == "GCC"
    cradle = get(items, "service_family", "cradle")
    assert "cradle" in [t.lower() for t in cradle.meta["terms_company"]]
    assert "gondola" in [t.lower() for t in cradle.meta["terms_customers"]]
    hire = get(items, "term", "equipment_rental:hire")
    assert hire.region == "UK_EU" and hire.meta["used_by"] == "company"
    gondola = get(items, "term", "cradle:gondola")
    assert gondola.region == "GCC" and gondola.claim_basis == "market_vocabulary"
    picker = get(items, "term", "access_rental:cherry_picker")
    assert picker.meta["used_by"] == "company"  # the customer's reply quoting us does not count


def test_arabic_terms_matched(items):
    arabic = [i for i in items if i.kind == "term" and i.language == "ar"]
    labels = {i.label for i in arabic}
    assert "وحدة صيانة المباني" in labels and "جندولا" in labels
    bmu_ar = next(i for i in arabic if i.label == "وحدة صيانة المباني")
    assert bmu_ar.meta["category"] == "bmu" and bmu_ar.region == "GCC"
    assert "وحدة صيانة المباني" in bmu_ar.evidence[0].quote
    assert get(items, "term", "supply_installation:توريد_وتركيب") is not None  # "لتوريد وتركيب" with proclitic


def test_company_specific_terms(items):
    ngrams = [i for i in items if i.kind == "term" and i.meta.get("origin") == "ngram"]
    labels = [i.label for i in ngrams]
    assert "NorthStar twin-hoist" in labels
    assert not {"Al Noor Tower", "Marina Heights", "Kuwait"} & set(labels)  # names are not vocabulary


# --------------------------------------------------------------------------- standards & conventions
def test_standards(items, identity):
    en1808 = get(items, "standard", "en_1808")
    assert en1808 is not None and en1808.label == "BS EN 1808:2015" and en1808.region == "UK_EU"
    assert en1808.meta["years"] == ["2015"] and en1808.claim_basis == "delivered_work"
    assert get(items, "standard", "bs_6037_1") is not None
    assert get(items, "standard", "loler_1998") is not None
    codes = {s["code"] for s in identity["standards"]}
    assert {"EN 1808", "BS 6037-1", "LOLER 1998"} <= codes


def test_reference_convention(items):
    ref = get(items, "convention", "reference_format")
    assert ref is not None
    v = ref.value
    assert v["pattern"] == "NW/YY/NNNN" and v["prefix"] == "NW"
    assert v["year_format"] == "YY" and v["sequence_digits"] == 4
    assert v["latest"] == "NW/26/0107" and v["next"] == "NW/26/0108"
    assert set(v["examples"]) >= {"NW/26/0101", "NW/26/0102", "NW/26/0107"}


def test_other_conventions_and_identity(items, identity):
    cur = get(items, "convention", "currency").value
    assert cur["code"] == "GBP" and cur["decimals"] == 2
    assert get(items, "convention", "date_format").value["format"] == "DD/MM/YYYY"
    pay = get(items, "convention", "commercial_terms.payment").value
    assert pay["text"] == "30% advance, 60% on delivery, 10% on commissioning"
    company = identity["company"]
    assert company["legal_name"] == "Northwind Access Ltd" and company["name"] == "Northwind Access"
    assert company["address"] == "Unit 4, Riverside Park, Leeds LS10 1AB, United Kingdom"
    assert "+441134960123" in [p["number"] for p in company["phones"]]
    assert company["website"] == "northwind-access.example"
    assert company["domains"] == ["northwind-access.example"]
    assert identity["languages"] == ["en"]
    sig = get(items, "convention", "signature_block").value
    assert sig["legal_name"] == "Northwind Access Ltd" and sig["closing"]


def test_identity_summary(identity):
    fams = [f["key"] for f in identity["service_families"]]
    assert fams[:3] == sorted(fams[:3], key=lambda k: fams.index(k))  # ordered by confidence
    assert {"bmu", "cradle", "access_rental", "wce", "hoist"} <= set(fams)
    assert "scaffolding" not in fams  # excluded scope is not an offering
    assert {w["key"] for w in identity["work_types"]} >= {"supply_installation", "equipment_rental"}
    assert 0.6 <= identity["confidence"] <= 1.0
    gap_keys = {g["key"] for g in identity["gaps"]}
    assert not {"reference_format", "currency", "legal_name"} & gap_keys


def test_categories_from_identity(identity, fixture_data):
    cats = categories_from_identity(identity)
    keys = [c["key"] for c in cats]
    assert keys[:4] == ["cradle", "bmu", "access_rental", "wce"] or set(keys[:4]) == {"cradle", "bmu", "access_rental",
                                                                                       "wce"}
    assert "hoist" not in keys and "scaffolding" not in keys  # web-only / excluded
    assert {"other_work", "bills", "promotions", "internal", "other"} <= set(keys)
    cradle = next(c for c in cats if c["key"] == "cradle")
    assert cradle["source"] == "learned" and cradle["is_work_type"] and cradle["group"] == "work"
    assert "gondola" in [k.lower() for k in cradle["keywords"]["en"]]  # customers' wording classifies mail
    assert "جندولا" in cradle["keywords"]["ar"]
    assert cradle["negative_keywords"]["en"] == ["baby cradle", "phone cradle"]
    assert [c["order"] for c in cats] == list(range(len(cats)))
    confirmed = dict(identity)
    confirmed["service_families"] = [dict(f, status="owner_confirmed") if f["key"] == "hoist" else f
                                     for f in identity["service_families"]]
    assert "hoist" in [c["key"] for c in categories_from_identity(confirmed)]


def test_build_identity_accepts_stored_rows(items):
    rows = [dict(i.model_dump(exclude={"meta", "value"}), status="suggested") for i in items]
    rows.append({"kind": "service_family", "key": "crane", "label": "Cranes", "claim_basis": "owner",
                 "status": "owner_confirmed", "confidence": 1.0, "evidence": [{"quote": "Added by Sam",
                                                                                "source_type": "owner"}]})
    rows.append({"kind": "service_family", "key": "scaffolding_x", "label": "Rejected", "status": "rejected",
                 "claim_basis": "delivered_work", "confidence": 0.9})
    ident = build_identity(rows)
    keys = [f["key"] for f in ident["service_families"]]
    assert "crane" in keys and "scaffolding_x" not in keys
    assert ident["company"]["legal_name"] == "Northwind Access Ltd"  # label carries the value
    assert ident["regions_vocab"]["company_primary"] == "UK_EU"  # from evidence source types


def test_scoring_helpers():
    assert claim_basis_for(["web"]) == "catalogue_claim"
    assert claim_basis_for(["inbound_email"]) == "market_vocabulary"
    assert claim_basis_for(["company_doc", "sent_email"]) == "delivered_work"
    assert confidence_for(10.0, {"web"}) <= 0.3
    assert confidence_for(10.0, {"inbound_email"}) <= 0.45
    assert confidence_for(1.0, {"own_quotation"}) > confidence_for(0.2, {"web"})


# --------------------------------------------------------------------------- AI refinement
def test_ai_refinement_keeps_only_verified_quotes(docs, fixture_data, monkeypatch):
    calls = {}

    def discover_business(engine, documents, hints=None):
        calls["n_docs"] = len(documents)
        calls["hints"] = hints
        return {"service_families": [
            {"key": "facade_access", "label": "Facade access equipment", "confidence": 0.99,
             "description": "Design, supply and maintenance of facade access equipment.",
             "evidence": [{"quote": "designs, supplies, installs and maintains facade access equipment",
                           "source_id": "profile.md"}]},
            {"key": "elevators", "label": "Elevators", "confidence": 0.99,
             "evidence": [{"quote": "We install passenger elevators in every tower."}]},
        ]}

    fake = types.ModuleType("ess.ai.tasks")
    fake.discover_business = discover_business
    monkeypatch.setitem(sys.modules, "ess.ai.tasks", fake)
    out = mine_corpus(docs, engine=object())
    assert calls["n_docs"] == len(docs) and calls["hints"]
    facade = get(out, "service_family", "facade_access")
    assert facade is not None and facade.meta.get("ai") is True
    assert facade.confidence < 0.6  # confidence comes from the evidence (one company document), not the AI
    assert facade.claim_basis == "catalogue_claim"
    assert get(out, "service_family", "elevators") is None  # quote not found in any source -> dropped


def test_real_discover_business_task_with_fake_engine(docs, fixture_data):
    tasks = pytest.importorskip("ess.ai.tasks")
    if not hasattr(tasks, "discover_business"):
        pytest.skip("ess.ai.tasks.discover_business not available")
    import re

    class Engine:
        def complete_json(self, system, user, schema, **kwargs):
            key = re.search(r"- (x-\d+): company_doc - profile\.md", user).group(1)
            item = {"value": None, "language": "en", "region": None, "variants": []}
            return {"items": [
                {**item, "kind": "service_family", "key": "facade_access", "label": "Facade access equipment",
                 "variants": ["facade access"],
                 "evidence": [{"quote": "designs, supplies, installs and maintains facade access equipment",
                               "source": key}]},
                {**item, "kind": "product", "key": "northstar", "label": "NorthStar cradle",
                 "evidence": [{"quote": "NorthStar twin-hoist cradle", "source": key}]},  # really in a quotation
                {**item, "kind": "service_family", "key": "elevators", "label": "Elevators",
                 "evidence": [{"quote": "We install passenger elevators in every tower.", "source": key}]},
            ], "summary": "Facade access company."}

    out = mine_corpus(docs, engine=Engine())
    facade = get(out, "service_family", "facade_access")
    assert facade is not None and facade.meta.get("ai") and "facade access" in facade.synonyms
    northstar = get(out, "term", "northstar")
    assert northstar is not None and northstar.claim_basis == "delivered_work"  # source corrected to the quotation
    assert get(out, "service_family", "elevators") is None


def test_ai_engine_without_task_module_falls_back(docs, fixture_data, monkeypatch):
    monkeypatch.setitem(sys.modules, "ess.ai.tasks", None)  # import fails
    out = mine_corpus(docs, engine=object())
    assert get(out, "service_family", "bmu") is not None


# --------------------------------------------------------------------------- generality
def test_unknown_domain_company_learns_from_offering_phrases(fixture_data):
    texts = [
        "Subject: Supply and installation of fan coil units for Block A.\nWe offer 40 nos. fan coil units.",
        "Our offer: supply of chillers and fan coil units for the Al Rai warehouse.",
        "Maintenance of chillers at the Fintas clinic, quarterly visits.",
    ]
    docs = [CorpusDoc(source_type="own_quotation", source_id=f"q{i}", label=f"Q{i}", text=t)
            for i, t in enumerate(texts)]
    docs.append(CorpusDoc(source_type="inbound_email", source_id="in1", label="RFQ",
                          text="Please quote chillers for our new mall."))
    out = mine_corpus(docs)
    fams = {i.key: i for i in out if i.kind == "service_family"}
    assert "fan_coil_unit" in fams and "chiller" in fams
    assert fams["fan_coil_unit"].claim_basis == "delivered_work"
    assert fams["chiller"].meta["work_types"].get("annual_maintenance")
    cats = categories_from_identity(build_identity(out))
    assert {"fan_coil_unit", "chiller"} <= {c["key"] for c in cats if c["source"] == "learned"}


def test_builtin_defaults_still_learn(monkeypatch, tmp_path):
    monkeypatch.setattr(base, "DATA_DIR", tmp_path)
    monkeypatch.setattr(corpus, "_documents_extractor", lambda: None)
    base.clear_caches()
    try:
        out = learn_business(northwind_docs())
        fams = {f["key"] for f in out["identity"]["service_families"]}
        assert {"bmu", "cradle", "access_rental"} <= fams
        assert out["categories"] and out["identity"]["company"]["legal_name"] == "Northwind Access Ltd"
    finally:
        base.clear_caches()


def test_raw_bodies_with_history_and_dict_docs(fixture_data):
    raw = [
        {"source_type": "sent_email", "source_id": "x1", "label": "Re: RFQ",
         "text": "We confirm the hire of one cherry picker.\n\nOn Mon, 1 Sep 2026, Buyer <b@c.example> wrote:\n"
                 "> Please quote gondola rental for 6 months"},
        {"source_type": "inbound_email", "source_id": "x2", "label": "RFQ", "text": "Please quote gondola rental."},
        {"source_type": "bogus", "source_id": "x3", "label": "?", "text": "ignored"},
    ]
    out = mine_corpus(raw)
    gondola = get(out, "term", "cradle:gondola")
    assert gondola is not None and gondola.meta["used_by"] == "customers"
    assert get(out, "term", "access_rental:cherry_picker").meta["used_by"] == "company"
    assert mine_corpus([]) == []


def test_mining_is_deterministic(docs, items):
    again = mine_corpus(docs)
    assert [i.model_dump() for i in again] == [i.model_dump() for i in items]


def test_scales_to_a_mailbox(fixture_data):
    import time

    docs = northwind_docs()
    for n in range(600):
        docs.append(CorpusDoc(source_type="inbound_email", source_id=f"bulk{n}", label="RFQ",
                              text=f"Dear Sir,\nKindly quote {n % 7 + 1} nos. gondola on monthly rental for tower "
                                   f"{n}. The BOQ is attached.\nRegards,\nBuyer {n}\nAcme Contracting Co."))
    t0 = time.perf_counter()
    out = mine_corpus(docs)
    assert time.perf_counter() - t0 < 20
    assert get(out, "term", "cradle:gondola").meta["doc_counts"]["inbound_email"] >= 600
