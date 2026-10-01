"""Customer intelligence: what kind of company a customer is and what it runs and needs.

``infer_customer_kind`` reads the company name (English or Arabic), the e-mail domain
(``.gov.kw`` and friends), titles in e-mail signatures (Estimation Engineer, Tender Officer...)
and behaviour (sends tender RFQs, sends price lists). ``tag_customer`` turns a customer's mail and
projects into tags with evidence:

* role         - main contractor, consultant, ... (+ finer subtypes such as facade contractor)
* sector       - hospital, school, mall, tower, government, oil & gas, airport, marine, industrial...
* need         - service families / work types they asked for
* behaviour    - tender participant, repeat enquirer, reminder sender
* relationship - new, active, dormant, quoted, won, lost

Everything is deterministic, works on plain dicts (snapshot shapes) or ORM objects, and is cheap
enough to run over 10,000 customers (``tag_customers`` groups mail and projects in one pass).
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence

from ess.knowledge.base import WORK_TYPES, TermIndex, is_catch_all_category, normalize_text
from ess.knowledge.text import (
    FREE_MAIL_DOMAINS,
    LEGAL_SUFFIX_RE,
    email_domain,
    extract_signature,
    quoted_cut,
    registrable_domain,
)

CUSTOMER_KINDS = ("main_contractor", "subcontractor", "consultant", "developer", "government",
                  "facility_management", "supplier", "other")
KIND_LABELS = {
    "main_contractor": "Main contractor", "subcontractor": "Subcontractor", "consultant": "Consultant",
    "developer": "Developer / owner", "government": "Government / authority",
    "facility_management": "Facility management", "supplier": "Supplier", "other": "Other",
}
SUBTYPE_LABELS = {
    "facade_contractor": "Facade contractor", "mep_contractor": "MEP contractor",
    "fit_out_contractor": "Fit-out contractor", "cleaning_contractor": "Cleaning contractor",
    "steel_fabricator": "Steel fabricator", "rental_company": "Rental company",
    "oil_gas_industrial": "Oil & gas operator", "building_owner": "Building owner",
    "government_authority": "Public authority",
}
SECTOR_LABELS = {
    "hospital": "Hospitals & healthcare", "school": "Schools", "university": "Universities",
    "mall": "Malls & retail", "tower": "High-rise towers", "hotel": "Hotels",
    "airport": "Airports", "stadium": "Stadiums & sports", "government_building": "Government buildings",
    "oil_gas": "Oil & gas", "industrial_plant": "Industrial", "power_plant": "Power & water plants",
    "marine": "Marine & harbours", "warehouse": "Warehouses & logistics", "residential": "Residential",
    "infrastructure": "Infrastructure", "place_of_worship": "Mosques & places of worship",
    "car_park": "Car parks", "petrol_station": "Petrol stations",
}
TAG_KIND_ORDER = {"role": 0, "sector": 1, "need": 2, "behaviour": 3, "relationship": 4}

# --------------------------------------------------------------------------------------------
# Cue tables (English + Arabic). Matching is token based: "port" never matches "airport".
# --------------------------------------------------------------------------------------------

_NAME_CUES: dict[str, tuple[float, list[str]]] = {
    "government": (3.5, [
        "ministry", "authority", "public authority", "municipality", "council", "government", "directorate",
        "department of", "public works", "general authority", "amiri diwan", "royal commission",
        "national guard", "civil defense", "civil defence", "fire force", "fire service", "state audit",
        "وزارة", "هيئة", "الهيئة العامة", "بلدية", "ديوان", "المؤسسة العامة", "الحرس الوطني", "الإدارة العامة",
        "مجلس", "حكومة", "قوة الإطفاء"]),
    "consultant": (3.0, [
        "consultants", "consultant", "consulting", "consultancy", "engineering consultants", "architects",
        "architectural", "architecture", "design studio", "design consultants", "project management consultants",
        "pmc", "cost consultants", "quantity surveyors", "استشارات", "للاستشارات", "الاستشارات الهندسية",
        "استشاري", "مكتب هندسي", "دار الهندسة"]),
    "facility_management": (3.0, [
        "facility management", "facilities management", "facility services", "facilities services",
        "fm services", "property management", "building services", "maintenance services", "cleaning services",
        "cleaning company", "إدارة المرافق", "ادارة المرافق", "خدمات التنظيف", "إدارة الأملاك"]),
    "developer": (2.5, [
        "real estate", "properties", "property development", "developers", "development company", "realty",
        "holding", "investment", "investments", "estates", "العقارية", "عقارات", "للتطوير العقاري",
        "التطوير العقاري", "للاستثمار", "القابضة"]),
    "main_contractor": (2.5, [
        "contracting", "contractors", "contractor", "construction", "constructions", "builders",
        "building contracting", "general contracting", "engineering and contracting", "civil engineering",
        "للمقاولات", "مقاولات", "المقاولات", "للإنشاءات", "الإنشاءات", "انشاءات", "للبناء"]),
    "subcontractor": (2.0, [
        "aluminium", "aluminum", "glass", "glazing", "facade", "cladding", "curtain wall", "electrical",
        "electromechanical", "mechanical", "mep", "hvac", "plumbing", "fire fighting", "fire protection",
        "elevators", "lifts", "escalators", "steel structures", "metal works", "interiors", "fit-out", "fit out",
        "joinery", "decoration", "waterproofing", "insulation", "landscaping", "painting", "signage",
        "الألمنيوم", "الالمنيوم", "الزجاج", "الكهرباء", "الكهروميكانيكية", "التكييف", "المصاعد", "الديكور",
        "العزل"]),
    "supplier": (2.0, [
        "trading", "traders", "supplies", "suppliers", "supplier", "distribution", "distributors", "distributor",
        "equipment", "industries", "manufacturing", "manufacturer", "factory", "imports", "import and export",
        "agencies", "gmbh", "للتجارة", "التجارية", "تجارة", "مصنع", "للصناعات", "للتوريدات", "توريدات"]),
}
#: Generic GCC company forms: weak signals that must not count as "trading" + "contracting".
_GENERIC_FORMS = ["general trading and contracting", "general trading & contracting", "trading and contracting",
                  "trading & contracting", "للتجارة العامة والمقاولات", "التجارة العامة والمقاولات",
                  "للتجارة والمقاولات"]
_GENERIC_FORM_WEIGHTS = {"main_contractor": 1.5, "subcontractor": 0.5, "supplier": 0.5}

_SUBTYPE_CUES: dict[str, list[str]] = {
    "facade_contractor": ["aluminium", "aluminum", "glass", "glazing", "facade", "cladding", "curtain wall",
                          "الألمنيوم", "الالمنيوم", "الزجاج", "الواجهات"],
    "mep_contractor": ["electrical", "electromechanical", "mechanical", "mep", "hvac", "plumbing", "fire fighting",
                       "fire protection", "الكهرباء", "الكهروميكانيكية", "التكييف"],
    "fit_out_contractor": ["interiors", "fit-out", "fit out", "joinery", "decoration", "الديكور"],
    "cleaning_contractor": ["cleaning services", "cleaning company", "cleaning", "خدمات التنظيف", "للتنظيف"],
    "steel_fabricator": ["steel structures", "metal works", "steel fabrication", "fabrication", "الحديد"],
    "rental_company": ["rentals", "rental", "hire", "equipment rental", "للتأجير", "تأجير"],
}

_TITLE_CUES: dict[str, tuple[float, list[str]]] = {
    "main_contractor": (1.0, [
        "estimation engineer", "estimator", "tender engineer", "tendering engineer", "tender officer",
        "tender manager", "estimation manager", "quantity surveyor", "contracts manager", "construction manager",
        "planning engineer", "procurement engineer", "site engineer", "project director", "مهندس تسعير",
        "مهندس مناقصات", "قسم المناقصات", "مدير المشروع"]),
    "consultant": (1.0, ["architect", "design manager", "resident engineer", "design engineer", "lead designer",
                         "consultant engineer", "مهندس استشاري", "مهندس مقيم"]),
    "facility_management": (1.0, ["facility manager", "facilities manager", "fm manager", "property manager",
                                  "building manager", "maintenance manager", "مدير المرافق"]),
    "government": (1.0, ["director general", "undersecretary", "assistant undersecretary", "head of section",
                         "department head", "وكيل الوزارة", "مدير إدارة", "رئيس قسم"]),
    "supplier": (1.0, ["sales manager", "sales executive", "business development manager", "account manager",
                       "sales engineer", "area sales manager", "مدير المبيعات"]),
    "developer": (1.0, ["development manager", "asset manager", "investment manager", "real estate manager"]),
}
_WEAK_TITLE_CUES = {"main_contractor": (0.5, ["procurement", "purchasing", "buyer", "المشتريات"])}

#: State-owned oil & gas companies (owners/clients): government kind, oil & gas sector.
_STATE_ENERGY = ["koc", "knpc", "kipic", "kpc", "kuwait oil company", "kuwait national petroleum",
                 "kuwait integrated petroleum", "kuwait petroleum corporation", "aramco", "saudi aramco", "adnoc",
                 "qatarenergy", "qatar energy", "qatar petroleum", "pdo", "petroleum development oman", "bapco",
                 "sabic", "kgoc", "شركة نفط الكويت", "البترول الوطنية", "مؤسسة البترول الكويتية", "أرامكو"]
_GOV_TLD_RE = re.compile(r"(?:^|\.)(?:gov|gob|gouv|govt|mil)(?:\.[a-z]{2,3})?$|\.gov\.[a-z]{2}$|(?:^|\.)go\.[a-z]{2}$")

_SECTOR_CUES: dict[str, list[str]] = {
    "hospital": ["hospital", "medical center", "medical centre", "clinic", "health center", "health centre",
                 "healthcare", "polyclinic", "مستشفى", "مستشفيات", "مركز صحي", "مستوصف"],
    "school": ["school", "kindergarten", "nursery school", "academy", "مدرسة", "مدارس", "روضة"],
    "university": ["university", "college", "campus", "جامعة", "كلية"],
    "mall": ["mall", "shopping center", "shopping centre", "souq", "souk", "hypermarket", "retail complex", "مول",
             "مجمع تجاري"],
    "tower": ["tower", "high-rise", "high rise", "skyscraper", "برج", "أبراج"],
    "hotel": ["hotel", "resort", "فندق", "منتجع"],
    "airport": ["airport", "terminal building", "passenger terminal", "airside", "مطار"],
    "stadium": ["stadium", "sports hall", "sports complex", "arena", "ملعب", "استاد"],
    "government_building": ["ministry", "government building", "court complex", "palace of justice", "embassy",
                            "police station", "fire station", "diwan", "وزارة", "مبنى حكومي", "قصر العدل", "ديوان"],
    "oil_gas": [*_STATE_ENERGY, "refinery", "oil field", "oilfield", "gas plant", "petroleum", "petrochemical",
                "gathering center", "gathering centre", "booster station", "tank farm", "مصفاة", "نفط", "بترول",
                "البتروكيماويات"],
    "industrial_plant": ["factory", "industrial", "industrial plant", "processing plant", "manufacturing facility",
                         "industrial area", "مصنع", "صناعي", "الصناعية"],
    "power_plant": ["power plant", "power station", "desalination plant", "substation", "محطة كهرباء", "محطة تحلية",
                    "محطة توليد"],
    "marine": ["port", "harbour", "harbor", "marina", "jetty", "quay", "seaport", "shipyard", "ميناء", "مرفأ", "مارينا"],
    "warehouse": ["warehouse", "logistics center", "logistics centre", "cold store", "مستودع", "مخازن"],
    "residential": ["residential", "apartments", "housing", "villas", "pahw", "سكني", "شقق", "إسكان", "اسكان", "فلل"],
    "infrastructure": ["bridge", "highway", "metro", "railway", "tunnel", "interchange", "infrastructure", "جسر",
                       "سكة حديد", "مترو", "نفق"],
    "place_of_worship": ["mosque", "church", "masjid", "مسجد", "جامع", "كنيسة"],
    "car_park": ["car park", "multi-storey parking", "multi storey car park", "parking building", "مواقف سيارات"],
    "petrol_station": ["petrol station", "fuel station", "gas station", "service station", "محطة وقود", "محطة بنزين"],
}

_TENDER_CUES = ["tender", "tender no", "rfq for tender", "bid", "bidding", "closing date", "submission date",
                "pre-bid", "invitation to tender", "back to back", "مناقصة", "ممارسة", "تاريخ الإغلاق"]
_RFQ_CUES = ["rfq", "request for quotation", "request for quote", "please quote", "kindly quote", "quote for",
             "send your offer", "best offer", "your best price", "price offer", "enquiry", "inquiry",
             "طلب عرض سعر", "عرض سعر", "تسعير"]
_REMINDER_CUES = ["reminder", "gentle reminder", "kind reminder", "friendly reminder", "follow up", "following up",
                  "awaiting your", "still waiting", "any update", "please expedite", "urgently required",
                  "second request", "تذكير", "للتذكير", "نذكركم", "بانتظار ردكم"]
_VENDOR_CUES = ["price list", "catalogue", "catalog", "our products", "product range", "special offer",
                "distributor", "proforma invoice", "we are pleased to introduce", "company profile attached",
                "قائمة أسعار", "كتالوج"]
_INVOICE_CUES = ["invoice", "tax invoice", "statement of account", "payment due", "فاتورة", "كشف حساب"]
_QUOTED_CUES = ["our quotation", "our offer", "please find attached our", "attached our quotation",
                "revised quotation", "عرضنا", "عرض السعر المرفق"]


def _index(table: Mapping[str, Iterable[str]], origin: str) -> TermIndex:
    return TermIndex.from_phrases({k: list(v) for k, v in table.items()}, origin=origin)


_NAME_INDEX = TermIndex.from_phrases({**{k: v for k, (_w, v) in _NAME_CUES.items()},
                                      "_generic_form": _GENERIC_FORMS}, origin="name")
_SUBTYPE_INDEX = _index(_SUBTYPE_CUES, "subtype")
_TITLE_INDEX = TermIndex.from_phrases({**{k: v for k, (_w, v) in _TITLE_CUES.items()},
                                       **{f"weak:{k}": v for k, (_w, v) in _WEAK_TITLE_CUES.items()}}, origin="title")
_ENERGY_INDEX = TermIndex.from_phrases({"oil_gas": _STATE_ENERGY}, origin="energy")
_SECTOR_INDEX = _index(_SECTOR_CUES, "sector")
_BEHAVIOUR_INDEX = TermIndex.from_phrases({"tender": _TENDER_CUES, "rfq": _RFQ_CUES, "reminder": _REMINDER_CUES,
                                           "vendor": _VENDOR_CUES, "invoice": _INVOICE_CUES,
                                           "quoted": _QUOTED_CUES}, origin="behaviour")


def _hits(index: TermIndex, text: str) -> list[tuple[str, str]]:
    """``[(cue key, surface)]`` for every match in ``text``."""
    out = []
    for m in index.find(text or ""):
        for key in dict.fromkeys(e.concept for e in m.entries):
            out.append((key, m.surface))
    return out


# --------------------------------------------------------------------------------------------
# Field access on dicts / ORM objects
# --------------------------------------------------------------------------------------------


def _get(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        v = obj.get(n) if isinstance(obj, Mapping) else getattr(obj, n, None)
        if v not in (None, "", [], {}):
            return v
    return default


def _dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        text = str(value).strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        d = datetime.fromisoformat(text)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            from dateutil import parser

            d = parser.parse(str(value))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except Exception:
            return None


def _addr(value: Any) -> str:
    m = re.search(r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+", str(value or ""))
    return m.group(0).lower() if m else ""


# --------------------------------------------------------------------------------------------
# Customer kind
# --------------------------------------------------------------------------------------------


def _name_lines(signature_texts: Iterable[str]) -> list[str]:
    """Company-name-like lines of signatures (legal suffix or a short line with a name cue)."""
    out = []
    for sig in signature_texts or []:
        if not sig:
            continue
        span = extract_signature(sig)
        block = sig[span[0]:span[1]] if span else sig[-1500:]
        for line in block.splitlines():
            line = line.strip()
            if not line or len(line.split()) > 12 or "@" in line:
                continue
            if LEGAL_SUFFIX_RE.search(line) or _NAME_INDEX.find(line):
                out.append(line)
    return list(dict.fromkeys(out))[:6]


def classify_customer(domain: str | None = None, company_name: str | None = None,
                      signature_texts: Sequence[str] | None = None, *,
                      behaviour: Mapping[str, int] | None = None) -> dict[str, Any]:
    """Kind, confidence, reason, subtypes and the cues behind them (see :func:`infer_customer_kind`)."""
    scores: Counter = Counter()
    cues: list[dict[str, Any]] = []
    subtypes: Counter = Counter()

    def add(kind: str, weight: float, why: str) -> None:
        scores[kind] += weight
        cues.append({"kind": kind, "weight": round(weight, 2), "cue": why})

    dom = (domain or "").lower().strip().lstrip("@")
    if dom.startswith("www."):
        dom = dom[4:]
    if dom and _GOV_TLD_RE.search(dom):
        add("government", 4.0, f"government domain {dom}")
    name = company_name or ""
    names = [(name, 1.0)] if name else []
    names += [(line, 0.8) for line in _name_lines(signature_texts or []) if normalize_text(line) != normalize_text(name)]
    if dom and dom not in FREE_MAIL_DOMAINS:
        names.append((registrable_domain(dom).split(".")[0].replace("-", " "), 0.5))
    seen_kinds: set[tuple[str, str]] = set()
    for text, factor in names:
        for key, surface in _hits(_ENERGY_INDEX, text):
            if ("government", "energy") not in seen_kinds:
                seen_kinds.add(("government", "energy"))
                add("government", 3.0 * factor, f"state-owned energy company '{surface}'")
                subtypes["oil_gas_industrial"] += 1
        kinds_here: set[str] = set()
        for key, surface in _hits(_NAME_INDEX, text):
            kinds_here.add(key)
            if key == "_generic_form":
                if ("_generic", text) in seen_kinds:
                    continue
                seen_kinds.add(("_generic", text))
                for kind, w in _GENERIC_FORM_WEIGHTS.items():
                    add(kind, w * factor, f"company form '{surface}'")
                continue
            if (key, text) in seen_kinds:
                continue
            seen_kinds.add((key, text))
            add(key, _NAME_CUES[key][0] * factor, f"name '{surface}'")
        for key, _surface in _hits(_SUBTYPE_INDEX, text):
            subtypes[key] += 1
        if "subcontractor" in kinds_here and kinds_here & {"main_contractor", "_generic_form"}:
            add("subcontractor", 1.5 * factor, "specialist trade in a contractor's name")
    for sig in signature_texts or []:
        if not sig:
            continue
        span = extract_signature(sig)
        block = sig[span[0]:span[1]] if span else sig[-800:]
        title_seen: set[str] = set()
        for key, surface in _hits(_TITLE_INDEX, block):
            weak = key.startswith("weak:")
            kind = key.split(":", 1)[1] if weak else key
            if kind in title_seen:
                continue
            title_seen.add(kind)
            w = _WEAK_TITLE_CUES[kind][0] if weak else _TITLE_CUES[kind][0]
            add(kind, w, f"signature title '{surface}'")
    b = dict(behaviour or {})
    if b.get("tender_rfqs"):
        n = int(b["tender_rfqs"])
        add("main_contractor", min(2.5, 1.5 + 0.5 * (n - 1)), f"sends tender RFQs ({n})")
        add("subcontractor", 0.5, "takes part in tenders")
    if b.get("subcontract_language"):
        add("main_contractor", 1.0, "asks for back-to-back / subcontract offers")
    if b.get("vendor_offers"):
        add("supplier", min(3.0, 2.0 + 0.5 * (int(b["vendor_offers"]) - 1)), f"sends product offers ({b['vendor_offers']})")
    if b.get("invoices"):
        add("supplier", 1.0, "sends invoices")
    if scores.get("government") and subtypes.get("oil_gas_industrial") is None:
        subtypes["government_authority"] += 1
    if scores.get("developer"):
        subtypes["building_owner"] += 1
    ranked = scores.most_common()
    if not ranked or ranked[0][1] < 1.0:
        return {"kind": "other", "confidence": 0.2 if not ranked else 0.3, "reason": "no clear cues",
                "subtypes": [], "cues": cues, "scores": dict(scores)}
    kind, best = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    conf = round(min(0.95, best / (best + second + 1.0)), 2)
    reasons = [c["cue"] for c in sorted(cues, key=lambda c: -c["weight"]) if c["kind"] == kind][:3]
    trades = ("facade_contractor", "mep_contractor", "fit_out_contractor")
    sub_list = [s for s, _ in subtypes.most_common()
                if s not in trades or kind in ("subcontractor", "main_contractor")]
    return {"kind": kind, "confidence": conf, "reason": "; ".join(reasons), "subtypes": sub_list, "cues": cues,
            "scores": {k: round(v, 2) for k, v in scores.items()}}


def infer_customer_kind(domain: str | None, company_name: str | None,
                        signature_texts: Sequence[str] | None = None, *,
                        behaviour: Mapping[str, int] | None = None) -> tuple[str, float, str]:
    """``(kind, confidence, reason)`` with kind one of :data:`CUSTOMER_KINDS`.

    Cues: company-name words ("Contracting", "Engineering Consultants", "Ministry", "Facility
    Management", "Real Estate", Arabic "للمقاولات", "وزارة", ...), government domains (``.gov.kw``),
    signature titles (Estimation Engineer, Tender Officer, Architect, Facility Manager...) and
    behaviour (``{"tender_rfqs": n, "vendor_offers": n, "invoices": n, "subcontract_language": n}``).
    """
    r = classify_customer(domain, company_name, signature_texts, behaviour=behaviour)
    return r["kind"], r["confidence"], r["reason"]


# --------------------------------------------------------------------------------------------
# Tags
# --------------------------------------------------------------------------------------------


def _tag(tag: str, kind: str, key: str, confidence: float, evidence: list[dict], **extra: Any) -> dict[str, Any]:
    return {"tag": tag, "kind": kind, "key": key, "confidence": round(min(0.95, max(0.0, confidence)), 2),
            "evidence": evidence[:4], "source": "auto", **extra}


def _customer_info(customer: Any) -> dict[str, Any]:
    domain = str(_get(customer, "domain", default="") or "").lower().strip()
    ref = str(_get(customer, "ref", "id", default="") or "")
    if not domain and "." in ref and "@" not in ref and " " not in ref:
        domain = ref.lower()
    contacts = _get(customer, "contacts", default=[]) or []
    return {"name": str(_get(customer, "name", default="") or ""), "domain": domain, "ref": ref,
            "kind": str(_get(customer, "kind", default="") or ""),
            "kind_confidence": _get(customer, "kind_confidence"),
            "contacts": [c if isinstance(c, Mapping) else {"name": getattr(c, "name", None),
                                                            "title": getattr(c, "title", None),
                                                            "email": getattr(c, "email", None)} for c in contacts]}


def _belongs(email: Any, info: dict[str, Any]) -> bool:
    ref = _get(email, "customer_ref", "customer_id")
    if ref is not None and info["ref"]:
        return str(ref) == info["ref"]
    return True


def _direction(email: Any, info: dict[str, Any], own_domains: Sequence[str]) -> str:
    d = str(_get(email, "direction", default="") or "").lower()
    sender = _addr(_get(email, "from_email", "sender", "from"))
    sdom = email_domain(sender)
    if own_domains and sdom and any(sdom == o or sdom.endswith("." + o) for o in own_domains):
        return "outbound"
    if d in ("inbound", "outbound"):
        return d
    cdom = info["domain"]
    if cdom and cdom not in FREE_MAIL_DOMAINS and sdom:
        return "inbound" if registrable_domain(sdom) == registrable_domain(cdom) else "outbound"
    return "inbound"


def _email_text(email: Any) -> tuple[str, str, str]:
    subject = str(_get(email, "subject", default="") or "")
    body = str(_get(email, "body_text", "body", "text", "snippet", default="") or "")
    body = body[:quoted_cut(body, "reply")]
    sig = extract_signature(body)
    main = body[:sig[0]] if sig else body
    signature = body[sig[0]:sig[1]] if sig else body[-600:]
    return subject, main[:3000], signature


def _ev(quote: str, source: str, ref: Any = None, date: Any = None) -> dict[str, Any]:
    q = re.sub(r"\s+", " ", quote or "").strip()
    return {"quote": q[:240], "source": source, "ref": ref, "date": date.isoformat() if isinstance(date, datetime) else date}


def _service_index(our_services: Sequence[Mapping[str, Any]] | None) -> tuple[TermIndex, dict[str, str]]:
    labels: dict[str, str] = {}
    phrases: dict[str, list[str]] = {}
    for s in our_services or []:
        key = str(_get(s, "key", default="") or "")
        if not key:
            continue
        label = str(_get(s, "label", default=key) or key)
        labels[key] = label
        words = [label, key.replace("_", " ")]
        for field in ("synonyms", "terms", "keywords"):
            v = _get(s, field)
            if isinstance(v, Mapping):
                for lst in v.values():
                    words.extend(str(x) for x in lst or [])
            elif isinstance(v, (list, tuple)):
                words.extend(str(x) for x in v)
        phrases[key] = [w for w in words if w and len(w) >= 2]
    return TermIndex.from_phrases(phrases, origin="service"), labels


def _knowledge_family_index():
    try:
        from ess.knowledge.base import term_index

        return term_index()
    except Exception:  # knowledge data unavailable: our_services phrases still work
        return None


def tag_customer(customer: Any, emails: Sequence[Any] | None, projects: Sequence[Any] | None,
                 our_services: Sequence[Mapping[str, Any]] | None, *, now: datetime | None = None,
                 own_domains: Sequence[str] = ()) -> list[dict[str, Any]]:
    """Tags ``[{tag, kind, key, evidence, confidence, source}]`` for one customer.

    ``emails``: dicts/objects with subject, body_text, from_email, date (direction, category,
    customer_ref optional); ``projects``: dicts/objects with name, service_family, work_type,
    request_kind, location, owner_client, summary, status/stage, enquiries, our_response.
    ``our_services``: ``[{key, label}]`` (optionally synonyms/keywords) - used to name needs.
    """
    info = _customer_info(customer)
    now = now or datetime.now(timezone.utc)
    own = [o.lower().lstrip("@") for o in own_domains or []]
    mails = [e for e in (emails or []) if _belongs(e, info)]
    projs = [p for p in (projects or []) if _belongs(p, info)]
    svc_index, svc_labels = _service_index(our_services)
    fam_index = _knowledge_family_index()
    tags: list[dict[str, Any]] = []

    inbound: list[tuple[Any, str, str, str, datetime | None]] = []
    outbound: list[tuple[Any, str, str, datetime | None]] = []
    for e in mails:
        subject, main, signature = _email_text(e)
        when = _dt(_get(e, "date", "received_at"))
        if _direction(e, info, own) == "inbound":
            inbound.append((e, subject, main, signature, when))
        else:
            outbound.append((e, subject, main, when))

    # ---- behaviour counts (also feed the role) ----------------------------------------------
    beh: dict[str, list[dict]] = defaultdict(list)
    threads: set[str] = set()
    for e, subject, main, _sig, when in inbound:
        found = {k for k, _s in _hits(_BEHAVIOUR_INDEX, f"{subject}\n{main}")}
        if "tender" in found:
            beh["tender"].append(_ev(subject or main[:160], "email", _get(e, "id"), when))
        if found & {"rfq", "tender"}:
            beh["rfq"].append(_ev(subject or main[:160], "email", _get(e, "id"), when))
            threads.add(str(_get(e, "thread_id", default=None) or normalize_text(re.sub(
                r"^\s*(?:re|fw|fwd)\s*:\s*", "", subject, flags=re.I)) or _get(e, "id")))
        if "reminder" in found:
            beh["reminder"].append(_ev(subject or main[:160], "email", _get(e, "id"), when))
        if "vendor" in found:
            beh["vendor"].append(_ev(subject or main[:160], "email", _get(e, "id"), when))
        if "invoice" in found:
            beh["invoice"].append(_ev(subject or main[:160], "email", _get(e, "id"), when))
        if re.search(r"(?i)back\s*to\s*back|sub-?contract", main):
            beh["subcontract"].append(_ev(subject, "email", _get(e, "id"), when))
    for p in projs:
        if str(_get(p, "request_kind", default="")) == "tender_rfq":
            beh["tender"].append(_ev(str(_get(p, "name", default="")), "project", _get(p, "ref", "id")))

    # ---- role ---------------------------------------------------------------------------------
    signatures = [sig for _e, _s, _m, sig, _w in inbound if sig]
    for c in info["contacts"]:
        if c.get("title"):
            signatures.append(f"Regards,\n{c.get('name') or ''}\n{c['title']}")
    kind_conf = info["kind_confidence"]
    result = classify_customer(info["domain"], info["name"], signatures, behaviour={
        "tender_rfqs": len(beh["tender"]), "vendor_offers": len(beh["vendor"]), "invoices": len(beh["invoice"]),
        "subcontract_language": len(beh["subcontract"])})
    if info["kind"] and info["kind"] != "other" and (kind_conf is None or kind_conf >= 0.6):
        kind = info["kind"]
        conf = float(kind_conf) if kind_conf is not None else 0.9
        reason = "kind set on the customer record"
    else:
        kind, conf, reason = result["kind"], result["confidence"], result["reason"]
    if kind and kind != "other":
        tags.append(_tag(KIND_LABELS.get(kind, kind.replace("_", " ").title()), "role", kind, conf,
                         [{"quote": reason, "source": "rules"}]))
    for sub in result["subtypes"]:
        if sub == "government_authority" and kind != "government":
            continue
        tags.append(_tag(SUBTYPE_LABELS.get(sub, sub), "role", sub, min(conf, 0.85),
                         [{"quote": reason, "source": "rules"}], subtype=True))

    # ---- sectors ------------------------------------------------------------------------------
    sector_ev: dict[str, list[dict]] = defaultdict(list)
    sector_src: dict[str, set[str]] = defaultdict(set)
    texts: list[tuple[str, str, Any, Any]] = []
    for p in projs:
        pid = _get(p, "ref", "id", "name")
        for field in ("name", "location", "owner_client", "summary"):
            v = _get(p, field)
            if v:
                texts.append((str(v), f"project:{pid}", pid, None))
    for e, subject, main, _sig, when in inbound:
        texts.append((f"{subject}\n{main[:1500]}", f"email:{_get(e, 'id')}", _get(e, "id"), when))
    texts.append((info["name"], "customer:name", None, None))
    for text, src, ref, when in texts:
        for key, surface in _hits(_SECTOR_INDEX, text):
            if len(sector_ev[key]) < 4:
                line = next((ln for ln in text.splitlines() if surface in ln), surface)
                sector_ev[key].append(_ev(line, src.split(":", 1)[0], ref, when))
            sector_src[key].add(src)
    if kind == "government":
        sector_src["government_building"].add("role")
        sector_ev["government_building"].append({"quote": reason, "source": "rules"})
    for key, srcs in sorted(sector_src.items(), key=lambda kv: -len(kv[1])):
        n = len(srcs)
        tags.append(_tag(SECTOR_LABELS.get(key, key), "sector", key, 0.5 + 0.15 * n, sector_ev[key]))

    # ---- needs ---------------------------------------------------------------------------------
    need_ev: dict[str, list[dict]] = defaultdict(list)
    need_score: Counter = Counter()
    for p in projs:
        pid = _get(p, "ref", "id", "name")
        for field, weight in (("service_family", 1.0), ("work_type", 0.6)):
            key = _get(p, field)
            if key and not is_catch_all_category(str(key)):
                key = str(key)
                need_score[key] += weight
                need_ev[key].append(_ev(f"{_get(p, 'name', default='project')} ({field.replace('_', ' ')}: {key})",
                                        "project", pid))
    for e, subject, main, _sig, when in inbound:
        cat = _get(e, "category")
        if cat and (cat in svc_labels or cat in _family_keys(fam_index)) and not is_catch_all_category(str(cat)):
            need_score[str(cat)] += 0.6
            need_ev[str(cat)].append(_ev(subject, "email", _get(e, "id"), when))
        seen_here: set[str] = set()
        for key, surface in _hits(svc_index, f"{subject}\n{main}"):
            if key not in seen_here:
                seen_here.add(key)
                need_score[key] += 0.5
                need_ev[key].append(_ev(subject or surface, "email", _get(e, "id"), when))
        if fam_index is not None:
            for m in fam_index.find(f"{subject}\n{main}"):
                for ent in m.entries:
                    fam = ent.category if ent.origin in ("category", "region_terms") else None
                    if fam and fam in svc_labels and fam not in seen_here:
                        seen_here.add(fam)
                        need_score[fam] += 0.5
                        need_ev[fam].append(_ev(subject or m.surface, "email", _get(e, "id"), when))
    for key, score in need_score.most_common():
        label = svc_labels.get(key) or WORK_TYPES.get(key, {}).get("label") or key.replace("_", " ").title()
        conf = 0.45 + 0.15 * score
        tags.append(_tag(label, "need", key, min(conf, 0.95), need_ev[key], service_key=key,
                         offered=key in svc_labels))

    # ---- behaviour -----------------------------------------------------------------------------
    if beh["tender"]:
        tags.append(_tag("Tender participant", "behaviour", "tender_participant", 0.55 + 0.1 * len(beh["tender"]),
                         beh["tender"]))
    n_enquiries = max(len({str(_get(p, "ref", "id", "name")) for p in projs}), len(threads))
    if n_enquiries >= 2:
        tags.append(_tag("Repeat enquirer", "behaviour", "repeat_enquirer", 0.5 + 0.1 * n_enquiries,
                         beh["rfq"] or [_ev(str(_get(p, "name", default="")), "project", _get(p, "ref", "id"))
                                        for p in projs]))
    if beh["reminder"]:
        tags.append(_tag("Reminder sender", "behaviour", "reminder_sender", 0.55 + 0.1 * len(beh["reminder"]),
                         beh["reminder"]))
    if beh["vendor"]:
        tags.append(_tag("Sends product offers", "behaviour", "vendor_offers", 0.55 + 0.1 * len(beh["vendor"]),
                         beh["vendor"]))

    # ---- relationship --------------------------------------------------------------------------
    dates = [w for *_x, w in inbound if w] + [w for *_x, w in outbound if w]
    for p in projs:
        for enq in _get(p, "enquiries", default=[]) or []:
            w = _dt(_get(enq, "received_at"))
            if w:
                dates.append(w)
    if dates:
        first, last = min(dates), max(dates)
        if now - first <= timedelta(days=90) and n_enquiries <= 1:
            tags.append(_tag("New customer", "relationship", "new", 0.8,
                             [{"quote": f"first contact {first.date().isoformat()}", "source": "mail"}]))
        if now - last <= timedelta(days=90):
            tags.append(_tag("Active", "relationship", "active", 0.9,
                             [{"quote": f"last contact {last.date().isoformat()}", "source": "mail"}]))
        elif now - last > timedelta(days=365):
            tags.append(_tag("Dormant", "relationship", "dormant", 0.8,
                             [{"quote": f"last contact {last.date().isoformat()}", "source": "mail"}]))
    statuses: dict[str, list[dict]] = defaultdict(list)
    for p in projs:
        pid = _get(p, "ref", "id", "name")
        records = [p, *(_get(p, "enquiries", default=[]) or [])]
        for r in records:
            st = str(_get(r, "status", default="") or "").lower()
            resp = _get(r, "our_response", default={}) or {}
            rst = str(resp.get("status") if isinstance(resp, Mapping) else getattr(resp, "status", "") or "").lower()
            name = str(_get(p, "name", default=pid))
            if st in ("won", "lost", "declined", "quoted"):
                statuses[st].append(_ev(f"{name}: {st}", "project", pid))
            if rst in ("quoted", "declined"):
                statuses["quoted" if rst == "quoted" else "declined"].append(_ev(f"{name}: we {rst}", "project", pid))
    for e, subject, main, when in outbound:
        if any(k == "quoted" for k, _s in _hits(_BEHAVIOUR_INDEX, f"{subject}\n{main}")):
            statuses["quoted"].append(_ev(subject or main[:160], "email", _get(e, "id"), when))
    labels = {"quoted": ("Quoted", 0.85), "won": ("Won", 0.95), "lost": ("Lost", 0.9),
              "declined": ("Declined by us", 0.85)}
    for key, (label, conf) in labels.items():
        if statuses.get(key):
            tags.append(_tag(label, "relationship", key, conf, statuses[key]))

    tags.sort(key=lambda t: (TAG_KIND_ORDER.get(t["kind"], 9), -t["confidence"], t["tag"]))
    return tags


def _family_keys(index) -> set[str]:
    if index is None:
        return set()
    cached = getattr(index, "_ess_family_keys", None)
    if cached is None:
        cached = {e.category for e in index.entries() if e.origin == "category"}
        try:
            index._ess_family_keys = cached  # type: ignore[attr-defined]
        except Exception:
            pass
    return cached


def tag_customers(customers: Sequence[Any], emails: Sequence[Any], projects: Sequence[Any],
                  our_services: Sequence[Mapping[str, Any]] | None, *, now: datetime | None = None,
                  own_domains: Sequence[str] = ()) -> dict[str, list[dict[str, Any]]]:
    """Tag many customers at once (mail and projects are grouped by customer ref / domain once)."""
    by_ref: dict[str, list[Any]] = defaultdict(list)
    by_dom: dict[str, list[Any]] = defaultdict(list)
    for e in emails or []:
        ref = _get(e, "customer_ref", "customer_id")
        if ref is not None:
            by_ref[str(ref)].append(e)
        else:
            for addr in [_get(e, "from_email"), *(_get(e, "to", default=[]) or [])]:
                dom = registrable_domain(email_domain(_addr(addr)))
                if dom and dom not in FREE_MAIL_DOMAINS:
                    by_dom[dom].append(e)
    p_by_ref: dict[str, list[Any]] = defaultdict(list)
    for p in projects or []:
        refs = {str(_get(p, "customer_ref", "customer_id"))} if _get(p, "customer_ref", "customer_id") else set()
        for enq in _get(p, "enquiries", default=[]) or []:
            r = _get(enq, "customer_ref", "customer_id")
            if r:
                refs.add(str(r))
        for r in refs:
            p_by_ref[r].append(p)
    out: dict[str, list[dict[str, Any]]] = {}
    for c in customers or []:
        info = _customer_info(c)
        key = info["ref"] or info["domain"] or info["name"]
        mails = list(by_ref.get(info["ref"], [])) if info["ref"] else []
        if info["domain"]:
            mails += [e for e in by_dom.get(registrable_domain(info["domain"]), []) if e not in mails]
        projs = p_by_ref.get(info["ref"], [])
        stripped_mails = [{**(e if isinstance(e, Mapping) else {k: getattr(e, k, None) for k in (
            "id", "subject", "body_text", "from_email", "date", "direction", "category", "thread_id")}),
                           "customer_ref": None} for e in mails]
        out[key] = tag_customer({"name": info["name"], "domain": info["domain"], "kind": info["kind"],
                                 "kind_confidence": info["kind_confidence"], "contacts": info["contacts"]},
                                stripped_mails, [{**(p if isinstance(p, Mapping) else p.__dict__), "customer_ref": None}
                                                 for p in projs], our_services, now=now, own_domains=own_domains)
    return out
