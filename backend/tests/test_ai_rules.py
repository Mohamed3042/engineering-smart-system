"""RuleClassifier: deterministic classification of realistic synthetic emails (English + Arabic)."""
from __future__ import annotations

import json

import pytest

from ess.ai.guards import verify_evidence
from ess.ai.rules import DEFAULT_CATEGORIES, RuleClassifier

OWN = ["medmack.com"]


def mail(subject, body, sender="someone@company.example", name="", **extra):
    return {"subject": subject, "body_text": body, "from_email": sender, "from_name": name, **extra}


EMAILS = [
    # (id, email, expected category, customer request, request_kind or None)
    ("bmu_tender_en", mail(
        "RFQ – Building Maintenance Unit for Marjan Crest Tower – Tender MCT/2026/044",
        "Dear Sales Team,\nWe are participating in the tender for Marjan Crest Tower. Kindly submit your best quotation "
        "for the design, supply and installation of the BMU with telescopic jib.\nTender closing date: 15 November 2026.",
        "t.mansour@sadeem-nexa.example", "Tariq Al-Mansour"), "bmu", True, "tender_rfq"),
    ("wce_monorail_ar", mail(
        "طلب عرض سعر – نظام تنظيف الواجهات (مونوريل)",
        "السادة شركة ميدماك المحترمين،\nنرجو تزويدنا بعرض سعر لتوريد وتركيب نظام تنظيف الواجهات (مونوريل) مع "
        "عربة تنظيف معلقة لمبنى المستشفى.\nآخر موعد لاستلام العروض: ٢٠٢٦/١٠/٢٠",
        "procurement@qaseer-coastal.example"), "wce", True, "direct_rfq"),
    ("davit_en", mail(
        "Enquiry: davit arms and roof anchors for residential building",
        "Hello, we require 8 portable davit arms with sockets and a roof anchor point system. Please send your "
        "quotation with delivery time.", "pm@nasma-build.example"), "wce", True, "direct_rfq"),
    ("hoist_rental", mail(
        "Rental enquiry - passenger hoist 12 months",
        "Dear Sir, we need one twin-cage rack and pinion passenger hoist on rental basis for 12 months. Kindly send "
        "your rental offer.", "y.hajri@tilalzenon.example"), "hoist", True, "direct_rfq"),
    ("temporary_gondola", mail(
        "Temporary gondola rental – 6 m",
        "We require two temporary gondolas (suspended platforms) for facade works at our site. Please send your "
        "rental offer.", "site@build.example"), "cradle", True, "direct_rfq"),
    ("scaffolding_ar", mail(
        "استفسار عن سقالات",
        "نحتاج سقالات كب لوك لمبنى من ٨ طوابق، الرجاء تزويدنا بعرض أسعار للإيجار الشهري.",
        "eng@binaa-co.example"), "scaffolding", True, "direct_rfq"),
    ("scissor_lift", mail(
        "Scissor lift and boom lift hire",
        "Please quote for hire of 2 scissor lifts (12 m working height) and one 20 m boom lift for 3 months.",
        "ops@fitout.example"), "access_rental", True, "direct_rfq"),
    ("space_frame", mail(
        "Car park shade structure - request for quotation",
        "Request for quotation for a space frame car park shade structure, approx. 1,200 m2, as per attached drawings.",
        "estimation@gulfcanopy.example"), "space_frame", True, "direct_rfq"),
    ("bmu_amc", mail(
        "Annual maintenance contract for BMU gondolas",
        "We invite you to quote for the annual maintenance contract of our two BMU gondolas at Bayadir Walk Mall.",
        "fm@bayadir.example"), "bmu", True, "o_and_m"),
    ("vendor_pitch", mail(
        "Exclusive distributor offer – BMU & gondola systems",
        "We are a leading manufacturer of Building Maintenance Units and gondolas. We are looking for an exclusive "
        "distributor in Kuwait. Please find our catalogue and price list attached. Special offer for 2027.",
        "export@zenith-lifttech.example"), "vendor_offer", False, None),
    ("vendor_ar", mail(
        "عرض خاص من مصنع سقالات معلقة",
        "نحن شركة مصنعة للسقالات المعلقة والجندولا، نرسل لكم كتالوج المنتجات وقائمة الأسعار. نبحث عن موزع في الكويت.",
        "sales@factory-cn.example"), "vendor_offer", False, None),
    ("invoice_en", mail(
        "Tax Invoice INV-2026-0912 – mobile crane hire",
        "Please find attached Tax Invoice INV-2026-0912 for the 50-ton mobile crane. Amount due: KWD 1,850.000. "
        "Kindly arrange payment within 30 days.", "accounts@falconreach.example"), "bills", False, None),
    ("invoice_ar", mail(
        "فاتورة رقم ٤٥٥ – كشف حساب",
        "مرفق لكم الفاتورة رقم ٤٥٥ وكشف حساب شهر سبتمبر، يرجى السداد خلال ٣٠ يوماً.",
        "finance@supplier.example"), "bills", False, None),
    ("newsletter", mail(
        "October Newsletter: BMU safety webinar & 20% off training",
        "Register now for our free webinar on BMU safety. Early-bird offer: 20% off training. Unsubscribe | View in "
        "browser", "news@facadeaccessworld.example", list_unsubscribe="<mailto:u@facadeaccessworld.example>"),
     "promotions", False, None),
    ("marketplace", mail(
        "New buying leads for gondola and cradle in your area",
        "Dear supplier, 5 new buyers are looking for products. Upgrade to Gold Supplier.",
        "service@alibaba.com"), "promotions", False, None),
    ("security_alert", mail(
        "Security alert: new sign-in to your account",
        "We noticed a new sign-in to your account from a new device. If this was you, you don't need to do anything.",
        "no-reply@accounts.example.com"), "notifications", False, None),
    ("internal", mail(
        "Site visit tomorrow – Marjan Crest BMU",
        "Team, the site visit for the BMU at Sharq is tomorrow at 9am. Please bring the measuring tape.",
        "colleague@medmack.com", "A. Colleague"), "internal", False, None),
    ("forwarded_rfq", mail(
        "Fwd: RFQ – BMU replacement – Fintas tower",
        "FYI\n---------- Forwarded message ---------\nPlease send your quotation for the replacement of the BMU roof "
        "car. Request for quotation attached.", "colleague@medmack.com"), "bmu", True, "direct_rfq"),
    ("personal", mail("Hello", "How are you? Lunch on Thursday?", "friend@mailbox.example"), "other", False, None),
]


