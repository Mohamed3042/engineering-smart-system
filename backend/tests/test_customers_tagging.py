"""ess.customers.tagging: customer kind and tags (role, sector, need, behaviour, relationship)."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ess.customers.tagging import classify_customer, infer_customer_kind, tag_customer, tag_customers
from ess.knowledge import base

FIXTURES = Path(__file__).parent / "fixtures" / "knowledge"
NOW = datetime(2026, 9, 15, tzinfo=timezone.utc)
OUR_SERVICES = [{"key": "bmu", "label": "Building Maintenance Units"},
                {"key": "wce", "label": "Window Cleaning Equipment"},
                {"key": "cradle", "label": "Suspended platforms"},
                {"key": "annual_maintenance", "label": "Maintenance contracts"}]


@pytest.fixture(autouse=True)
def fixture_data(monkeypatch):
    monkeypatch.setattr(base, "DATA_DIR", FIXTURES / "data")
    base.clear_caches()
    yield
    base.clear_caches()


@pytest.mark.parametrize("domain, name, signatures, expected", [
    ("cgc-example.com", "Combined Gulf Contracting Co. W.L.L.",
     ["Dear Sir,\nPlease quote.\n\nBest regards,\nOla Ahmed\nEstimation Engineer (Civil)\nCombined Gulf Contracting Co."],
     "main_contractor"),
    ("albayan-eng.example", "Al Bayan Engineering Consultants", [], "consultant"),
    ("mpw.example.gov.kw", "Public Works Department", [], "government"),
    ("gmail.com", "وزارة الأشغال العامة", [], "government"),
    ("khaleej.example", "شركة الخليج للتجارة العامة والمقاولات", [], "main_contractor"),
    ("ibdaa.example", "مكتب الإبداع للاستشارات الهندسية", [], "consultant"),
    ("pinnacle-fm.example", "Pinnacle Facility Management Services", [], "facility_management"),
    ("seaside.example", "Seaside Real Estate Development Co.", [], "developer"),
    ("gulfglass.example", "Gulf Aluminium & Glass Contracting", [], "subcontractor"),
    ("alpha-eq.example", "Alpha Equipment Trading", [], "supplier"),
    ("kockw.example", "Kuwait Oil Company (KOC)", [], "government"),
])
def test_infer_customer_kind(domain, name, signatures, expected):
    kind, conf, reason = infer_customer_kind(domain, name, signatures)
    assert kind == expected, (kind, conf, reason)
    assert 0.0 < conf <= 0.95 and reason


def test_signature_titles_and_behaviour_decide_unclear_names():
    kind, conf, reason = infer_customer_kind("noor.example", "Al Noor Group", [
        "Regards,\nAhmed\nTender Officer\nAl Noor Group"])
    assert kind == "main_contractor" and "Tender Officer" in reason
    kind, conf, reason = infer_customer_kind("noor.example", "Al Noor Group", [], behaviour={"tender_rfqs": 3})
    assert kind == "main_contractor" and "tender" in reason
    kind, conf, _ = infer_customer_kind("vendor.example", "Zeta Group", [], behaviour={"vendor_offers": 2})
    assert kind == "supplier"
    kind, conf, reason = infer_customer_kind("zeta.example", "Zeta", [])
    assert kind == "other" and conf <= 0.3


def test_generic_gcc_company_form_is_a_weak_signal():
    strong = classify_customer("a.example", "Gulf Horizon Construction Co.")
    weak = classify_customer("b.example", "Al Safwa General Trading & Contracting Co.")
    assert strong["kind"] == weak["kind"] == "main_contractor"
    assert weak["confidence"] < strong["confidence"]
    assert "facade_contractor" in classify_customer("c.example", "Gulf Aluminium & Glass Contracting")["subtypes"]


EMAILS = [
    {"id": "e1", "thread_id": "t1", "from_email": "faisal@gulfhorizon.example",
     "subject": "RFQ - BMU for Al Noor Tower (Tender No. MPW/2026/14)", "date": "2026-08-10T09:00:00Z",
     "category": "bmu",
     "body_text": "Dear Sir,\nKindly quote for the BMU and gondola system for the Al Noor Tower tender. Closing date "
                  "30 Aug 2026.\nThe contract will be back to back.\n\nBest regards,\nFaisal Al-Rashid\n"
                  "Estimation Engineer\nGulf Horizon Contracting Co. W.L.L.\nTel: +965 2222 1111"},
    {"id": "e2", "thread_id": "t2", "from_email": "faisal@gulfhorizon.example",
     "subject": "RFQ - davits and monorail for Jahra Hospital", "date": "2026-09-01T09:00:00Z",
     "body_text": "Dear Sir,\nPlease quote davits and a monorail for the new Jahra Hospital.\nRegards,\nFaisal Al-Rashid\n"
                  "Estimation Engineer"},
    {"id": "e3", "thread_id": "t1", "from_email": "faisal@gulfhorizon.example",
     "subject": "Reminder: RFQ - BMU for Al Noor Tower", "date": "2026-08-20T09:00:00Z",
     "body_text": "Gentle reminder, we are still waiting for your offer.\nRegards,\nFaisal"},
    {"id": "e4", "thread_id": "t1", "from_email": "sales@northwind.example", "direction": "outbound",
     "subject": "Quotation NW/26/0101", "date": "2026-08-22T09:00:00Z",
     "body_text": "Please find attached our quotation NW/26/0101 for the BMU."},
    {"id": "e5", "customer_ref": "someone-else.example", "from_email": "x@someone-else.example",
     "subject": "RFQ scaffolding for KNPC refinery", "date": "2026-09-02T09:00:00Z", "body_text": "Please quote."},
]
PROJECTS = [
    {"ref": "P1", "name": "Al Noor Tower", "service_family": "bmu", "work_type": "supply_installation",
     "request_kind": "tender_rfq", "location": "Kuwait City", "customer_ref": "gulfhorizon.example",
     "enquiries": [{"customer_ref": "gulfhorizon.example", "status": "quoted", "received_at": "2026-08-10T09:00:00Z",
                    "our_response": {"status": "quoted"}}]},
    {"ref": "P2", "name": "Jahra Hospital", "service_family": "wce", "request_kind": "direct_rfq",
     "owner_client": "Ministry of Health", "status": "lost", "customer_ref": "gulfhorizon.example"},
]
CUSTOMER = {"ref": "gulfhorizon.example", "name": "Gulf Horizon Contracting Co. W.L.L.", "domain": "gulfhorizon.example"}


def by_kind(tags, kind):
    return {t["key"]: t for t in tags if t["kind"] == kind}


def test_tag_customer_full_picture():
    tags = tag_customer(CUSTOMER, EMAILS, PROJECTS, OUR_SERVICES, now=NOW)
    for t in tags:
        assert set(t) >= {"tag", "kind", "key", "evidence", "confidence", "source"} and t["source"] == "auto"
        assert 0 < t["confidence"] <= 0.95
    role = by_kind(tags, "role")
    assert "main_contractor" in role and role["main_contractor"]["tag"] == "Main contractor"
    sectors = by_kind(tags, "sector")
    assert {"tower", "hospital", "government_building"} <= set(sectors)
    assert "oil_gas" not in sectors  # e5 belongs to another customer
    assert any("Al Noor Tower" in e["quote"] for e in sectors["tower"]["evidence"])
    needs = by_kind(tags, "need")
    assert {"bmu", "wce"} <= set(needs)
    assert needs["bmu"]["confidence"] > needs["wce"]["confidence"]
    assert needs["bmu"]["offered"] is True and needs["bmu"]["tag"] == "Building Maintenance Units"
    assert set(by_kind(tags, "behaviour")) == {"tender_participant", "repeat_enquirer", "reminder_sender"}
    rel = by_kind(tags, "relationship")
    assert {"active", "quoted", "lost"} <= set(rel) and "new" not in rel
    kinds = [t["kind"] for t in tags]
    assert kinds == sorted(kinds, key=["role", "sector", "need", "behaviour", "relationship"].index)


def test_tag_customer_with_api_shapes_and_arabic():
    customer = {"name": "وزارة الأشغال العامة", "domain": "gmail.com", "kind": "other", "country": "KW"}
    emails = [{"subject": "طلب عرض سعر", "from_email": "mpw.projects@gmail.com", "date": "2026-09-10T08:00:00",
               "category": "other",
               "body_text": "نرجو تزويدنا بعرض سعر لصيانة وحدة صيانة المباني في مستشفى الجهراء.\nمع التحية،\nإدارة المشاريع"}]
    projects = [{"name": "مستشفى الجهراء", "service_family": "bmu", "summary": None, "location": None,
                 "owner_client": None, "request_kind": "direct_rfq"}]
    tags = tag_customer(customer, emails, projects, OUR_SERVICES, now=NOW)
    assert "government" in by_kind(tags, "role")
    assert "hospital" in by_kind(tags, "sector")
    assert "bmu" in by_kind(tags, "need")
    assert "new" in by_kind(tags, "relationship")


def test_dormant_and_kind_from_record():
    customer = {"name": "Old Builders", "domain": "old.example", "kind": "consultant", "kind_confidence": 0.9}
    emails = [{"from_email": "a@old.example", "subject": "Hello", "date": "2024-01-01T00:00:00Z", "body_text": "Hi"}]
    tags = tag_customer(customer, emails, [], OUR_SERVICES, now=NOW)
    assert by_kind(tags, "role")["consultant"]["confidence"] == 0.9
    assert "dormant" in by_kind(tags, "relationship")


def test_tag_customers_batch_groups_by_ref_and_domain():
    customers = [CUSTOMER, {"ref": "someone-else.example", "name": "Someone Else Refining Services",
                            "domain": "someone-else.example"}]
    out = tag_customers(customers, EMAILS, PROJECTS, OUR_SERVICES, now=NOW)
    assert set(out) == {"gulfhorizon.example", "someone-else.example"}
    assert "oil_gas" in by_kind(out["someone-else.example"], "sector")
    assert "tower" in by_kind(out["gulfhorizon.example"], "sector")
