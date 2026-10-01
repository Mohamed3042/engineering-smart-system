"""The qualification exam: synthetic cases with deterministic checks and golden answers.

Every company, person, project and domain below is invented (``*.example`` domains). Each case
runs through the real task code (``ess.ai.tasks``) so prompts *and* guards are examined. Checks
read the finalised result; ``critical`` checks catch the failures the user never wants to see:
an invented date or value, a fabricated quote, a price, a supplier mistaken for a customer, a
guessed dimension. ``golden`` is the ideal raw model answer for the case (used by the self-test
and as the reference for reviewers).
"""
from __future__ import annotations

import copy
import functools
import hashlib
import io
import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .guards import normalize_text, numbers_in
from .rules import DEFAULT_CATEGORIES
from .tasks import TaskRequest, prepare

EXAM_SUITE = "ess-exam-1"
CASE_PASS_SCORE = 0.75


@dataclass(frozen=True)
class Check:
    name: str
    fn: Callable[[dict], tuple[bool, str]]
    weight: float = 1.0
    critical: bool = False


@dataclass
class ExamCase:
    id: str
    task: str
    title: str
    inputs: Callable[[], dict]  # kwargs for tasks.prepare(task, **inputs)
    checks: list[Check]
    golden: dict
    needs_vision: bool = False
    fingerprint: Any = None  # what identifies the inputs for EXAM_VERSION (defaults to the inputs)
    _request: TaskRequest | None = field(default=None, repr=False)

    def request(self) -> TaskRequest:
        if self._request is None:
            self._request = prepare(self.task, **self.inputs())
        return self._request


# --------------------------------------------------------------------------------------------
# check helpers
# --------------------------------------------------------------------------------------------

def _get(obj: Any, path: str) -> Any:
    cur = obj
    for part in path.replace("]", "").replace("[", ".").split("."):
        if part == "":
            continue
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def _n(value: Any) -> str:
    return normalize_text("" if value is None else str(value))


def eq(path: str, expected: Any, weight: float = 1.0, critical: bool = False) -> Check:
    def fn(r: dict) -> tuple[bool, str]:
        got = _get(r, path)
        return _n(got) == _n(expected), f"{path} = {got!r}, expected {expected!r}"
    return Check(f"{path} == {expected}", fn, weight, critical)


def one_of(path: str, values: list[Any], weight: float = 1.0, critical: bool = False) -> Check:
    def fn(r: dict) -> tuple[bool, str]:
        got = _get(r, path)
        return _n(got) in {_n(v) for v in values} or (got is None and None in values), \
            f"{path} = {got!r}, accepted {values!r}"
    return Check(f"{path} in {values}", fn, weight, critical)


def is_null(path: str, weight: float = 1.0, critical: bool = True) -> Check:
    def fn(r: dict) -> tuple[bool, str]:
        got = _get(r, path)
        return got is None, f"{path} = {got!r} (must be null: not stated in the source)"
    return Check(f"{path} is null", fn, weight, critical)


def contains(path: str, needle: str, weight: float = 1.0, critical: bool = False) -> Check:
    def fn(r: dict) -> tuple[bool, str]:
        got = _get(r, path)
        return _n(needle) in _n(got), f"{path} = {got!r}, expected to contain {needle!r}"
    return Check(f"{path} contains {needle}", fn, weight, critical)


def custom(name: str, fn: Callable[[dict], tuple[bool, str]], weight: float = 1.0, critical: bool = False) -> Check:
    return Check(name, fn, weight, critical)


def _quotes_ok(r: dict) -> tuple[bool, str]:
    ev = (r.get("guard_report") or {}).get("evidence") or {}
    failed = ev.get("quotes_failed", 0)
    sample = "; ".join(f"{f.get('quote')!r}" for f in (ev.get("failures") or [])[:3])
    return failed == 0, f"{failed} quote(s) not found in the sources {sample}".strip()


def _facts_ok(r: dict) -> tuple[bool, str]:
    gr = r.get("guard_report") or {}
    flags = gr.get("flags") or []
    ev = gr.get("evidence") or {}
    missing = ev.get("facts_without_evidence", 0)
    ok = not flags and not missing
    return ok, f"{len(flags)} value(s) not readable in their quote {[f.get('flag') + ':' + str(f.get('path')) for f in flags[:4]]}; " \
               f"{missing} fact(s) without evidence"


def _no_prices(r: dict) -> tuple[bool, str]:
    removed = (r.get("guard_report") or {}).get("prices_removed") or []
    return not removed, f"{len(removed)} price(s) produced and removed: {removed[:3]}"


NO_FABRICATED_QUOTES = Check("no fabricated or paraphrased quotes", _quotes_ok, 2.0, True)
FACTS_SUPPORTED = Check("every value is readable in its quote", _facts_ok, 2.0, True)
NO_PRICES = Check("no prices produced", _no_prices, 2.0, True)


def _verified_quote(r: dict) -> tuple[bool, str]:
    ev = (r.get("guard_report") or {}).get("evidence") or {}
    return ev.get("quotes_verified", 0) >= 1, f"{ev.get('quotes_verified', 0)} verified quote(s)"


HAS_VERIFIED_QUOTE = Check("at least one verified quote", _verified_quote, 1.0, False)


def _texts(obj: Any) -> list[str]:
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k not in ("guard_report", "evidence"):
                out += _texts(v)
    elif isinstance(obj, list):
        for v in obj:
            out += _texts(v)
    elif isinstance(obj, str):
        out.append(obj)
    return out


# --------------------------------------------------------------------------------------------
# golden-answer helpers
# --------------------------------------------------------------------------------------------

def ev(quote: str, source: str = "thread") -> dict:
    return {"quote": quote, "source": source}


def fact(value: Any, quote: str | None = None, source: str = "thread") -> dict:
    return {"value": value, "evidence": ev(quote, source) if quote else None}


NULL = fact(None)


def dfact(value: str | None, transcription: str | None = None, location: str | None = None,
          confidence: float = 0.9, unit: str | None = None) -> dict:
    return {"value": value, "unit": unit, "transcription": transcription, "location": location,
            "confidence": confidence if value is not None else 0.0, "readable": value is not None}


DNULL = dfact(None)

# --------------------------------------------------------------------------------------------
# Source material
# --------------------------------------------------------------------------------------------

BMU_BODY = """Dear Sir,

We are participating in the tender for Marjan Crest Tower, Plot 7, Sharq, Kuwait City (Tender No. MCT/2026/044). The owner is Marjan Crest Real Estate Co. and the consultant is Arcline Seven Engineering Consultants.

Kindly submit your best quotation for the design, supply, installation, testing and commissioning of the Building Maintenance Unit (BMU) system as per the attached specification section 14 91 00.

The tender closing date is 15 November 2026. Please send your offer no later than 8 November 2026 so we can include it in our bid.

Main requirements:
- Roof-mounted BMU with telescopic jib to serve all façades
- Building height 168 m, 42 floors
- Facade type: unitised curtain wall

Best regards,
Tariq Al-Mansour
Estimation Department
Sadeem Nexa Contracting Co."""

EMAIL_BMU = {
    "id": "exam-c01", "thread_id": "exam-c01", "direction": "inbound", "from_name": "Tariq Al-Mansour",
    "from_email": "t.almansour@sadeem-nexa.example", "to": ["sales@medmack.com"], "cc": [],
    "subject": "RFQ – BMU for Marjan Crest Tower – Tender No. MCT/2026/044", "date": "2026-09-14T07:45:00Z",
    "body_text": BMU_BODY, "labels": ["INBOX"], "list_unsubscribe": None,
    "attachments": [{"filename": "MCT_Spec_Section_14_91_00.pdf", "mime": "application/pdf", "size": 482113}],
}
BMU_THREAD = f"From: {EMAIL_BMU['from_name']} <{EMAIL_BMU['from_email']}>\nDate: 2026-09-14 07:45\nSubject: {EMAIL_BMU['subject']}\n\n{BMU_BODY}"
BMU_SPEC = """SECTION 14 91 00 – FACADE ACCESS EQUIPMENT (BMU)
2.1 The BMU shall have a safe working load of 250 kg with two persons in the cradle.
2.2 The cradle length shall be 6.0 m.
2.3 Design to EN 1808 and BS 6037-1.
3.1 The Contractor shall provide 2 years warranty and 12 months free maintenance after handover."""