@pytest.fixture(scope="module")
def classifier() -> RuleClassifier:
    return RuleClassifier(own_domains=OWN)


@pytest.mark.parametrize("case_id, email, category, is_request, kind", EMAILS, ids=[e[0] for e in EMAILS])
def test_realistic_emails(classifier, case_id, email, category, is_request, kind):
    result = classifier.classify(email)
    assert result["category"] == category, result
    assert result["is_customer_request"] is is_request, result
    assert result["request_kind"] == kind
    assert 0.3 <= result["confidence"] <= 0.95
    if is_request:
        assert result["priority"] == "high"
    if category in ("promotions", "vendor_offer", "other"):
        assert result["priority"] == "low"


@pytest.mark.parametrize("case_id, email, category, is_request, kind", EMAILS, ids=[e[0] for e in EMAILS])
def test_rule_evidence_is_verbatim(classifier, case_id, email, category, is_request, kind):
    result = classifier.classify(email)
    sources = {"subject": email["subject"], "body": email["body_text"], "from": email["from_email"],
               "attachments": "", "headers": email.get("list_unsubscribe") or ""}
    if category != "other":
        assert result["evidence"], result
    stats = verify_evidence({"evidence": [dict(e) for e in result["evidence"]]}, sources)
    assert stats["quotes_failed"] == 0
    assert all(e["source"] in sources for e in result["evidence"])


def test_list_unsubscribe_does_not_hide_a_strong_customer_request(classifier):
    tender_portal = mail("RFQ – Building Maintenance Unit – Tender No. 2026/77",
                         "Request for quotation: supply and installation of a BMU with telescopic jib and roof car. "
                         "Please quote before the closing date.", "tenders@portal.example",
                         list_unsubscribe="<https://portal.example/unsub>")
    result = classifier.classify(tender_portal)
    assert result["category"] == "bmu" and result["is_customer_request"] is True


def test_subject_outweighs_signature_keywords(classifier):
    email = mail("Invoice 2207 for September", "Please find the invoice attached.\n--\nMedmack | BMU | Gondola | "
                 "Monorail | Cradles", "accounts@vendor.example")
    assert classifier.classify(email)["category"] == "bills"


def test_quoted_history_counts_less(classifier):
    email = mail("Re: meeting", "Thanks, see you tomorrow.\n\n> On Monday you wrote:\n> please quote for the BMU "
                 "gondola and the monorail davit system", "partner@company.example")
    assert classifier.classify(email)["category"] in ("other", "other_work")
    assert classifier.classify(email)["is_customer_request"] is False


def test_restricted_category_list_and_merged_keywords(tmp_path):
    cats_file = tmp_path / "default_categories.json"
    cats_file.write_text(json.dumps({"version": 1, "categories": [
        {"key": "glazing", "label": "Glazing works", "group": "work",
         "keywords": {"en": ["curtain wall glazing", "glass panel replacement"], "ar": ["تركيب زجاج"]},
         "negative_keywords": {"en": ["glass cleaning"], "ar": []}},
    ]}), encoding="utf-8")
    rc = RuleClassifier(own_domains=OWN, categories_file=cats_file)
    res = rc.classify(mail("Glass panel replacement – please quote", "We need a quotation for curtain wall glazing "
                                                                     "repairs at our tower.", "fm@tower.example"))
    assert res["category"] == "glazing" and res["is_customer_request"] is True
    res_ar = rc.classify(mail("طلب عرض سعر", "نرجو تزويدنا بعرض سعر لتركيب زجاج الواجهة", "a@b.example"))
    assert res_ar["category"] == "glazing"
    only = RuleClassifier([{"key": "bmu", "label": "BMU", "group": "work"}, {"key": "other", "label": "Other",
                                                                             "group": "other"}], categories_file=None)
    assert set(only.categories) == {"bmu", "other"}
    assert only.classify(mail("Invoice 22", "Please pay the invoice"))["category"] == "other"


def test_own_domains_can_come_with_the_email_payload():
    rc = RuleClassifier()  # the pipeline passes ws.own_domains inside the payload
    email = mail("Site visit tomorrow – BMU", "Team, site visit for the BMU tomorrow.", "colleague@medmack.com",
                 own_domains=["medmack.com"])
    assert rc.classify(email)["category"] == "internal"
    assert rc.classify({**email, "own_domains": []})["category"] == "bmu"


def test_default_categories_cover_the_snapshot_table():
    keys = {c["key"] for c in DEFAULT_CATEGORIES}
    assert keys == {"bmu", "wce", "cradle", "hoist", "crane", "access_rental", "scaffolding", "space_frame",
                    "other_work", "vendor_offer", "bills", "promotions", "internal", "notifications", "other"}