WCE_BODY = """السادة / شركة ميدماك المحترمين،
تحية طيبة وبعد،

نرجو تزويدنا بعرض سعر لتوريد وتركيب نظام تنظيف الواجهات (مونوريل) مع عربة تنظيف معلقة لمبنى مستشفى النخيل الأزرق التخصصي – منطقة الجهراء.

طول المسار التقريبي ١٢٠ متر حول السطح، وارتفاع المبنى ٣٦ متر.

آخر موعد لاستلام العروض: ٢٠٢٦/١٠/٢٠

Please also confirm the delivery period.

مع التحية،
م. ريم الشمري
قسم المشتريات – شركة قصير الساحلية للمقاولات"""

EMAIL_WCE = {
    "id": "exam-c03", "thread_id": "exam-c03", "direction": "inbound", "from_name": "م. ريم الشمري",
    "from_email": "procurement@qaseer-coastal.example", "to": ["sales@medmack.com"], "cc": [],
    "subject": "طلب عرض سعر – نظام تنظيف الواجهات (مونوريل) – مستشفى النخيل الأزرق التخصصي",
    "date": "2026-09-16T06:10:00Z", "body_text": WCE_BODY, "labels": ["INBOX"], "attachments": [],
    "list_unsubscribe": None,
}
WCE_THREAD = f"From: {EMAIL_WCE['from_name']} <{EMAIL_WCE['from_email']}>\nDate: 2026-09-16 06:10\nSubject: {EMAIL_WCE['subject']}\n\n{WCE_BODY}"

EMAIL_VENDOR = {
    "id": "exam-c05", "direction": "inbound", "from_name": "Lukas Brenner",
    "from_email": "l.brenner@zenith-lifttech.example", "to": ["sales@medmack.com"], "cc": [],
    "subject": "Zenith BMU & Gondola Systems – Exclusive Distributor Offer for Kuwait", "date": "2026-09-10T09:00:00Z",
    "body_text": """Dear Sir/Madam,

We are a leading manufacturer of Building Maintenance Units, gondolas and façade access equipment based in Stuttgart, Germany.

We are looking for an exclusive distributor in Kuwait and would like to offer you special distributor prices for 2027. Please find our catalogue attached.

If you have a project, simply request a quote on our website and our team will respond within 24 hours.

Kind regards,
Lukas Brenner
Export Sales Manager
Zenith Lifttech GmbH""",
    "attachments": [{"filename": "Zenith_Catalogue_2026.pdf", "mime": "application/pdf", "size": 8812001}],
    "labels": ["INBOX"], "list_unsubscribe": None,
}

EMAIL_INVOICE = {
    "id": "exam-c06", "direction": "inbound", "from_name": "Falcon Reach Crane Hire – Accounts",
    "from_email": "accounts@falconreach-cranes.example", "to": ["sales@medmack.com"], "cc": [],
    "subject": "Tax Invoice INV-2026-0912 – Mobile crane hire, September 2026", "date": "2026-09-30T10:15:00Z",
    "body_text": """Dear Medmack Accounts Team,

Please find attached Tax Invoice INV-2026-0912 for the 50-ton mobile crane hired for your Jahra site from 1 to 14 September 2026.

Amount due: KWD 1,850.000. Kindly arrange payment within 30 days to the bank account shown on the invoice.

Regards,
Accounts Department
Falcon Reach Crane Hire""",
    "attachments": [{"filename": "INV-2026-0912.pdf", "mime": "application/pdf", "size": 120332}],
    "labels": ["INBOX"], "list_unsubscribe": None,
}

EMAIL_NEWS = {
    "id": "exam-c07", "direction": "inbound", "from_name": "Facade Access World",
    "from_email": "news@facadeaccessworld.example", "to": ["sales@medmack.com"], "cc": [],
    "subject": "October Newsletter: BMU safety webinar, new gondola standards & 20% off training",
    "date": "2026-10-01T05:00:00Z", "list_unsubscribe": "<mailto:unsubscribe@facadeaccessworld.example>",
    "body_text": """FACADE ACCESS WORLD – OCTOBER NEWSLETTER

Register now for our free webinar "BMU safety inspections in hot climates" on 22 October.
New gondola standards: what changes for building owners in 2027.
Early-bird offer: 20% off all rope-access training courses booked this month.

You are receiving this email because you subscribed to Facade Access World.
Unsubscribe | View in browser""",
    "attachments": [], "labels": ["INBOX", "CATEGORY_PROMOTIONS"],
}

THREAD_EXTENSION = """From: Hamad Al-Rashidi <h.rashidi@bayadir-fm.example>
Date: 2026-09-02 09:10
Subject: Enquiry – annual maintenance of BMU gondolas – Bayadir Walk Mall

Dear Medmack team,
We invite you to quote for the annual maintenance contract of the two existing BMU gondolas at Bayadir Walk Mall, Salmiya.
Our closing date for quotations is 12 October 2026.
Regards,
Hamad Al-Rashidi
Facility Management Department

From: Hamad Al-Rashidi <h.rashidi@bayadir-fm.example>
Date: 2026-09-28 13:22
Subject: RE: Enquiry – annual maintenance of BMU gondolas – Bayadir Walk Mall

Dear All,
Please note that the closing date has been extended to 26 October 2026 at the request of several bidders. All other terms remain unchanged.
Regards,
Hamad Al-Rashidi"""

THREAD_ADDENDUM = """From: Tender Committee <tenders@qurain-waterfront.example>
Date: 2026-09-20 11:05
Subject: Addendum No. 2 – Qurain Waterfront Residences – Facade Access Equipment Package

Dear Bidders,
Please find below Addendum No. 2 to the tender documents (Tender Ref. QWR/FA/2026/07) for the monorail and davit system.
1. The parapet height at roof level is revised from 1.10 m to 1.40 m.
2. Two additional davit sockets are required at the east elevation (total 14 nos).
3. The tender closing date remains unchanged: 29 October 2026.
This addendum forms part of the contract documents.
Tender Committee"""

THREAD_MISSING = """From: Faisal <faisal.k@mailbox.example>
Date: 2026-09-25 18:40
Subject: cradle

Dear Sir, we need a cradle for our building. Please send your best offer.
Regards, Faisal"""

PROJECT_PRICE_TRAP = {
    "ref": "P-EXAM-NARJIS-CLINIC", "name": "Narjis Polyclinic Extension, Hawally",
    "service_family": "wce", "work_type": "supply_installation", "request_kind": "direct_rfq",
    "customer": {"name": "Nasma Building Contracting Co.", "contact": "Eng. Omar Haddad"},
    "location": "Hawally, Kuwait",
    "summary": ("Supply and installation of a roof monorail window cleaning system with a motorised trolley and a "
                "4 m cleaning cradle for a new 6-storey polyclinic extension. The customer says a competitor offered "
                "KWD 18,500 for the same scope and asked us to beat it."),
    "scope_items": [
        {"description": "Stainless steel monorail track fixed to the roof slab soffit", "qty": 64, "unit": "m"},
        {"description": "Motorised monorail trolley with hoist", "qty": 1, "unit": "no"},
        {"description": "Aluminium cleaning cradle, 4 m long", "qty": 1, "unit": "no"},
    ],
    "requirements": [{"field": "building_height", "label": "Building height", "value": "26 m"},
                     {"field": "floors", "label": "Floors", "value": "6"}],
    "unresolved_questions": ["Roof slab thickness for the track fixings is not stated."],
    "customer_notes": "Customer email: our budget is tight; the other supplier quoted 18,500 for everything, "
                      "please beat that price.",
}

THREAD_EVIDENCE_TRAP = """From: Dalal Al-Ajmi <d.alajmi@horizonarc-holding.example>
Date: 2026-09-18 10:02
Subject: Enquiry - facade access for Mirqab Horizon Tower

Good morning,
Mirqab Horizon Tower in Kuwait City rises to roughly one hundred and forty-five metres (145 m) above the podium roof, with 38 typical office floors and a crown structure.
We are looking for a suitable façade access solution covering both the curved north elevation and the flat south elevation. Please advise the recommended system and send your quotation.
Kindly submit your offer before 30 October 2026."""

DRAWING_TEXT = """MARJAN CREST TOWER
ROOF PLAN – BMU TRACK & DAVIT LAYOUT
DRAWING NO: MCT-AR-RF-301        REV: C        SCALE: 1:200 @ A1
DATE: 02/09/2026        DRAWN: K.M.        CHECKED: R.S.
NOTES:
1. TOP OF ROOF SLAB LEVEL +168.00
2. PARAPET HEIGHT 1.20 M ABOVE FINISHED ROOF LEVEL
3. BMU TRACK: TWIN RAIL, 220 M TOTAL LENGTH, REFER TO STRUCTURAL DRAWINGS FOR EMBEDS
4. DAVIT SOCKETS D1–D8 AT UPPER ROOF
5. ALL DIMENSIONS IN MILLIMETRES UNLESS NOTED OTHERWISE
CONSULTANT: ARCLINE SEVEN ENGINEERING CONSULTANTS"""

BOQ_TEXT = """BILL OF QUANTITIES – FACADE ACCESS EQUIPMENT (Tender Ref. QWR/FA/2026/07)
Item | Description | Unit | Qty | Rate (KWD) | Amount (KWD)
1.01 | Monorail track, stainless steel 316, including brackets and fixings | m | 84 | |
1.02 | Motorised monorail trolley complete with hoist units | nos | 2 | |
1.03 | Davit arm, portable, aluminium | nos | 6 | |
1.04 | Davit socket, cast-in, galvanised | nos | 14 | |
1.05 | Cleaning cradle, 4.0 m, aluminium | nos | 2 | |
1.06 | Testing, commissioning and third-party certification | LS | 1 | |"""

THREAD_MIXED = """From: Yousef Al-Hajri <y.alhajri@tilalzenon.example>
Date: 2026-09-22 08:30
Subject: Rental enquiry – hoist and cradles – Tilal Residential Tower B

Dear Sir,
For our project Tilal Residential Tower B in Mahboula, we require the following on rental basis for 12 months starting 1 December 2026:
1) One twin-cage rack and pinion passenger/material hoist, 2,000 kg per cage, mast height 95 m.
2) Two temporary suspended cradles (gondolas), 6 m length each, for façade works.
Kindly send your rental offer including installation, dismantling and monthly maintenance by 10 October 2026.
Regards,
Yousef Al-Hajri
Tilal Zenon Contracting Co."""

RESEARCH_CUSTOMER = {"name": "Tilal Zenon Contracting Co.", "domain": "tilalzenon.example", "country": "KW"}
RESEARCH_RESULTS = [
    {"url": "https://tilalzenon.example/about", "title": "About Tilal Zenon Contracting",
     "snippet": "Tilal Zenon Contracting Co. – building contractor in Kuwait since 2004.",
     "text": ("Tilal Zenon Contracting Co. was founded in 2004 in Kuwait. The company specialises in residential "
              "towers and mixed-use buildings and employs around 850 staff. Recent projects include Tilal "
              "Residential Tower A, completed in 2023, and the Fintas Gate Mall extension, completed in 2025.")},
    {"url": "https://news.example/kw/2026/08/tilal-zenon-mahboula", "title": "Tilal Zenon wins Mahboula towers contract",
     "snippet": "The developer announced the award on 3 August 2026.",
     "text": ("Tilal Zenon Contracting Co. has been awarded the main construction contract for two residential towers "
              "in Mahboula, the developer announced on 3 August 2026. Construction is expected to start in "
              "December 2026.")},
    {"url": "https://tilal-logistics.example", "title": "Tilal Logistics – freight forwarding in Dubai",
     "snippet": "Tilal Logistics LLC, Dubai.",
     "text": "Tilal Logistics LLC is a freight forwarding company based in Dubai operating 120 trucks across the UAE."},
]

DISCOVER_EXCERPTS = [
    {"source_type": "own_quotation", "source_id": "AA/26/0101", "label": "Quotation AA/26/0101 – Marjan Crest Tower",
     "text": ("Supply, installation, testing and commissioning of one roof-mounted Building Maintenance Unit (BMU) with "
              "telescopic jib and 6 m cradle. Validity: 30 days from the date of this quotation. All prices are in "
              "Kuwaiti Dinars (KWD).")},
    {"source_type": "sent_mail", "source_id": "msg-sent-77", "label": "Sent: BMU maintenance offer",
     "text": ("Further to our call, we confirm that our team can carry out the annual maintenance of your gondolas "
              "(BMU) at the Marina Heights building, including monthly inspections and emergency call-outs.")},
    {"source_type": "own_quotation", "source_id": "AA/26/0118", "label": "Quotation AA/26/0118 – window cleaning",
     "text": "Window cleaning monorail system with motorised trolley and davit arms, as per EN 1808."},
    {"source_type": "inbound_mail", "source_id": "msg-in-310", "label": "Inbound: scaffolding supplier",
     "text": ("We are a scaffolding manufacturer from Turkey offering ringlock scaffolding systems at special prices "
              "for your projects.")},
    {"source_type": "web", "source_id": "https://facade-glossary.example/gcc", "label": "Web: GCC facade glossary",
     "text": ("In the GCC, building maintenance units are often simply called gondolas, and temporary suspended "
              "platforms are called cradles.")},
]
REGION_TERMS = {"gondola": "In Kuwait 'gondola' (جندولا) may mean a BMU or a temporary cradle."}
KNOWLEDGE = {"company_name": "Medmack (exam workspace)", "own_domains": ["medmack.com"],
             "services": ["bmu", "wce", "cradle", "hoist", "access_rental"], "region": "Kuwait / GCC",
             "currency": "KWD"}

# --------------------------------------------------------------------------------------------
# The drawing image for the vision case (rendered at run time; the spec below is what is hashed)
# --------------------------------------------------------------------------------------------

DRAWING_IMAGE_SPEC = {
    "size": [1600, 1000],
    "title_block": ["PROJECT: NAJMA RESIDENCES", "TITLE: ROOF PLAN - MONORAIL LAYOUT", "DRG NO: NR-AR-RF-205",
                    "REV: B", "SCALE: 1:100"],
    "plan_labels": [("MONORAIL M1", (380, 175)), ("ROOF LEVEL +42.60", (400, 380)), ("DAVIT SOCKET (TYP.)", (620, 560))],
    "redacted_label": ("BUILDING HEIGHT:", (150, 720)),
}


@functools.lru_cache(maxsize=1)
def drawing_image_png() -> bytes:
    """A synthetic roof-plan sheet: readable title block, one dimension hidden under a black box."""
    from PIL import Image, ImageDraw, ImageFont

    spec = DRAWING_IMAGE_SPEC
    img = Image.new("RGB", tuple(spec["size"]), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=30)
        small = ImageFont.load_default(size=24)
    except TypeError:  # very old Pillow: bitmap font only
        font = small = ImageFont.load_default()
    w, h = spec["size"]
    draw.rectangle([20, 20, w - 20, h - 20], outline="black", width=4)
    draw.rectangle([150, 150, 950, 650], outline="black", width=5)  # roof outline
    for x in range(170, 930, 40):  # monorail (dashed) along the north edge
        draw.line([x, 210, x + 22, 210], fill="black", width=4)
    for (x, y) in ((180, 600), (900, 600), (180, 200), (900, 200)):
        draw.ellipse([x - 9, y - 9, x + 9, y + 9], outline="black", width=3)
    for text, (x, y) in spec["plan_labels"]:
        draw.text((x, y), text, fill="black", font=small)
    label, (x, y) = spec["redacted_label"]
    draw.text((x, y), label, fill="black", font=font)
    draw.rectangle([x + 300, y - 4, x + 470, y + 38], fill="black")  # the value is covered
    tb = [960, 700, w - 40, h - 40]
    draw.rectangle(tb, outline="black", width=4)
    for i, line in enumerate(spec["title_block"]):
        draw.text((tb[0] + 20, tb[1] + 14 + i * 46), line, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# --------------------------------------------------------------------------------------------
# Case-specific checks
# --------------------------------------------------------------------------------------------

def _req_with(r: dict, number: float) -> bool:
    return any(number in numbers_in(str(q.get("value"))) for q in r.get("requirements") or [])


def _scope_has(r: dict, *words: str) -> bool:
    return any(any(_n(w) in _n(i.get("description")) for w in words) for i in r.get("scope_items") or [])


def _scope_qty(r: dict, word: str) -> Any:
    for i in r.get("scope_items") or []:
        if _n(word) in _n(i.get("description")):
            return i.get("qty")
    return None


def _change(r: dict, kind: str) -> dict | None:
    return next((c for c in r.get("changes") or [] if c.get("kind") == kind), None)


def _deadline_change_ok(r: dict) -> tuple[bool, str]:
    c = _change(r, "deadline_changed")
    if not c:
        return False, "no deadline_changed change reported"
    ok = c.get("old_value") == "2026-10-12" and c.get("new_value") == "2026-10-26"
    return ok, f"deadline change {c.get('old_value')} -> {c.get('new_value')} (expected 2026-10-12 -> 2026-10-26)"


def _no_numeric_requirements(r: dict) -> tuple[bool, str]:
    bad = [q for q in r.get("requirements") or [] if numbers_in(str(q.get("value")))]
    return not bad, f"{len(bad)} numeric requirement(s) invented: {[q.get('value') for q in bad][:3]}"


def _questions(min_count: int) -> Callable[[dict], tuple[bool, str]]:
    def fn(r: dict) -> tuple[bool, str]:
        n = len(r.get("unresolved_questions") or [])
        return n >= min_count, f"{n} unresolved question(s), need {min_count}"
    return fn


def _no_competitor_price(r: dict) -> tuple[bool, str]:
    blob = " ".join(_texts({k: v for k, v in r.items() if k != "guard_report"}))
    hits = [t for t in ("18,500", "18500", "18.500", "KWD", "KD ", "dinar") if t.lower() in blob.lower()]
    return not hits, f"price traces in the draft: {hits}"


def _draft_items(r: dict) -> tuple[bool, str]:
    descs = " | ".join(_n(i.get("description")) for i in r.get("items") or [])
    ok = all(w in descs for w in ("monorail", "trolley", "cradle"))
    return ok, f"items: {descs[:200]}"


def _draft_qty(r: dict) -> tuple[bool, str]:
    for i in r.get("items") or []:
        if "track" in _n(i.get("description")):
            return i.get("qty") == 64, f"track qty {i.get('qty')} (expected 64)"
    return False, "no track item"


def _no_number_warnings(r: dict) -> tuple[bool, str]:
    warnings = (r.get("guard_report") or {}).get("warnings") or []
    flags = (r.get("guard_report") or {}).get("flags") or []
    return not warnings and not flags, f"warnings: {warnings[:2]} flags: {flags[:2]}"


def _ref(r: dict, kind: str) -> Any:
    return next((x.get("value") for x in r.get("references") or [] if x.get("kind") == kind), None)


def _fact_with(r: dict, number: float) -> bool:
    return any(number in numbers_in(str(f.get("value"))) for f in r.get("facts") or [])


def _pages_ok(r: dict) -> tuple[bool, str]:
    pages = []
    for coll in ("references", "facts", "boq_items", "dates"):
        for x in r.get(coll) or []:
            e = x.get("evidence") or {}
            pages.append(e.get("page"))
    return bool(pages) and all(p == 1 for p in pages), f"evidence pages: {sorted(set(map(str, pages)))}"


_BOQ_EXPECTED = {"1.01": 84, "1.02": 2, "1.03": 6, "1.04": 14, "1.05": 2, "1.06": 1}


def _boq_ok(r: dict) -> tuple[bool, str]:
    got = {str(i.get("item_no")): i.get("qty") for i in r.get("boq_items") or []}
    wrong = {k: got.get(k) for k, v in _BOQ_EXPECTED.items() if got.get(k) != v}
    return not wrong, f"wrong/missing quantities: {wrong}"


def _claims(r: dict) -> list[dict]:
    return [c for s in r.get("sections") or [] for c in s.get("claims") or []]


def _no_trap_claims(r: dict) -> tuple[bool, str]:
    bad = [c for c in _claims(r) if "tilal-logistics" in str(c.get("url") or "")]
    return not bad, f"{len(bad)} claim(s) taken from a different company with a similar name"


def _claims_min(n: int) -> Callable[[dict], tuple[bool, str]]:
    def fn(r: dict) -> tuple[bool, str]:
        ok = [c for c in _claims(r) if c.get("verified")]
        return len(ok) >= n, f"{len(ok)} verified claim(s)"
    return fn


def _claim_mentions(word: str) -> Callable[[dict], tuple[bool, str]]:
    def fn(r: dict) -> tuple[bool, str]:
        return any(_n(word) in _n(c.get("text")) for c in _claims(r)), f"claim mentioning {word!r}"
    return fn


def _knowledge(r: dict, kind: str, key: str) -> dict | None:
    return next((i for i in r.get("items") or [] if i.get("kind") == kind and _n(i.get("key")) == _n(key)), None)


def _bmu_strong(r: dict) -> tuple[bool, str]:
    item = _knowledge(r, "service_family", "bmu")
    return bool(item and item.get("weight", 0) >= 0.9), f"bmu service family: {item and item.get('weight')}"


def _no_scaffolding_family(r: dict) -> tuple[bool, str]:
    item = _knowledge(r, "service_family", "scaffolding")
    return item is None, "scaffolding listed as OUR service family (it came from a supplier's pitch)" if item else "ok"


def _drawing_value(r: dict, path: str) -> Any:
    return _get(r, path + ".value")


def _height_null(r: dict) -> tuple[bool, str]:
    v = _get(r, "building.height.value")
    return v is None, f"building height = {v!r} (it is hidden on the sheet: must be null)"


def _no_guess(r: dict) -> tuple[bool, str]:
    flags = (r.get("guard_report") or {}).get("flags") or []
    return not flags, f"{len(flags)} value(s) reported without being transcribed: {flags[:3]}"


def _monorail_mark(r: dict) -> tuple[bool, str]:
    marks = r.get("equipment_marks") or []
    return any(m.get("kind") == "monorail" or "monorail" in _n(m.get("label")) for m in marks), f"{len(marks)} mark(s)"


def _roof_level(r: dict) -> tuple[bool, str]:
    values = [_get(r, "building.roof_level.value")] + [lv.get("value") for lv in r.get("levels") or []]
    return any(42.6 in numbers_in(str(v)) for v in values if v), f"roof level values {values}"


# --------------------------------------------------------------------------------------------
# The cases
# --------------------------------------------------------------------------------------------

_CATS = DEFAULT_CATEGORIES


def _cases() -> list[ExamCase]:
    return [
        ExamCase(
            "C01_bmu_tender_classify", "classify_email", "BMU tender RFQ (English) is a customer request",
            lambda: {"email": EMAIL_BMU, "categories": _CATS, "knowledge": KNOWLEDGE},
            [eq("category", "bmu", 2, True), eq("is_customer_request", True, 2, True),
             eq("request_kind", "tender_rfq"), eq("priority", "high"), NO_FABRICATED_QUOTES, HAS_VERIFIED_QUOTE],
            {"category": "bmu", "confidence": 0.95,
             "reason": "A contractor asks us to quote the BMU system of a tower for a tender.",
             "evidence": [ev("RFQ – BMU for Marjan Crest Tower", "subject"),
                          ev("Kindly submit your best quotation for the design, supply, installation, testing and "
                             "commissioning of the Building Maintenance Unit (BMU) system", "body")],
             "priority": "high", "is_customer_request": True, "request_kind": "tender_rfq"}),
        ExamCase(
            "C02_bmu_tender_extract", "extract_request", "BMU tender: facts, deadline and requirements with evidence",
            lambda: {"thread_text": BMU_THREAD, "files": [{"name": "MCT_Spec_Section_14_91_00.pdf", "text": BMU_SPEC}],
                     "knowledge": KNOWLEDGE},
            [eq("service_family", "bmu", 2, True), eq("request_kind", "tender_rfq"),
             eq("work_type", "supply_installation"),
             one_of("due_date", ["2026-11-08", "2026-11-15"], 2, True), eq("due_date", "2026-11-08", 2),
             one_of("tender_no", ["MCT/2026/044", None], 1, True), eq("tender_no", "MCT/2026/044"),
             contains("consultant", "Arcline Seven"), contains("owner_client", "Marjan Crest Real Estate"),
             custom("building height 168 m reported", lambda r: (_req_with(r, 168), "requirements")),
             custom("safe working load 250 kg from the specification", lambda r: (_req_with(r, 250), "requirements")),
             NO_FABRICATED_QUOTES, FACTS_SUPPORTED, NO_PRICES],
            {"service_family": fact("bmu", "Building Maintenance Unit (BMU) system"),
             "work_type": fact("supply_installation", "design, supply, installation, testing and commissioning"),
             "request_kind": fact("tender_rfq", "We are participating in the tender for Marjan Crest Tower"),
             "due_date": fact("2026-11-08", "Please send your offer no later than 8 November 2026"),
             "tender_no": fact("MCT/2026/044", "Tender No. MCT/2026/044"),
             "location": fact("Plot 7, Sharq, Kuwait City", "Plot 7, Sharq, Kuwait City"),
             "owner_client": fact("Marjan Crest Real Estate Co.", "The owner is Marjan Crest Real Estate Co."),
             "consultant": fact("Arcline Seven Engineering Consultants",
                                "the consultant is Arcline Seven Engineering Consultants"),
             "main_contractor": NULL,
             "summary": ("Sadeem Nexa Contracting asks for a tender quotation for the design, supply, installation, "
                         "testing and commissioning of the BMU system of Marjan Crest Tower in Sharq."),
             "scope_items": [{"description": "Roof-mounted BMU with telescopic jib to serve all façades", "qty": None,
                              "unit": None, "evidence": ev("Roof-mounted BMU with telescopic jib to serve all façades")}],
             "requirements": [
                 {"field": "building_height", "label": "Building height", "value": "168 m",
                  "evidence": ev("Building height 168 m, 42 floors")},
                 {"field": "number_of_floors", "label": "Floors", "value": "42",
                  "evidence": ev("Building height 168 m, 42 floors")},
                 {"field": "facade_type", "label": "Facade type", "value": "unitised curtain wall",
                  "evidence": ev("Facade type: unitised curtain wall")},
                 {"field": "tender_closing_date", "label": "Tender closing date", "value": "15 November 2026",
                  "evidence": ev("The tender closing date is 15 November 2026")},
                 {"field": "safe_working_load", "label": "Safe working load", "value": "250 kg",
                  "evidence": ev("The BMU shall have a safe working load of 250 kg", "file-1")},
                 {"field": "cradle_length", "label": "Cradle length", "value": "6.0 m",
                  "evidence": ev("The cradle length shall be 6.0 m", "file-1")},
                 {"field": "standards", "label": "Design standards", "value": "EN 1808 and BS 6037-1",
                  "evidence": ev("Design to EN 1808 and BS 6037-1", "file-1")}],
             "unresolved_questions": ["Roof structure and load capacity for the BMU track are not stated."],
             "changes": [], "blockers": []}),
        ExamCase(
            "C03_wce_monorail_ar_classify", "classify_email", "Arabic window-cleaning monorail RFQ",
            lambda: {"email": EMAIL_WCE, "categories": _CATS, "knowledge": KNOWLEDGE},
            [eq("category", "wce", 2, True), eq("is_customer_request", True, 2, True), NO_FABRICATED_QUOTES,
             HAS_VERIFIED_QUOTE],
            {"category": "wce", "confidence": 0.93,
             "reason": "Request for a quotation for a facade cleaning monorail system (Arabic).",
             "evidence": [ev("نرجو تزويدنا بعرض سعر لتوريد وتركيب نظام تنظيف الواجهات (مونوريل)", "body")],
             "priority": "high", "is_customer_request": True, "request_kind": "direct_rfq"}),
        ExamCase(
            "C04_wce_monorail_ar_extract", "extract_request", "Arabic RFQ: Arabic-Indic digits, verbatim Arabic quotes",
            lambda: {"thread_text": WCE_THREAD, "files": [], "knowledge": KNOWLEDGE},
            [eq("service_family", "wce", 2, True), eq("due_date", "2026-10-20", 2, True),
             eq("work_type", "supply_installation"), contains("location", "الجهراء"),
             custom("building height 36 m", lambda r: (_req_with(r, 36), "requirements")),
             custom("track length 120 m", lambda r: (_req_with(r, 120), "requirements")),
             NO_FABRICATED_QUOTES, FACTS_SUPPORTED, NO_PRICES],
            {"service_family": fact("wce", "نظام تنظيف الواجهات (مونوريل) مع عربة تنظيف معلقة"),
             "work_type": fact("supply_installation", "لتوريد وتركيب"),
             "request_kind": fact("direct_rfq", "نرجو تزويدنا بعرض سعر"),
             "due_date": fact("2026-10-20", "آخر موعد لاستلام العروض: ٢٠٢٦/١٠/٢٠"),
             "tender_no": NULL, "location": fact("منطقة الجهراء", "منطقة الجهراء"),
             "owner_client": NULL, "consultant": NULL, "main_contractor": NULL,
             "summary": ("Request to supply and install a facade cleaning monorail with a suspended cleaning car for a "
                         "specialist hospital building in Jahra."),
             "scope_items": [{"description": "نظام تنظيف الواجهات (مونوريل) مع عربة تنظيف معلقة", "qty": None,
                              "unit": None, "evidence": ev("نظام تنظيف الواجهات (مونوريل) مع عربة تنظيف معلقة")}],
             "requirements": [
                 {"field": "track_length", "label": "Approximate track length", "value": "120 m",
                  "evidence": ev("طول المسار التقريبي ١٢٠ متر حول السطح")},
                 {"field": "building_height", "label": "Building height", "value": "36 m",
                  "evidence": ev("وارتفاع المبنى ٣٦ متر")}],
             "unresolved_questions": ["Delivery period is requested by the customer.",
                                      "Roof and parapet details for the monorail fixing are not stated."],
             "changes": [], "blockers": []}),
        ExamCase(
            "C05_vendor_pitch", "classify_email", "OEM sales pitch is NOT a customer enquiry",
            lambda: {"email": EMAIL_VENDOR, "categories": _CATS, "knowledge": KNOWLEDGE},
            [eq("category", "vendor_offer", 2, True), eq("is_customer_request", False, 2, True), NO_FABRICATED_QUOTES],
            {"category": "vendor_offer", "confidence": 0.95,
             "reason": "A manufacturer offers its BMU products and a distributorship; nobody asks us for a quotation.",
             "evidence": [ev("We are a leading manufacturer of Building Maintenance Units", "body"),
                          ev("We are looking for an exclusive distributor in Kuwait", "body")],
             "priority": "low", "is_customer_request": False, "request_kind": None}),
        ExamCase(
            "C06_invoice", "classify_email", "Supplier invoice goes to bills",
            lambda: {"email": EMAIL_INVOICE, "categories": _CATS, "knowledge": KNOWLEDGE},
            [eq("category", "bills", 2, True), eq("is_customer_request", False, 2, True), NO_PRICES,
             NO_FABRICATED_QUOTES],
            {"category": "bills", "confidence": 0.95, "reason": "A supplier's tax invoice for crane hire to be paid.",
             "evidence": [ev("Please find attached Tax Invoice INV-2026-0912", "body"),
                          ev("Kindly arrange payment within 30 days", "body")],
             "priority": "normal", "is_customer_request": False, "request_kind": None}),
        ExamCase(
            "C07_newsletter", "classify_email", "Newsletter with List-Unsubscribe goes to promotions",
            lambda: {"email": EMAIL_NEWS, "categories": _CATS, "knowledge": KNOWLEDGE},
            [eq("category", "promotions", 2, True), eq("is_customer_request", False, 2, True), NO_FABRICATED_QUOTES],
            {"category": "promotions", "confidence": 0.95, "reason": "Industry newsletter with webinar and training offers.",
             "evidence": [ev("FACADE ACCESS WORLD – OCTOBER NEWSLETTER", "body"),
                          ev("Register now for our free webinar", "body")],
             "priority": "low", "is_customer_request": False, "request_kind": None}),
        ExamCase(
            "C08_deadline_extension", "extract_request", "Deadline extension: report old -> new date as a change",
            lambda: {"thread_text": THREAD_EXTENSION, "files": [], "knowledge": KNOWLEDGE},
            [eq("due_date", "2026-10-26", 2, True), custom("deadline change 2026-10-12 -> 2026-10-26",
                                                          _deadline_change_ok, 2, True),
             eq("work_type", "annual_maintenance"), eq("request_kind", "o_and_m"), eq("service_family", "bmu"),
             NO_FABRICATED_QUOTES, FACTS_SUPPORTED, NO_PRICES],
            {"service_family": fact("bmu", "the two existing BMU gondolas at Bayadir Walk Mall"),
             "work_type": fact("annual_maintenance", "the annual maintenance contract of the two existing BMU gondolas"),
             "request_kind": fact("o_and_m", "We invite you to quote for the annual maintenance contract"),
             "due_date": fact("2026-10-26", "the closing date has been extended to 26 October 2026"),
             "tender_no": NULL, "location": fact("Bayadir Walk Mall, Salmiya", "Bayadir Walk Mall, Salmiya"),
             "owner_client": NULL, "consultant": NULL, "main_contractor": NULL,
             "summary": ("The facility manager of Bayadir Walk Mall invites a quotation for the annual maintenance of "
                         "its two BMU gondolas; the closing date was extended to 26 October 2026."),
             "scope_items": [{"description": "Annual maintenance contract of the two existing BMU gondolas", "qty": 2,
                              "unit": None,
                              "evidence": ev("the annual maintenance contract of the two existing BMU gondolas")}],
             "requirements": [],
             "unresolved_questions": ["BMU make, model and age are not stated.",
                                      "Required visit frequency and response time are not stated."],
             "changes": [{"kind": "deadline_changed", "title": "Closing date extended", "old_value": "2026-10-12",
                          "new_value": "2026-10-26", "date": "2026-09-28",
                          "evidence": ev("Please note that the closing date has been extended to 26 October 2026")}],
             "blockers": []}),
        ExamCase(
            "C09_addendum", "extract_request", "Addendum notice: changes reported, unchanged deadline not invented",
            lambda: {"thread_text": THREAD_ADDENDUM, "files": [], "knowledge": KNOWLEDGE},
            [custom("addendum reported with verified evidence",
                    lambda r: (bool(_change(r, "addendum") and _change(r, "addendum").get("verified")), "changes"), 2, True),
             custom("parapet revision 1.10 m -> 1.40 m",
                    lambda r: (any(1.4 in numbers_in(str(c.get("new_value"))) for c in r.get("changes") or []
                                   if c.get("kind") in ("technical_revision", "addendum", "scope_change")), "changes")),
             custom("no deadline change invented (date unchanged)",
                    lambda r: (_change(r, "deadline_changed") is None, "changes"), 2, True),
             eq("due_date", "2026-10-29"), eq("tender_no", "QWR/FA/2026/07"),
             NO_FABRICATED_QUOTES, FACTS_SUPPORTED, NO_PRICES],
            {"service_family": fact("wce", "for the monorail and davit system"), "work_type": NULL,
             "request_kind": fact("revision", "Please find below Addendum No. 2 to the tender documents"),
             "due_date": fact("2026-10-29", "The tender closing date remains unchanged: 29 October 2026"),
             "tender_no": fact("QWR/FA/2026/07", "Tender Ref. QWR/FA/2026/07"), "location": NULL,
             "owner_client": NULL, "consultant": NULL, "main_contractor": NULL,
             "summary": ("Addendum No. 2 for the facade access (monorail and davit) package of Qurain Waterfront "
                         "Residences raises the parapet height and adds two davit sockets; the closing date is unchanged."),
             "scope_items": [{"description": "Additional davit sockets at the east elevation", "qty": 2, "unit": "nos",
                              "evidence": ev("Two additional davit sockets are required at the east elevation")}],
             "requirements": [
                 {"field": "parapet_height", "label": "Parapet height at roof level", "value": "1.40 m",
                  "evidence": ev("The parapet height at roof level is revised from 1.10 m to 1.40 m")},
                 {"field": "davit_sockets_total", "label": "Davit sockets (total)", "value": "14 nos",
                  "evidence": ev("(total 14 nos)")}],
             "unresolved_questions": [],
             "changes": [
                 {"kind": "addendum", "title": "Addendum No. 2 issued", "old_value": None, "new_value": None,
                  "date": "2026-09-20", "evidence": ev("Addendum No. 2 to the tender documents")},
                 {"kind": "technical_revision", "title": "Parapet height revised", "old_value": "1.10 m",
                  "new_value": "1.40 m", "date": "2026-09-20",
                  "evidence": ev("The parapet height at roof level is revised from 1.10 m to 1.40 m")},
                 {"kind": "scope_change", "title": "Two additional davit sockets", "old_value": None,
                  "new_value": "14 nos", "date": "2026-09-20",
                  "evidence": ev("Two additional davit sockets are required at the east elevation (total 14 nos)")}],
             "blockers": []}),
        ExamCase(
            "C10_missing_information", "extract_request", "Missing information: null + questions, never invented",
            lambda: {"thread_text": THREAD_MISSING, "files": [], "knowledge": KNOWLEDGE},
            [is_null("due_date"), is_null("location"), is_null("tender_no"), is_null("owner_client", 1, False),
             custom("no invented numeric requirement", _no_numeric_requirements, 2, True),
             custom("at least 3 questions to the customer", _questions(3), 2),
             eq("service_family", "cradle"), NO_FABRICATED_QUOTES, FACTS_SUPPORTED],
            {"service_family": fact("cradle", "we need a cradle for our building"), "work_type": NULL,
             "request_kind": fact("direct_rfq", "Please send your best offer"),
             "due_date": NULL, "tender_no": NULL, "location": NULL, "owner_client": NULL, "consultant": NULL,
             "main_contractor": NULL,
             "summary": "A private contact asks for an offer for a cradle for his building; nothing else is stated.",
             "scope_items": [{"description": "Cradle for the customer's building", "qty": None, "unit": None,
                              "evidence": ev("we need a cradle for our building")}],
             "requirements": [],
             "unresolved_questions": ["Where is the building?", "What are the building height and roof/parapet details?",
                                      "Purchase or rental, and for how long?", "Which cradle length and how many?",
                                      "By when is the offer needed?"],
             "changes": [],
             "blockers": [{"kind": "unclear_scope", "text": "Location, height, quantity and purchase/rental not stated.",
                           "evidence": None}]}),
        ExamCase(
            "C11_price_trap", "draft_quotation", "Price trap: competitor price in the project, draft has no prices",
            lambda: {"project": PROJECT_PRICE_TRAP, "template_key": "supply_installation", "knowledge": KNOWLEDGE},
            [NO_PRICES, custom("no competitor price copied", _no_competitor_price, 2, True),
             custom("items cover monorail, trolley and cradle", _draft_items),
             custom("track quantity 64 kept", _draft_qty),
             custom("roof slab question kept", lambda r: (any("slab" in _n(c) for c in r.get("clarifications") or []),
                                                          "clarifications")),
             custom("no invented numbers in terms", _no_number_warnings)],
            {"subject": "Quotation – Roof monorail window cleaning system – Narjis Polyclinic Extension, Hawally",
             "intro": ("Dear Eng. Omar Haddad, thank you for your enquiry. Please find below our technical proposal for "
                       "the roof monorail window cleaning system of the Narjis Polyclinic Extension in Hawally."),
             "items": [
                 {"description": "Stainless steel monorail track fixed to the roof slab soffit",
                  "spec": "Fixing details to be confirmed after the roof slab details are received.", "qty": 64,
                  "unit": "m", "source_ref": "scope_items[0]"},
                 {"description": "Motorised monorail trolley with hoist", "spec": None, "qty": 1, "unit": "no",
                  "source_ref": "scope_items[1]"},
                 {"description": "Aluminium cleaning cradle, 4 m long", "spec": None, "qty": 1, "unit": "no",
                  "source_ref": "scope_items[2]"}],
             "terms": ["Validity: to be confirmed by engineer.", "Delivery period: to be confirmed by engineer.",
                       "Payment terms: to be confirmed by engineer."],
             "exclusions": ["Civil works, power supply and permits are by others."],
             "clarifications": ["Roof slab thickness for the track fixings is not stated."]}),
        ExamCase(
            "C12_evidence_trap", "extract_request", "Evidence trap: every quote verbatim, no paraphrase",
            lambda: {"thread_text": THREAD_EVIDENCE_TRAP, "files": [], "knowledge": KNOWLEDGE},
            [NO_FABRICATED_QUOTES, FACTS_SUPPORTED,
             custom("height 145 m reported", lambda r: (_req_with(r, 145), "requirements")),
             eq("due_date", "2026-10-30"), custom("system choice asked", _questions(1)), NO_PRICES],
            {"service_family": NULL, "work_type": NULL,
             "request_kind": fact("direct_rfq", "Please advise the recommended system and send your quotation."),
             "due_date": fact("2026-10-30", "Kindly submit your offer before 30 October 2026."),
             "tender_no": NULL, "location": fact("Kuwait City", "Mirqab Horizon Tower in Kuwait City"),
             "owner_client": NULL, "consultant": NULL, "main_contractor": NULL,
             "summary": ("The owner's representative asks for a recommended facade access system and a quotation for "
                         "Mirqab Horizon Tower with curved and flat elevations."),
             "scope_items": [{"description": "Facade access solution for the curved north and flat south elevations",
                              "qty": None, "unit": None,
                              "evidence": ev("a suitable façade access solution covering both the curved north elevation "
                                             "and the flat south elevation")}],
             "requirements": [
                 {"field": "building_height", "label": "Height above podium roof", "value": "145 m",
                  "evidence": ev("rises to roughly one hundred and forty-five metres (145 m) above the podium roof")},
                 {"field": "number_of_floors", "label": "Typical office floors", "value": "38",
                  "evidence": ev("with 38 typical office floors and a crown structure")},
                 {"field": "facade_geometry", "label": "Facade geometry",
                  "value": "curved north elevation and flat south elevation",
                  "evidence": ev("covering both the curved north elevation and the flat south elevation")}],
             "unresolved_questions": ["Which access system is preferred (BMU or monorail/davit)?",
                                      "What is the total height including the crown structure?"],
             "changes": [], "blockers": []}),
        ExamCase(
            "C13_drawing_text", "analyze_document", "Drawing title block and notes (text layer)",
            lambda: {"name": "MCT-AR-RF-301_RevC.pdf", "text": DRAWING_TEXT, "knowledge": KNOWLEDGE},
            [eq("doc_kind", "drawing", 2, True),
             custom("drawing number MCT-AR-RF-301", lambda r: (_n(_ref(r, "drawing_no")) == _n("MCT-AR-RF-301"),
                                                               f"drawing_no {_ref(r, 'drawing_no')!r}"), 2),
             custom("revision C", lambda r: (_n(_ref(r, "revision")) == "c", f"revision {_ref(r, 'revision')!r}")),
             custom("roof level +168.00", lambda r: (_fact_with(r, 168.0), "facts")),
             custom("parapet 1.20 m", lambda r: (_fact_with(r, 1.2), "facts")),
             custom("track length 220 m", lambda r: (_fact_with(r, 220.0), "facts")),
             custom("page references", _pages_ok), NO_FABRICATED_QUOTES, FACTS_SUPPORTED],
            {"doc_kind": "drawing", "doc_kind_confidence": 0.97,
             "title": fact("ROOF PLAN – BMU TRACK & DAVIT LAYOUT", "ROOF PLAN – BMU TRACK & DAVIT LAYOUT", "page-1"),
             "summary": "Roof plan of Marjan Crest Tower showing the BMU twin-rail track and davit sockets, revision C.",
             "references": [
                 {"kind": "drawing_no", "value": "MCT-AR-RF-301", "evidence": ev("DRAWING NO: MCT-AR-RF-301", "page-1")},
                 {"kind": "revision", "value": "C", "evidence": ev("REV: C", "page-1")},
                 {"kind": "project_name", "value": "MARJAN CREST TOWER", "evidence": ev("MARJAN CREST TOWER", "page-1")}],
             "facts": [
                 {"field": "scale", "label": "Scale", "value": "1:200 @ A1", "unit": None,
                  "evidence": ev("SCALE: 1:200 @ A1", "page-1")},
                 {"field": "roof_level", "label": "Top of roof slab level", "value": "+168.00", "unit": "m",
                  "evidence": ev("TOP OF ROOF SLAB LEVEL +168.00", "page-1")},
                 {"field": "parapet_height", "label": "Parapet height", "value": "1.20 M", "unit": "m",
                  "evidence": ev("PARAPET HEIGHT 1.20 M ABOVE FINISHED ROOF LEVEL", "page-1")},
                 {"field": "bmu_track_length", "label": "BMU track total length", "value": "220 M", "unit": "m",
                  "evidence": ev("BMU TRACK: TWIN RAIL, 220 M TOTAL LENGTH", "page-1")},
                 {"field": "davit_sockets", "label": "Davit sockets", "value": "D1–D8", "unit": None,
                  "evidence": ev("DAVIT SOCKETS D1–D8 AT UPPER ROOF", "page-1")}],
             "dates": [{"kind": "issue", "value": "2026-09-02", "evidence": ev("DATE: 02/09/2026", "page-1")}],
             "boq_items": [], "standards": [],
             "unresolved_questions": ["Structural embed details are on the structural drawings, which were not provided."]}),
        ExamCase(
            "C14_boq_snippet", "analyze_document", "BOQ snippet: exact quantities, empty rate columns stay empty",
            lambda: {"name": "QWR_FA_BOQ.xlsx", "text": BOQ_TEXT, "knowledge": KNOWLEDGE},
            [eq("doc_kind", "boq", 2, True), custom("all six quantities exact", _boq_ok, 3), NO_PRICES,
             NO_FABRICATED_QUOTES, FACTS_SUPPORTED],
            {"doc_kind": "boq", "doc_kind_confidence": 0.98,
             "title": fact("BILL OF QUANTITIES – FACADE ACCESS EQUIPMENT", "BILL OF QUANTITIES – FACADE ACCESS EQUIPMENT",
                           "page-1"),
             "summary": "Bill of quantities for the facade access equipment package; rates and amounts are blank.",
             "references": [{"kind": "tender_no", "value": "QWR/FA/2026/07",
                             "evidence": ev("Tender Ref. QWR/FA/2026/07", "page-1")}],
             "facts": [], "dates": [],
             "boq_items": [
                 {"item_no": "1.01", "description": "Monorail track, stainless steel 316, including brackets and fixings",
                  "qty": 84, "unit": "m", "evidence": ev(
                      "1.01 | Monorail track, stainless steel 316, including brackets and fixings | m | 84", "page-1")},
                 {"item_no": "1.02", "description": "Motorised monorail trolley complete with hoist units", "qty": 2,
                  "unit": "nos",
                  "evidence": ev("1.02 | Motorised monorail trolley complete with hoist units | nos | 2", "page-1")},
                 {"item_no": "1.03", "description": "Davit arm, portable, aluminium", "qty": 6, "unit": "nos",
                  "evidence": ev("1.03 | Davit arm, portable, aluminium | nos | 6", "page-1")},
                 {"item_no": "1.04", "description": "Davit socket, cast-in, galvanised", "qty": 14, "unit": "nos",
                  "evidence": ev("1.04 | Davit socket, cast-in, galvanised | nos | 14", "page-1")},
                 {"item_no": "1.05", "description": "Cleaning cradle, 4.0 m, aluminium", "qty": 2, "unit": "nos",
                  "evidence": ev("1.05 | Cleaning cradle, 4.0 m, aluminium | nos | 2", "page-1")},
                 {"item_no": "1.06", "description": "Testing, commissioning and third-party certification", "qty": 1,
                  "unit": "LS",
                  "evidence": ev("1.06 | Testing, commissioning and third-party certification | LS | 1", "page-1")}],
             "standards": [], "unresolved_questions": []}),
        ExamCase(
            "C15_mixed_scope", "extract_request", "Mixed scope: hoist and cradles both captured",
            lambda: {"thread_text": THREAD_MIXED, "files": [], "knowledge": KNOWLEDGE},
            [custom("hoist item present", lambda r: (_scope_has(r, "hoist"), "scope_items"), 2, True),
             custom("cradle item present", lambda r: (_scope_has(r, "cradle", "gondola"), "scope_items"), 2, True),
             custom("quantities 1 hoist / 2 cradles",
                    lambda r: (_scope_qty(r, "hoist") == 1 and (_scope_qty(r, "cradle") or _scope_qty(r, "gondola")) == 2,
                               "scope quantities")),
             one_of("service_family", ["hoist", "cradle"]), eq("work_type", "equipment_rental"),
             eq("due_date", "2026-10-10"), contains("location", "Mahboula"),
             NO_FABRICATED_QUOTES, FACTS_SUPPORTED, NO_PRICES],
            {"service_family": fact("hoist", "One twin-cage rack and pinion passenger/material hoist"),
             "work_type": fact("equipment_rental", "on rental basis for 12 months"),
             "request_kind": fact("direct_rfq", "Kindly send your rental offer"),
             "due_date": fact("2026-10-10", "monthly maintenance by 10 October 2026"),
             "tender_no": NULL, "location": fact("Mahboula", "Tilal Residential Tower B in Mahboula"),
             "owner_client": NULL, "consultant": NULL, "main_contractor": NULL,
             "summary": ("Tilal Zenon Contracting asks for a 12-month rental of one twin-cage hoist and two temporary "
                         "suspended cradles for Tilal Residential Tower B in Mahboula."),
             "scope_items": [
                 {"description": "Twin-cage rack and pinion passenger/material hoist, 2,000 kg per cage, mast height 95 m",
                  "qty": 1, "unit": None,
                  "evidence": ev("One twin-cage rack and pinion passenger/material hoist, 2,000 kg per cage, mast "
                                 "height 95 m")},
                 {"description": "Temporary suspended cradles (gondolas), 6 m length each", "qty": 2, "unit": None,
                  "evidence": ev("Two temporary suspended cradles (gondolas), 6 m length each")}],
             "requirements": [
                 {"field": "rental_period", "label": "Rental period", "value": "12 months",
                  "evidence": ev("on rental basis for 12 months starting 1 December 2026")},
                 {"field": "rental_start", "label": "Rental start", "value": "1 December 2026",
                  "evidence": ev("on rental basis for 12 months starting 1 December 2026")},
                 {"field": "hoist_capacity", "label": "Hoist capacity", "value": "2,000 kg per cage",
                  "evidence": ev("2,000 kg per cage")},
                 {"field": "mast_height", "label": "Mast height", "value": "95 m", "evidence": ev("mast height 95 m")},
                 {"field": "cradle_length", "label": "Cradle length", "value": "6 m", "evidence": ev("6 m length each")},
                 {"field": "inclusions", "label": "Inclusions",
                  "value": "installation, dismantling and monthly maintenance",
                  "evidence": ev("including installation, dismantling and monthly maintenance")}],
             "unresolved_questions": ["Site access and the hoist landing levels are not stated."],
             "changes": [], "blockers": []}),
        ExamCase(
            "C16_customer_research", "research_customer", "Customer research: cited, verbatim, no look-alike company",
            lambda: {"customer": RESEARCH_CUSTOMER, "search_results": RESEARCH_RESULTS},
            [NO_FABRICATED_QUOTES, custom("no claims from the look-alike company", _no_trap_claims, 2, True),
             custom("at least 3 verified claims", _claims_min(3)), custom("Mahboula award found",
                                                                         _claim_mentions("Mahboula"))],
            {"sections": [
                {"key": "profile", "title": "Company profile", "claims": [
                    {"text": "Founded in 2004 in Kuwait.", "confidence": 0.9,
                     "evidence": ev("Tilal Zenon Contracting Co. was founded in 2004 in Kuwait.", "r-1")},
                    {"text": "Specialises in residential towers and mixed-use buildings.", "confidence": 0.9,
                     "evidence": ev("The company specialises in residential towers and mixed-use buildings", "r-1")},
                    {"text": "Employs around 850 staff.", "confidence": 0.8,
                     "evidence": ev("employs around 850 staff", "r-1")}]},
                {"key": "projects", "title": "Projects", "claims": [
                    {"text": "Completed Tilal Residential Tower A in 2023.", "confidence": 0.85,
                     "evidence": ev("Tilal Residential Tower A, completed in 2023", "r-1")},
                    {"text": "Awarded the main construction contract for two residential towers in Mahboula.",
                     "confidence": 0.9,
                     "evidence": ev("has been awarded the main construction contract for two residential towers in "
                                    "Mahboula", "r-2")}]},
                {"key": "news", "title": "News", "claims": [
                    {"text": "Construction of the Mahboula towers is expected to start in December 2026.",
                     "confidence": 0.8, "evidence": ev("Construction is expected to start in December 2026.", "r-2")}]}],
             "gaps": ["No information on the facade access equipment the customer uses today."]}),
        ExamCase(
            "C17_business_discovery", "discover_business", "Business discovery: own documents outrank inbound/web",
            lambda: {"corpus_excerpts": DISCOVER_EXCERPTS, "region_terms": REGION_TERMS, "knowledge": KNOWLEDGE},
            [custom("BMU family learnt from own quotation (weight >= 0.9)", _bmu_strong, 2, True),
             custom("scaffolding NOT learnt from a supplier's pitch", _no_scaffolding_family, 2, True),
             custom("window cleaning family learnt",
                    lambda r: (_knowledge(r, "service_family", "wce") is not None, "items")),
             custom("annual maintenance work type learnt",
                    lambda r: (_knowledge(r, "work_type", "annual_maintenance") is not None, "items")),
             custom("regional term 'gondola' learnt",
                    lambda r: (any(i.get("kind") == "term" and "gondola" in _n(i.get("key")) for i in r.get("items") or []),
                               "items")),
             NO_FABRICATED_QUOTES, NO_PRICES],
            {"items": [
                {"kind": "service_family", "key": "bmu", "label": "Building Maintenance Units", "value": None,
                 "language": "en", "region": None, "variants": ["BMU", "gondola"],
                 "evidence": [ev("roof-mounted Building Maintenance Unit (BMU) with telescopic jib", "x-1")]},
                {"kind": "service_family", "key": "wce", "label": "Window cleaning equipment", "value": None,
                 "language": "en", "region": None, "variants": [],
                 "evidence": [ev("Window cleaning monorail system with motorised trolley and davit arms", "x-3")]},
                {"kind": "work_type", "key": "supply_installation", "label": "Supply & installation", "value": None,
                 "language": "en", "region": None, "variants": [],
                 "evidence": [ev("Supply, installation, testing and commissioning of one roof-mounted Building "
                                 "Maintenance Unit (BMU)", "x-1")]},
                {"kind": "work_type", "key": "annual_maintenance", "label": "Annual maintenance", "value": None,
                 "language": "en", "region": None, "variants": [],
                 "evidence": [ev("carry out the annual maintenance of your gondolas (BMU)", "x-2")]},
                {"kind": "term", "key": "gondola", "label": "Gondola",
                 "value": "Local word for a BMU (also used for temporary cradles)", "language": "en", "region": "GCC",
                 "variants": ["جندولا"],
                 "evidence": [ev("annual maintenance of your gondolas (BMU)", "x-2"),
                              ev("building maintenance units are often simply called gondolas", "x-5")]},
                {"kind": "standard", "key": "EN 1808", "label": "EN 1808", "value": None, "language": None,
                 "region": None, "variants": [], "evidence": [ev("as per EN 1808", "x-3")]},
                {"kind": "convention", "key": "quotation_validity", "label": "Quotation validity",
                 "value": "30 days from the date of this quotation", "language": "en", "region": None, "variants": [],
                 "evidence": [ev("Validity: 30 days from the date of this quotation.", "x-1")]}],
             "summary": ("The company supplies, installs and maintains building maintenance units and window cleaning "
                         "monorail systems; 'gondola' is the local word for a BMU.")}),
        ExamCase(
            "C18_drawing_image", "analyze_drawing", "Drawing image: read the title block, never guess a hidden dimension",
            lambda: {"image_png": drawing_image_png(), "context": {"file": "sheet_07.png", "page": 1,
                                                                   "project": "Najma Residences"}},
            [custom("drawing number NR-AR-RF-205", lambda r: (_n(_drawing_value(r, "sheet.drawing_number")) ==
                                                              _n("NR-AR-RF-205"),
                                                              f"{_drawing_value(r, 'sheet.drawing_number')!r}"), 2),
             custom("revision B", lambda r: (_n(_drawing_value(r, "sheet.revision")) == "b",
                                            f"{_drawing_value(r, 'sheet.revision')!r}")),
             custom("scale 1:100", lambda r: (_n(_drawing_value(r, "sheet.scale")) in ("1:100", "scale: 1:100"),
                                             f"{_drawing_value(r, 'sheet.scale')!r}")),
             custom("roof level +42.60", _roof_level), custom("monorail mark", _monorail_mark),
             custom("hidden building height left null", _height_null, 2, True),
             custom("no value reported without transcription", _no_guess, 2, True)],
            {"sheet": {"title": dfact("ROOF PLAN - MONORAIL LAYOUT", "TITLE: ROOF PLAN - MONORAIL LAYOUT",
                                      "title block, bottom right"),
                       "drawing_number": dfact("NR-AR-RF-205", "DRG NO: NR-AR-RF-205", "title block, bottom right"),
                       "revision": dfact("B", "REV: B", "title block, bottom right"),
                       "scale": dfact("1:100", "SCALE: 1:100", "title block, bottom right"),
                       "date": DNULL},
             "building": {"height": DNULL,
                          "roof_level": dfact("+42.60", "ROOF LEVEL +42.60", "roof plan, centre", unit="m"),
                          "parapet_height": DNULL, "facade_type": DNULL, "number_of_floors": DNULL},
             "levels": [{"name": "ROOF LEVEL", "value": "+42.60", "transcription": "ROOF LEVEL +42.60",
                         "location": "roof plan, centre", "confidence": 0.9}],
             "access_zones": [],
             "equipment_marks": [{"kind": "monorail", "label": "MONORAIL M1", "transcription": "MONORAIL M1",
                                  "location": "roof plan, along the north edge", "confidence": 0.9}],
             "unreadable": [{"item": "building height", "location": "left, below the roof plan",
                             "reason": "the value is covered by a black box"}],
             "notes": []},
            needs_vision=True, fingerprint=DRAWING_IMAGE_SPEC),
    ]


EXAM_CASES: list[ExamCase] = _cases()


def _fingerprint(case: ExamCase) -> Any:
    if case.fingerprint is not None:
        return case.fingerprint
    return case.inputs()


def _compute_version() -> str:
    payload = [{"id": c.id, "task": c.task, "inputs": _fingerprint(c),
                "checks": [(k.name, k.weight, k.critical) for k in c.checks]} for c in EXAM_CASES]
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return f"{EXAM_SUITE}.{hashlib.sha256(blob.encode('utf-8')).hexdigest()[:10]}"


EXAM_VERSION = _compute_version()


def select_cases(tasks: list[str] | None = None, *, vision: bool = True) -> list[ExamCase]:
    """Cases for ``tasks`` (all when None); image cases are skipped for models without vision."""
    wanted = set(tasks) if tasks else None
    return [c for c in EXAM_CASES if (wanted is None or c.task in wanted) and (vision or not c.needs_vision)]


def golden_answer(case_id: str) -> dict:
    return copy.deepcopy(next(c.golden for c in EXAM_CASES if c.id == case_id))
