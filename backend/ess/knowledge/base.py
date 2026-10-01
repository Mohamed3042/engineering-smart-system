"""Shared knowledge data: regional vocabulary, standards, default mail categories, cross-sell rules.

The curated JSON files live in ``ess/knowledge/data``. Every loader

* validates the file and drops malformed entries (the reasons are kept in :func:`load_issues`),
* caches the result until the file changes (mtime/size), and
* falls back to small built-in defaults when the file is missing or unusable, so the app keeps
  working on a fresh checkout.

Return shapes (stable, JSON-ready):

* :func:`load_region_terms` -> ``{"version", "regions": [{key, label}], "concepts": [...]}``
* :func:`load_standards`    -> ``{"version", "standards": [{code, title, region[], applies_to[], notes}]}``
* :func:`default_categories` -> ``[{key, label, label_ar, group, icon, visible, is_work_type,
  keywords{lang: []}, negative_keywords{lang: []}, description}]``
* :func:`load_cross_sell`   -> ``{"version", "service_adjacency": [{from, to, reason}],
  "customer_kind_needs": {kind: [service]}, "project_type_needs": {type: [service]}}``

Text helpers used everywhere else: :func:`normalize_text` (casefold, Arabic spelling variants,
digits, quotes, whitespace), :func:`tokenize` (tokens with offsets into the original text) and
:class:`TermIndex` / :func:`term_index` (fast term -> concept/category/region/language lookup with
longest-match search in documents).
"""
from __future__ import annotations

import copy
import json
import logging
import re
import threading
import unicodedata
from collections.abc import Iterable, Iterator, Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any, NamedTuple

log = logging.getLogger(__name__)

#: Folder with the curated JSON data. Read at call time, so tests may monkeypatch it.
DATA_DIR: Path = Path(__file__).resolve().parent / "data"

REGION_TERMS_FILE = "region_terms.json"
STANDARDS_FILE = "standards.json"
CATEGORIES_FILE = "default_categories.json"
CROSS_SELL_FILE = "cross_sell.json"

#: Region keys that carry no regional signal (international / shared vocabulary). Compared casefolded.
NEUTRAL_REGIONS = frozenset(
    {"", "*", "all", "any", "common", "generic", "global", "intl", "international", "neutral",
     "universal", "world", "worldwide"}
)
#: The region keys used by the shipped data (``region_terms.json``); built-in defaults follow them.
GLOBAL_REGION = "global"
_REGION_ALIAS = {"intl": "global", "uk": "UK_EU", "eu": "UK_EU", "us": "US", "gcc": "GCC", "ru": "RU_CIS",
                 "in": "SOUTH_ASIA", "sa": "SOUTH_ASIA"}


def is_neutral_region(region: str | None) -> bool:
    return (region or "").strip().casefold() in NEUTRAL_REGIONS

# --------------------------------------------------------------------------------------------
# Work types (the second classification axis: WHY a customer writes, independent of WHAT)
# --------------------------------------------------------------------------------------------

WORK_TYPES: dict[str, dict[str, str]] = {
    "supply_installation": {"label": "Supply & installation", "label_ar": "توريد وتركيب"},
    "equipment_rental": {"label": "Equipment rental / hire", "label_ar": "تأجير المعدات"},
    "annual_maintenance": {"label": "Maintenance contracts (AMC / PPM)", "label_ar": "عقود الصيانة"},
    "service_repair": {"label": "Service & repair", "label_ar": "الخدمة والإصلاح"},
    "inspection_certification": {"label": "Inspection & certification", "label_ar": "الفحص والشهادات"},
    "supply_only": {"label": "Supply / sale", "label_ar": "توريد / بيع"},
    "tender": {"label": "Tenders & RFQs", "label_ar": "المناقصات وطلبات الأسعار"},
}

#: Concept keys / category values in data files that mean a work type.
WORK_TYPE_ALIASES: dict[str, str] = {
    "supply_and_installation": "supply_installation", "supply_install": "supply_installation",
    "supply_and_install": "supply_installation", "installation": "supply_installation",
    "rental": "equipment_rental", "hire": "equipment_rental", "rent": "equipment_rental",
    "lease": "equipment_rental", "plant_hire": "equipment_rental",
    "amc": "annual_maintenance", "ppm": "annual_maintenance", "maintenance": "annual_maintenance",
    "maintenance_contract": "annual_maintenance", "preventive_maintenance": "annual_maintenance",
    "repair": "service_repair", "service": "service_repair", "breakdown": "service_repair",
    "inspection": "inspection_certification", "certification": "inspection_certification",
    "load_test": "inspection_certification", "thorough_examination": "inspection_certification",
    "sale": "supply_only", "supply": "supply_only", "purchase": "supply_only",
    "tender_rfq": "tender", "rfq": "tender", "bid": "tender", "tendering": "tender",
    "annual_maintenance_contract": "annual_maintenance", "equipment_hire": "equipment_rental",
    "load_test_third_party_inspection": "inspection_certification", "third_party_inspection": "inspection_certification",
    "load_test": "inspection_certification", "supply_and_installation_works": "supply_installation",
}
#: Category values that mean "this concept is a work type, see its key".
_WORK_TYPE_CATEGORY_HINTS = frozenset({"", "work_type", "work_types", "work", "commercial", "service_type",
                                       "contract", "general"})


def work_type_of(concept: str, category: str = "") -> str | None:
    """Work-type key for a concept (``equipment_hire`` -> ``equipment_rental``), else ``None``."""
    category = (category or "").strip().lower()
    concept = (concept or "").strip().lower()
    if category in WORK_TYPES:
        return category
    if category in WORK_TYPE_ALIASES:
        return WORK_TYPE_ALIASES[category]
    if category in _WORK_TYPE_CATEGORY_HINTS:
        if concept in WORK_TYPES:
            return concept
        return WORK_TYPE_ALIASES.get(concept)
    return None

#: Built-in work-type phrases: (term, region, language). Always part of the term index.
WORK_TYPE_PHRASES: dict[str, list[tuple[str, str, str]]] = {
    "supply_installation": [
        ("supply and installation", "intl", "en"), ("supply & installation", "intl", "en"),
        ("supply and install", "intl", "en"), ("supply & install", "intl", "en"),
        ("supply, installation", "intl", "en"), ("design, supply and installation", "intl", "en"),
        ("supply, install, test and commission", "intl", "en"), ("furnish and install", "us", "en"),
        ("S&I", "gcc", "en"), ("supply and fixing", "gcc", "en"),
        ("توريد وتركيب", "gcc", "ar"), ("поставка и монтаж", "ru", "ru"),
    ],
    "equipment_rental": [
        ("hire", "uk", "en"), ("plant hire", "uk", "en"), ("on hire", "uk", "en"), ("off hire", "uk", "en"),
        ("rental", "us", "en"), ("rental", "gcc", "en"), ("on rent", "gcc", "en"), ("monthly rent", "gcc", "en"),
        ("rent", "gcc", "en"), ("lease", "us", "en"),
        ("تأجير", "gcc", "ar"), ("إيجار", "gcc", "ar"), ("аренда", "ru", "ru"),
    ],
    "annual_maintenance": [
        ("annual maintenance contract", "gcc", "en"), ("AMC", "gcc", "en"),
        ("planned preventive maintenance", "uk", "en"), ("PPM", "uk", "en"),
        ("preventive maintenance", "intl", "en"), ("preventative maintenance", "uk", "en"),
        ("maintenance contract", "intl", "en"), ("service agreement", "us", "en"),
        ("عقد صيانة", "gcc", "ar"), ("صيانة دورية", "gcc", "ar"), ("техническое обслуживание", "ru", "ru"),
    ],
    "service_repair": [
        ("repair", "intl", "en"), ("repairs", "intl", "en"), ("breakdown", "uk", "en"),
        ("service call", "us", "en"), ("call-out", "uk", "en"), ("troubleshooting", "intl", "en"),
        ("spare parts", "intl", "en"), ("إصلاح", "gcc", "ar"), ("تصليح", "gcc", "ar"),
        ("قطع غيار", "gcc", "ar"), ("ремонт", "ru", "ru"),
    ],
    "inspection_certification": [
        ("thorough examination", "uk", "en"), ("LOLER", "uk", "en"), ("load test", "intl", "en"),
        ("third party inspection", "gcc", "en"), ("TPI", "gcc", "en"), ("annual inspection", "us", "en"),
        ("inspection certificate", "intl", "en"), ("certification", "intl", "en"), ("inspection", "intl", "en"),
        ("فحص", "gcc", "ar"), ("شهادة فحص", "gcc", "ar"), ("техническое освидетельствование", "ru", "ru"),
    ],
    "supply_only": [
        ("supply only", "intl", "en"), ("sale and supply", "intl", "en"), ("for sale", "intl", "en"),
        ("بيع", "gcc", "ar"),
    ],
    "tender": [
        ("tender", "uk", "en"), ("tender", "gcc", "en"), ("RFQ", "intl", "en"),
        ("request for quotation", "intl", "en"), ("invitation to tender", "uk", "en"),
        ("bid", "us", "en"), ("RFP", "us", "en"), ("ITB", "gcc", "en"),
        ("مناقصة", "gcc", "ar"), ("ممارسة", "gcc", "ar"), ("тендер", "ru", "ru"),
    ],
}
WORK_TYPE_PHRASES = {wt: [(t, _REGION_ALIAS.get(r, r), lang) for t, r, lang in lst]
                     for wt, lst in WORK_TYPE_PHRASES.items()}

# --------------------------------------------------------------------------------------------
# Built-in defaults (used only when a data file is missing or unusable)
# --------------------------------------------------------------------------------------------


def _t(term: str, region: str = "global", language: str = "en", usage: str = "common") -> dict:
    return {"term": term, "region": _REGION_ALIAS.get(region, region), "language": language, "usage": usage}


_BUILTIN_REGION_TERMS: dict[str, Any] = {
    "version": 1,
    "regions": [
        {"key": "GCC", "label": "Gulf / Middle East"},
        {"key": "UK_EU", "label": "UK / Europe"},
        {"key": "US", "label": "North America"},
        {"key": "RU_CIS", "label": "Russia / CIS"},
        {"key": "SOUTH_ASIA", "label": "South Asia"},
    ],
    "concepts": [
        {"key": "bmu", "canonical": "Building maintenance unit", "category": "bmu", "notes": "",
         "terms": [_t("BMU"), _t("building maintenance unit"), _t("roof car", "eu"), _t("facade access machine", "uk"),
                   _t("powered platform", "us"), _t("وحدة صيانة المباني", "gcc", "ar"),
                   _t("وحدة صيانة الواجهات", "gcc", "ar"), _t("Fassadenbefahranlage", "eu", "de"),
                   _t("фасадный подъемник", "ru", "ru")]},
        {"key": "window_cleaning_equipment", "canonical": "Window cleaning equipment", "category": "wce", "notes": "",
         "terms": [_t("window cleaning equipment"), _t("window cleaning system"), _t("facade cleaning system", "gcc"),
                   _t("window washing equipment", "us"), _t("davit system"), _t("davit arm"), _t("monorail system"),
                   _t("معدات تنظيف الواجهات", "gcc", "ar"), _t("система мойки фасадов", "ru", "ru")]},
        {"key": "suspended_platform", "canonical": "Suspended platform", "category": "cradle", "notes": "",
         "terms": [_t("cradle", "uk"), _t("temporary suspended platform", "eu"), _t("suspended access equipment", "eu"),
                   _t("suspended platform"), _t("swing stage", "us"), _t("suspended scaffold", "us"),
                   _t("gondola", "gcc"), _t("جندولا", "gcc", "ar"), _t("سقالة معلقة", "gcc", "ar"),
                   _t("люлька строительная", "ru", "ru")]},
        {"key": "construction_hoist", "canonical": "Construction hoist", "category": "hoist", "notes": "",
         "terms": [_t("construction hoist"), _t("passenger hoist", "uk"), _t("goods hoist", "uk"),
                   _t("builders hoist", "uk"), _t("material hoist", "gcc"), _t("construction elevator", "us"),
                   _t("buck hoist", "us"), _t("rack and pinion hoist"), _t("رافعة أفراد", "gcc", "ar"),
                   _t("مصعد إنشائي", "gcc", "ar"), _t("строительный подъемник", "ru", "ru")]},
        {"key": "crane", "canonical": "Crane", "category": "crane", "notes": "",
         "terms": [_t("tower crane"), _t("mobile crane"), _t("crawler crane"), _t("رافعة برجية", "gcc", "ar"),
                   _t("كرين", "gcc", "ar"), _t("башенный кран", "ru", "ru")]},
        {"key": "mewp", "canonical": "Mobile elevating work platform", "category": "access_rental", "notes": "",
         "terms": [_t("MEWP", "uk"), _t("mobile elevating work platform", "uk"), _t("cherry picker", "uk"),
                   _t("aerial work platform", "us"), _t("aerial lift", "us"), _t("bucket truck", "us"),
                   _t("boom lift"), _t("scissor lift"), _t("man lift", "gcc"), _t("manlift", "gcc"),
                   _t("رافعة سلة", "gcc", "ar"), _t("رافعة مقصية", "gcc", "ar"), _t("автовышка", "ru", "ru")]},
        {"key": "scaffolding", "canonical": "Scaffolding", "category": "scaffolding", "notes": "",
         "terms": [_t("scaffolding"), _t("scaffold"), _t("tube and fitting", "uk"), _t("cuplock", "gcc"),
                   _t("ringlock"), _t("سقالات", "gcc", "ar"), _t("строительные леса", "ru", "ru")]},
        {"key": "space_frame", "canonical": "Space frame", "category": "space_frame", "notes": "",
         "terms": [_t("space frame"), _t("shade structure", "gcc"), _t("car park shade", "gcc"),
                   _t("tensile structure"), _t("هياكل فراغية", "gcc", "ar"), _t("مظلات", "gcc", "ar")]},
        {"key": "boq", "canonical": "Bill of quantities", "category": "document", "notes": "",
         "terms": [_t("bill of quantities", "uk"), _t("BOQ", "gcc"), _t("schedule of values", "us"),
                   _t("bid schedule", "us"), _t("جدول الكميات", "gcc", "ar"),
                   _t("ведомость объемов работ", "ru", "ru")]},
        {"key": "method_statement", "canonical": "Method statement", "category": "document", "notes": "",
         "terms": [_t("method statement", "uk"), _t("RAMS", "uk"), _t("work plan", "us"),
                   _t("job hazard analysis", "us"), _t("خطة العمل", "gcc", "ar")]},
    ],
}

_BUILTIN_STANDARDS: dict[str, Any] = {
    "version": 1,
    "standards": [
        {"code": "EN 1808", "title": "Safety requirements for suspended access equipment", "region": ["eu", "uk", "gcc"],
         "applies_to": ["bmu", "cradle", "wce"], "notes": ""},
        {"code": "EN 795", "title": "Personal fall protection equipment - Anchor devices", "region": ["eu", "uk"],
         "applies_to": ["wce"], "notes": ""},
        {"code": "BS 6037", "title": "Planning, design, installation and use of permanently installed access equipment",
         "region": ["uk"], "applies_to": ["bmu", "wce", "cradle"], "notes": ""},
        {"code": "BS 5974", "title": "Planning, design, setting up and use of temporary suspended access equipment",
         "region": ["uk"], "applies_to": ["cradle"], "notes": ""},
        {"code": "EN 12159", "title": "Builders hoists for persons and materials with vertically guided cages",
         "region": ["eu", "uk"], "applies_to": ["hoist"], "notes": ""},
        {"code": "EN 280", "title": "Mobile elevating work platforms - Design calculations, stability, construction",
         "region": ["eu", "uk"], "applies_to": ["access_rental"], "notes": ""},
        {"code": "ANSI/IWCA I-14.1", "title": "Window Cleaning Safety Standard", "region": ["us"],
         "applies_to": ["wce"], "notes": ""},
        {"code": "OSHA 1910.66", "title": "Powered platforms for building maintenance", "region": ["us"],
         "applies_to": ["bmu"], "notes": ""},
        {"code": "ASME A120.1", "title": "Safety requirements for powered platforms for building maintenance",
         "region": ["us"], "applies_to": ["bmu"], "notes": ""},
        {"code": "LOLER 1998", "title": "Lifting Operations and Lifting Equipment Regulations 1998", "region": ["uk"],
         "applies_to": ["inspection_certification"], "notes": ""},
        {"code": "ISO 9001", "title": "Quality management systems", "region": ["intl"], "applies_to": [], "notes": ""},
        {"code": "ISO 45001", "title": "Occupational health and safety management systems", "region": ["intl"],
         "applies_to": [], "notes": ""},
    ],
}
for _s in _BUILTIN_STANDARDS["standards"]:
    _s["region"] = list(dict.fromkeys(_REGION_ALIAS.get(r, r) for r in _s["region"]))


def _cat(key: str, label: str, label_ar: str, group: str, icon: str, en: list[str], ar: list[str],
         description: str, *, visible: bool = True, neg_en: list[str] | None = None) -> dict:
    return {"key": key, "label": label, "label_ar": label_ar, "group": group, "icon": icon, "visible": visible,
            "is_work_type": group == "work", "keywords": {"en": en, "ar": ar},
            "negative_keywords": {"en": neg_en or [], "ar": []}, "description": description}


_BUILTIN_CATEGORIES: dict[str, Any] = {
    "version": 1,
    "categories": [
        _cat("bmu", "Building Maintenance Units", "وحدات صيانة المباني", "work", "building-2",
             ["BMU", "building maintenance unit", "roof car"], ["وحدة صيانة المباني"],
             "Permanent roof-mounted facade access machines."),
        _cat("wce", "Window Cleaning Equipment", "معدات تنظيف الواجهات", "work", "sparkles",
             ["window cleaning equipment", "facade cleaning", "davit", "monorail"], ["تنظيف الواجهات"],
             "Monorails, davits, facade cleaning systems and cleaning cradles."),
        _cat("cradle", "Suspended platforms / cradles", "المنصات المعلقة", "work", "move-vertical",
             ["cradle", "gondola", "suspended platform", "swing stage"], ["جندولا", "سقالة معلقة"],
             "Temporary suspended platforms and cradles."),
        _cat("hoist", "Construction hoists & personnel lifts", "رافعات الأفراد والمواد", "work", "arrow-up-down",
             ["construction hoist", "passenger hoist", "material hoist"], ["رافعة أفراد"],
             "Rack-and-pinion hoists for people and materials."),
        _cat("crane", "Cranes & lifting", "الرافعات", "work", "construction",
             ["tower crane", "mobile crane"], ["رافعة برجية"], "Cranes and lifting equipment."),
        _cat("access_rental", "Access equipment rental", "تأجير معدات الوصول", "work", "truck",
             ["man lift", "boom lift", "scissor lift", "MEWP"], ["رافعة سلة"],
             "Man-lifts, scissor lifts and booms for rent."),
        _cat("scaffolding", "Scaffolding", "السقالات", "work", "grid-3x3",
             ["scaffolding", "scaffold"], ["سقالات"], "Scaffolding systems."),
        _cat("space_frame", "Space frames & shades", "الهياكل الفراغية والمظلات", "work", "triangle",
             ["space frame", "shade structure"], ["مظلات"], "Space frames, shades and tensile structures."),
        _cat("other_work", "Other work requests", "طلبات عمل أخرى", "work", "briefcase", [], [],
             "Enquiries for work outside the listed service families."),
        _cat("vendor_offer", "Supplier & OEM offers", "عروض الموردين", "other", "store",
             ["price list", "product catalogue", "distributor", "special offer"], ["قائمة أسعار"],
             "Offers from suppliers and manufacturers."),
        _cat("bills", "Bills, invoices, payments", "الفواتير والمدفوعات", "bills", "receipt",
             ["invoice", "payment", "statement of account", "receipt"], ["فاتورة", "كشف حساب"],
             "Invoices, payment requests and statements."),
        _cat("promotions", "Newsletters, ads, marketplaces", "النشرات والإعلانات", "promotions", "megaphone",
             ["newsletter", "unsubscribe", "webinar"], ["نشرة"], "Newsletters, advertising and marketplaces."),
        _cat("internal", "Internal / colleagues", "داخلي", "other", "users", [], [], "Mail between colleagues."),
        _cat("notifications", "System notifications", "إشعارات النظام", "other", "bell",
             ["notification", "security alert", "verify your"], [], "Automatic system notifications."),
        _cat("other", "Everything else", "أخرى", "other", "inbox", [], [], "Everything else."),
    ],
}

_BUILTIN_CROSS_SELL: dict[str, Any] = {
    "version": 1,
    "service_adjacency": [
        {"from": "bmu", "to": "wce", "reason": "Buildings with a BMU usually need davits or monorails for areas the BMU cannot reach."},
        {"from": "wce", "to": "bmu", "reason": "Facade-cleaning customers often own towers that need a BMU."},
        {"from": "bmu", "to": "cradle", "reason": "Temporary cradles are needed for facade works before the BMU is commissioned."},
        {"from": "cradle", "to": "hoist", "reason": "Sites using cradles for facade works usually also need hoists."},
        {"from": "hoist", "to": "crane", "reason": "High-rise sites with hoists also need lifting capacity."},
        {"from": "crane", "to": "access_rental", "reason": "Lifting contractors regularly rent man-lifts for installation works."},
        {"from": "access_rental", "to": "scaffolding", "reason": "Access-rental customers often need scaffolding for longer works."},
        {"from": "scaffolding", "to": "cradle", "reason": "Facade works can switch from scaffolding to cradles on tall elevations."},
        {"from": "supply_installation", "to": "annual_maintenance", "reason": "Installed equipment needs a maintenance contract."},
        {"from": "annual_maintenance", "to": "service_repair", "reason": "Maintained equipment generates repair and spare-part work."},
        {"from": "equipment_rental", "to": "inspection_certification", "reason": "Rented lifting equipment needs periodic inspection."},
    ],
    "customer_kind_needs": {
        "main_contractor": ["hoist", "crane", "cradle", "scaffolding", "access_rental", "bmu"],
        "subcontractor": ["cradle", "access_rental", "scaffolding"],
        "consultant": ["bmu", "wce"],
        "developer": ["bmu", "wce", "space_frame"],
        "government": ["bmu", "wce", "space_frame", "annual_maintenance"],
        "facility_management": ["annual_maintenance", "wce", "access_rental", "service_repair"],
    },
    "project_type_needs": {
        "tower": ["bmu", "wce", "hoist", "crane", "cradle"],
        "hospital": ["bmu", "wce", "space_frame"],
        "mall": ["wce", "space_frame", "access_rental"],
        "school": ["space_frame", "wce"],
        "airport": ["access_rental", "wce", "bmu"],
        "industrial": ["access_rental", "scaffolding", "crane"],
        "oil_gas": ["scaffolding", "access_rental", "crane"],
        "marine": ["crane", "access_rental"],
        "government": ["bmu", "wce", "space_frame"],
        "hotel": ["bmu", "wce"],
        "residential": ["wce", "hoist"],
    },
}

# --------------------------------------------------------------------------------------------
# Text normalisation
# --------------------------------------------------------------------------------------------

_INVISIBLE = "​‌‍‎‏⁠﻿­؜‪‫‬‭‮⁦⁧⁨⁩"
_CHAR_MAP_SRC: dict[str, str] = {
    "آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا", "ٲ": "ا",
    "ٳ": "ا",  # alef variants -> alef
    "ى": "ي", "ی": "ي", "ے": "ي",  # alef maqsura / farsi yeh -> yeh
    "ة": "ه",  # teh marbuta -> heh
    "ؤ": "و", "ئ": "ي",  # hamza carriers -> base letters
    "ک": "ك", "ہ": "ه", "ھ": "ه",  # keheh, heh variants
    "،": ",", "؛": ";", "؟": "?", "٫": ".", "٬": ",", "٪": "%", "۔": ".",
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "´": "'", "`": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "«": '"', "»": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
    "ـ": "",  # tatweel
}
for _i in range(10):
    _CHAR_MAP_SRC[chr(0x0660 + _i)] = str(_i)  # Arabic-Indic digits
    _CHAR_MAP_SRC[chr(0x06F0 + _i)] = str(_i)  # Extended Arabic-Indic digits
for _c in _INVISIBLE:
    _CHAR_MAP_SRC[_c] = ""
_CHAR_TABLE = str.maketrans(_CHAR_MAP_SRC)
_SPACE_RE = re.compile(r"\s+")


def normalize_text(text: Any) -> str:
    """Normalise text for matching (never for display).

    NFKD + removal of combining marks (Latin accents, Arabic harakat, madda, hamza marks),
    Arabic letter variants (alef forms, alef maqsura/yeh, teh marbuta, hamza carriers), tatweel,
    Arabic-Indic digits, smart quotes and dashes, invisible bidi/zero-width characters, casefold,
    and whitespace collapsed to single spaces.
    """
    if text is None:
        return ""
    s = str(text)
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.translate(_CHAR_TABLE).casefold()
    return _SPACE_RE.sub(" ", s).strip()


def slugify(text: Any, max_len: int = 64) -> str:
    """Stable key from a label: ``"Fan coil units"`` -> ``"fan_coil_units"`` (Arabic kept)."""
    s = re.sub(r"[^\w]+", "_", normalize_text(text)).strip("_")
    return s[:max_len].strip("_") or "item"


# Script detection ---------------------------------------------------------------------------

_ARABIC_CHARS = re.compile("[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")
_CYRILLIC_CHARS = re.compile("[Ѐ-ӿ]")
_LATIN_CHARS = re.compile("[A-Za-zÀ-ɏ]")
_LATIN_STOPWORDS = {
    "en": {"the", "and", "of", "to", "for", "with", "is", "are", "please", "we", "our", "you", "your", "this"},
    "de": {"der", "die", "und", "das", "mit", "für", "ist", "nicht", "wir", "sie", "ein", "eine", "den"},
    "fr": {"le", "la", "les", "et", "des", "pour", "avec", "est", "nous", "une", "du", "dans"},
    "es": {"el", "los", "las", "y", "para", "con", "es", "una", "por", "del", "que", "en"},
}


def script_counts(text: str) -> dict[str, int]:
    """Letter counts per script: ``{"arabic", "cyrillic", "latin"}``."""
    t = text or ""
    return {"arabic": len(_ARABIC_CHARS.findall(t)), "cyrillic": len(_CYRILLIC_CHARS.findall(t)),
            "latin": len(_LATIN_CHARS.findall(t))}


def detect_language(text: str | None, sample: int = 6000) -> str | None:
    """Dominant language by script (``ar``, ``ru``) and, for Latin script, by stopwords
    (``en`` default, ``de``, ``fr``, ``es``). ``None`` when the text has (almost) no letters."""
    t = (text or "")[:sample]
    c = script_counts(t)
    total = sum(c.values())
    if total < 3:
        return None
    if c["arabic"] >= c["latin"] and c["arabic"] >= c["cyrillic"]:
        return "ar"
    if c["cyrillic"] > c["latin"]:
        return "ru"
    words = re.findall(r"[a-zà-ÿ]+", t.lower())
    scores = {lang: sum(1 for w in words if w in sw) for lang, sw in _LATIN_STOPWORDS.items()}
    best = max(scores, key=lambda k: (scores[k], k == "en"))
    return best if scores[best] > scores["en"] else "en"


def _term_language(term: str) -> str:
    c = script_counts(term)
    if c["arabic"]:
        return "ar"
    if c["cyrillic"]:
        return "ru"
    return "en"


# --------------------------------------------------------------------------------------------
# Tokens and stems (shared by every matcher, so terms and documents are cut the same way)
# --------------------------------------------------------------------------------------------

_MARKS = "̀-ͯؐ-ًؚ-ٰٟۖ-ۭ"
_TOKEN_RE = re.compile(rf"(?:[^\W_]|[{_MARKS}])+(?:['’](?:[^\W_]|[{_MARKS}])+)*|&")
_GAP_OK_RE = re.compile(r"[ \t,\-‐-―/'’\"“”]*")

_EN_KEEP = frozenset(
    {"news", "series", "species", "chassis", "lens", "gas", "bus", "plus", "status", "campus", "thus", "this",
     "has", "was", "its", "his", "hers", "ours", "yours", "less", "unless", "always", "perhaps", "dos", "sms",
     "gps", "ups", "kos", "ems", "hvac", "rams", "loler", "puwer", "lps", "ppms", "billions"}
)
_AR_PREFIXES = ("وال", "بال", "كال", "فال", "لل", "ال")
_AR_SUFFIXES = ("ات", "ون", "ين", "يه", "ه")
_RU_ENDINGS = ("ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ах", "ях", "ов", "ев", "ой", "ей", "ий",
               "ый", "ая", "яя", "ое", "ее", "ые", "ие", "ам", "ям", "ом", "ем", "а", "я", "ы", "и", "у", "ю",
               "е", "о", "ь")


class Token(NamedTuple):
    text: str  # surface form, exactly as in the source
    norm: str  # normalize_text(surface)
    key: str  # light stem of norm, used for matching
    start: int  # offsets into the source text
    end: int


def stem_token(tok: str) -> str:
    """Very light, script-aware stemming so ``hoists``/``hoist`` and ``للمقاولات``/``مقاولات`` meet."""
    if not tok:
        return tok
    first = tok[0]
    if "؀" <= first <= "ۿ":
        for p in _AR_PREFIXES:
            if tok.startswith(p) and len(tok) - len(p) >= 3:
                tok = tok[len(p):]
                break
        for s in _AR_SUFFIXES:
            if tok.endswith(s) and len(tok) - len(s) >= 3:
                return tok[: -len(s)]
        return tok
    if "Ѐ" <= first <= "ӿ":
        for s in _RU_ENDINGS:
            if tok.endswith(s) and len(tok) - len(s) >= 4:
                return tok[: -len(s)]
        return tok
    if "'" in tok:
        tok = tok[:-2] if tok.endswith("'s") else tok.replace("'", "")
    if len(tok) <= 3 or tok in _EN_KEEP or not tok.isalpha():
        return tok
    if tok.endswith("ies") and len(tok) > 4:
        return tok[:-3] + "y"
    if tok.endswith(("sses", "shes", "ches", "xes")):
        return tok[:-2]
    if tok.endswith("s") and not tok.endswith(("ss", "us", "is")):
        return tok[:-1]
    return tok


_AR_PROCLITICS = ("و", "ف", "ب", "ل", "ك")


@lru_cache(maxsize=65536)
def _proclitic_alt(norm: str) -> str | None:
    """Stem of an Arabic word without its one-letter proclitic (``وتوريد`` -> ``توريد``)."""
    if len(norm) >= 4 and norm[0] in _AR_PROCLITICS and "؀" <= norm[1] <= "ۿ":
        return stem_token(norm[1:])
    return None


@lru_cache(maxsize=262144)
def _token_forms(surface: str) -> tuple[str, str]:
    norm = normalize_text(surface).replace(" ", "")
    return norm, stem_token(norm)


def tokenize(text: str, start: int = 0, end: int | None = None) -> list[Token]:
    """Word tokens with offsets into ``text`` (``&`` becomes the token ``and``)."""
    out: list[Token] = []
    if not text:
        return out
    stop = len(text) if end is None else min(end, len(text))
    for m in _TOKEN_RE.finditer(text, start, stop):
        surf = m.group(0)
        if surf == "&":
            out.append(Token(surf, "and", "and", m.start(), m.end()))
            continue
        norm, key = _token_forms(surf)
        if norm:
            out.append(Token(surf, norm, key, m.start(), m.end()))
    return out


def match_key(term: str) -> str:
    """The key under which a term is indexed (stemmed tokens joined by single spaces)."""
    return " ".join(t.key for t in tokenize(term or ""))


def term_keys(term: str) -> list[str]:
    """Main key plus a joined variant for short Latin compounds (``man lift`` ~ ``manlift``)."""
    keys = [t.key for t in tokenize(term or "")]
    if not keys:
        return []
    out = [" ".join(keys)]
    if len(keys) >= 2 and all(k.isascii() and k.isalpha() for k in keys) and (
            len(keys) == 2 or all(len(k) == 1 for k in keys)):
        joined = "".join(keys)
        if joined not in out:
            out.append(joined)
    return out


def gaps_ok(text: str, tokens: list[Token]) -> list[bool]:
    """``ok[i]`` is True when tokens ``i`` and ``i+1`` may belong to one term (same line, no
    sentence punctuation between them)."""
    return [bool(_GAP_OK_RE.fullmatch(text, tokens[i].end, tokens[i + 1].start)) for i in range(len(tokens) - 1)]


# --------------------------------------------------------------------------------------------
# Term index
# --------------------------------------------------------------------------------------------


class TermEntry(NamedTuple):
    term: str  # as written in the data
    key: str  # main match key
    concept: str  # concept key (or category / work-type key for keyword entries)
    canonical: str
    category: str  # mail category / work type / other grouping from the data
    region: str
    language: str
    usage: str
    origin: str  # region_terms | category | work_type | standard | custom


class TermMatch(NamedTuple):
    start: int
    end: int
    surface: str  # exact text in the document
    key: str
    entries: tuple[TermEntry, ...]
    token_start: int
    token_end: int


def make_entry(term: str, *, concept: str, canonical: str = "", category: str = "", region: str = GLOBAL_REGION,
               language: str | None = None, usage: str = "", origin: str = "custom") -> TermEntry | None:
    keys = term_keys(term)
    if not keys:
        return None
    return TermEntry(term=term, key=keys[0], concept=concept, canonical=canonical or term, category=category,
                     region=(region or GLOBAL_REGION), language=language or _term_language(term), usage=usage or "",
                     origin=origin)


class TermIndex(Mapping):
    """Match key -> entries, with greedy longest-match search over tokenised text."""

    def __init__(self, entries: Iterable[TermEntry | None] = ()) -> None:
        self._map: dict[str, list[TermEntry]] = {}
        self._first: set[str] = set()
        self.max_tokens = 1
        for e in entries:
            if e is not None:
                self.add(e)

    @classmethod
    def from_phrases(cls, phrases: Mapping[str, Iterable[str]], *, origin: str = "custom",
                     category: str | None = None, region: str = GLOBAL_REGION) -> "TermIndex":
        """Build an index from ``{key: [phrases]}`` (e.g. cue lists); the key becomes ``concept``."""
        idx = cls()
        for key, terms in phrases.items():
            for term in terms:
                e = make_entry(term, concept=key, canonical=key, category=category or key, region=region,
                               origin=origin)
                if e is not None:
                    idx.add(e)
        return idx

    def add(self, entry: TermEntry) -> None:
        for k in term_keys(entry.term):
            lst = self._map.setdefault(k, [])
            if entry not in lst:
                lst.append(entry)
            parts = k.split(" ")
            self._first.add(parts[0])
            if len(parts) > self.max_tokens:
                self.max_tokens = len(parts)

    # Mapping protocol ---------------------------------------------------------------------
    def __getitem__(self, key: str) -> tuple[TermEntry, ...]:
        return tuple(self._map[key])

    def __iter__(self) -> Iterator[str]:
        return iter(self._map)

    def __len__(self) -> int:
        return len(self._map)

    def __contains__(self, key: object) -> bool:
        return key in self._map

    # Lookups --------------------------------------------------------------------------------
    def lookup(self, term: str) -> tuple[TermEntry, ...]:
        """Entries for a raw term (normalised and stemmed first)."""
        out: list[TermEntry] = []
        for k in term_keys(term):
            for e in self._map.get(k, ()):
                if e not in out:
                    out.append(e)
        return tuple(out)

    def entries(self) -> Iterator[TermEntry]:
        seen: set[TermEntry] = set()
        for lst in self._map.values():
            for e in lst:
                if e not in seen:
                    seen.add(e)
                    yield e

    def find(self, text: str) -> list[TermMatch]:
        toks = tokenize(text)
        return self.find_tokens(toks, text, gaps_ok(text, toks))

    def find_tokens(self, tokens: list[Token], text: str, gaps: list[bool] | None = None) -> list[TermMatch]:
        """Greedy longest match; matches never overlap and never cross a line or sentence break."""
        out: list[TermMatch] = []
        n = len(tokens)
        if not n:
            return out
        if gaps is None:
            gaps = gaps_ok(text, tokens)
        keys = [t.key for t in tokens]
        i = 0
        while i < n:
            firsts = [keys[i]]
            alt = _proclitic_alt(tokens[i].norm)
            if alt:
                firsts.append(alt)
            firsts = [f for f in firsts if f in self._first]
            if not firsts:
                i += 1
                continue
            best: tuple[int, str, list[TermEntry]] | None = None
            limit = 1
            while limit < self.max_tokens and i + limit < n and gaps[i + limit - 1]:
                limit += 1
            for length in range(limit, 0, -1):
                rest = keys[i + 1:i + length]
                for first in firsts:
                    k = " ".join([first, *rest])
                    found = self._map.get(k)
                    if found:
                        best = (length, k, found)
                        break
                if best is not None:
                    break
            if best is None:
                i += 1
                continue
            length, k, found = best
            s, e = tokens[i].start, tokens[i + length - 1].end
            out.append(TermMatch(s, e, text[s:e], k, tuple(found), i, i + length))
            i += length
        return out


def is_catch_all_category(key: str) -> bool:
    """``other``, ``other_work``... catch-all categories never become learned families."""
    return key == "other" or key.startswith("other_") or key.endswith("_other")


def _region_term_entries(region_terms: Mapping[str, Any]) -> Iterator[TermEntry | None]:
    for c in region_terms.get("concepts") or []:
        seen: set[str] = set()
        for t in c.get("terms") or []:
            seen.add(match_key(t["term"]))
            yield make_entry(t["term"], concept=c["key"], canonical=c.get("canonical") or c["key"],
                             category=c.get("category") or "", region=t.get("region") or GLOBAL_REGION,
                             language=t.get("language"), usage=t.get("usage") or "", origin="region_terms")
        canonical = c.get("canonical") or ""
        if canonical and "(" not in canonical and match_key(canonical) not in seen:
            yield make_entry(canonical, concept=c["key"], canonical=canonical, category=c.get("category") or "",
                             region=GLOBAL_REGION, usage="canonical", origin="region_terms")


def _category_entries(categories: Iterable[Mapping[str, Any]]) -> Iterator[TermEntry | None]:
    for cat in categories:
        if not cat.get("is_work_type") or is_catch_all_category(cat["key"]):
            continue
        for lang, words in (cat.get("keywords") or {}).items():
            for w in words or []:
                yield make_entry(w, concept=cat["key"], canonical=cat.get("label") or cat["key"],
                                 category=cat["key"], region=GLOBAL_REGION, language=lang, usage="keyword",
                                 origin="category")


def _work_type_entries() -> Iterator[TermEntry | None]:
    for wt, phrases in WORK_TYPE_PHRASES.items():
        for term, region, lang in phrases:
            yield make_entry(term, concept=wt, canonical=WORK_TYPES[wt]["label"], category="work_type",
                             region=region, language=lang, usage="work_type", origin="work_type")


def build_term_index(region_terms: Mapping[str, Any] | None = None,
                     categories: Iterable[Mapping[str, Any]] | None = None, *,
                     include_work_types: bool = True, include_category_keywords: bool = True) -> TermIndex:
    """Index regional concept terms, work-category keywords and built-in work-type phrases."""
    rt = region_terms if region_terms is not None else _cached(REGION_TERMS_FILE)
    cats = list(categories) if categories is not None else _cached(CATEGORIES_FILE)
    idx = TermIndex(_region_term_entries(rt))
    if include_category_keywords:
        for e in _category_entries(cats):
            if e is not None:
                idx.add(e)
    if include_work_types:
        for e in _work_type_entries():
            if e is not None:
                idx.add(e)
    return idx


_INDEX_CACHE: dict[tuple, TermIndex] = {}


def term_index(region_terms: Mapping[str, Any] | None = None,
               categories: Iterable[Mapping[str, Any]] | None = None) -> TermIndex:
    """Fast lookup ``term -> concept / category / region / language``.

    ``term_index().lookup("gondolas")`` -> entries of the suspended-platform concept (``gcc``).
    Without arguments the index is built from the data files and cached until they change.
    """
    if region_terms is not None or categories is not None:
        return build_term_index(region_terms, categories)
    stamp = (_stamp(DATA_DIR / REGION_TERMS_FILE), _stamp(DATA_DIR / CATEGORIES_FILE))
    with _LOCK:
        cached = _INDEX_CACHE.get(stamp)
    if cached is None:
        cached = build_term_index()
        with _LOCK:
            _INDEX_CACHE.clear()
            _INDEX_CACHE[stamp] = cached
    return cached


# --------------------------------------------------------------------------------------------
# Validation (lenient: bad entries are dropped and reported, good ones kept)
# --------------------------------------------------------------------------------------------


def _key(value: Any) -> str:
    return re.sub(r"[\s\-]+", "_", str(value or "").strip().lower())


def _region_key(value: Any) -> str:
    """Region keys keep the case used by the data (``GCC``, ``UK_EU``, ``global``)."""
    return re.sub(r"[\s\-]+", "_", str(value or "").strip())


def _str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple, set)):
        return []
    out = []
    for v in value:
        s = _str(v)
        if s and s not in out:
            out.append(s)
    return out


def _lang_lists(value: Any) -> dict[str, list[str]]:
    if isinstance(value, (list, tuple, str)):
        value = {"en": value}
    if not isinstance(value, dict):
        return {"en": [], "ar": []}
    out = {str(k).strip().lower(): _str_list(v) for k, v in value.items() if str(k).strip()}
    out.setdefault("en", [])
    out.setdefault("ar", [])
    return out


def validate_region_terms(raw: Any, issues: list[str] | None = None) -> dict | None:
    """Validated copy of a region-terms document, or ``None`` when nothing usable is left."""
    issues = issues if issues is not None else []
    if not isinstance(raw, dict):
        issues.append("region_terms: top level must be an object")
        return None
    regions: list[dict] = []
    for i, r in enumerate(raw.get("regions") or []):
        if isinstance(r, str) and r.strip():
            r = {"key": r, "label": r}
        if not isinstance(r, dict) or not _str(r.get("key")):
            issues.append(f"region_terms: regions[{i}] has no key")
            continue
        key = _region_key(r["key"])
        if all(x["key"] != key for x in regions):
            regions.append({"key": key, "label": _str(r.get("label")) or key})
    concepts: list[dict] = []
    seen_keys: set[str] = set()
    for i, c in enumerate(raw.get("concepts") or []):
        if not isinstance(c, dict) or not _str(c.get("key")):
            issues.append(f"region_terms: concepts[{i}] has no key")
            continue
        terms: list[dict] = []
        for j, t in enumerate(c.get("terms") or []):
            if isinstance(t, str):
                t = {"term": t}
            if not isinstance(t, dict) or not _str(t.get("term")):
                issues.append(f"region_terms: concepts[{i}].terms[{j}] has no term")
                continue
            term = _str(t["term"])
            for reg in _str_list(t.get("region")) or [GLOBAL_REGION]:
                terms.append({"term": term, "region": _region_key(reg) or GLOBAL_REGION,
                              "language": _str(t.get("language")).lower() or _term_language(term),
                              "usage": _str(t.get("usage"))})
        if not terms:
            issues.append(f"region_terms: concept {c.get('key')!r} has no valid terms")
            continue
        key = _key(c["key"])
        if key in seen_keys:
            issues.append(f"region_terms: duplicate concept key {key!r} merged")
            prev = next(x for x in concepts if x["key"] == key)
            prev["terms"].extend(t for t in terms if t not in prev["terms"])
            continue
        seen_keys.add(key)
        concepts.append({"key": key, "canonical": _str(c.get("canonical")) or _str(c["key"]),
                         "category": _key(c.get("category")), "terms": terms, "notes": _str(c.get("notes"))})
    if not concepts:
        issues.append("region_terms: no valid concepts")
        return None
    known = {r["key"] for r in regions}
    for c in concepts:
        for t in c["terms"]:
            if t["region"] not in known:
                known.add(t["region"])
                regions.append({"key": t["region"], "label": t["region"].upper()})
    return {"version": _int(raw.get("version"), 1), "regions": regions, "concepts": concepts}


def validate_standards(raw: Any, issues: list[str] | None = None) -> dict | None:
    issues = issues if issues is not None else []
    items = raw.get("standards") if isinstance(raw, dict) else raw if isinstance(raw, list) else None
    if not isinstance(items, list):
        issues.append("standards: expected {'standards': [...]}")
        return None
    out: list[dict] = []
    seen: set[str] = set()
    for i, s in enumerate(items):
        if not isinstance(s, dict) or not _str(s.get("code")):
            issues.append(f"standards: standards[{i}] has no code")
            continue
        code = re.sub(r"\s+", " ", _str(s["code"]))
        if code.upper() in seen:
            issues.append(f"standards: duplicate code {code!r} skipped")
            continue
        seen.add(code.upper())
        out.append({"code": code, "title": _str(s.get("title")), "region": [_region_key(r) for r in _str_list(s.get("region"))],
                    "applies_to": [_key(a) for a in _str_list(s.get("applies_to"))], "notes": _str(s.get("notes"))})
    if not out:
        issues.append("standards: no valid standards")
        return None
    version = _int(raw.get("version"), 1) if isinstance(raw, dict) else 1
    return {"version": version, "standards": out}


def validate_categories(raw: Any, issues: list[str] | None = None) -> list[dict] | None:
    issues = issues if issues is not None else []
    items = raw.get("categories") if isinstance(raw, dict) else raw if isinstance(raw, list) else None
    if not isinstance(items, list):
        issues.append("default_categories: expected {'categories': [...]}")
        return None
    out: list[dict] = []
    for i, c in enumerate(items):
        if not isinstance(c, dict) or not _str(c.get("key")):
            issues.append(f"default_categories: categories[{i}] has no key")
            continue
        key = _key(c["key"])
        if any(x["key"] == key for x in out):
            issues.append(f"default_categories: duplicate key {key!r} skipped")
            continue
        group = _str(c.get("group")).lower() or ("work" if c.get("is_work_type") else "other")
        is_work = bool(c["is_work_type"]) if "is_work_type" in c and c["is_work_type"] is not None else group == "work"
        out.append({"key": key, "label": _str(c.get("label")) or key.replace("_", " ").title(),
                    "label_ar": _str(c.get("label_ar")), "group": group, "icon": _str(c.get("icon")) or "mail",
                    "visible": bool(c.get("visible", True)), "is_work_type": is_work,
                    "keywords": _lang_lists(c.get("keywords")),
                    "negative_keywords": _lang_lists(c.get("negative_keywords")),
                    "description": _str(c.get("description"))})
    if not out:
        issues.append("default_categories: no valid categories")
        return None
    return out


def validate_cross_sell(raw: Any, issues: list[str] | None = None) -> dict | None:
    issues = issues if issues is not None else []
    if not isinstance(raw, dict):
        issues.append("cross_sell: top level must be an object")
        return None
    adjacency: list[dict] = []
    for i, a in enumerate(raw.get("service_adjacency") or []):
        if not isinstance(a, dict) or not _str(a.get("from")) or not _str(a.get("to")):
            issues.append(f"cross_sell: service_adjacency[{i}] needs from/to")
            continue
        adjacency.append({"from": _key(a["from"]), "to": _key(a["to"]), "reason": _str(a.get("reason"))})

    def needs(name: str) -> dict[str, list[str]]:
        v = raw.get(name) or {}
        if not isinstance(v, dict):
            issues.append(f"cross_sell: {name} must be an object")
            return {}
        return {_key(k): [_key(s) for s in _str_list(lst)] for k, lst in v.items() if _str(k)}

    out = {"version": _int(raw.get("version"), 1), "service_adjacency": adjacency,
           "customer_kind_needs": needs("customer_kind_needs"), "project_type_needs": needs("project_type_needs")}
    if not (adjacency or out["customer_kind_needs"] or out["project_type_needs"]):
        issues.append("cross_sell: no usable rules")
        return None
    return out


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------------------------
# Loading with cache + fallback
# --------------------------------------------------------------------------------------------

_VALIDATORS = {
    REGION_TERMS_FILE: (validate_region_terms, _BUILTIN_REGION_TERMS),
    STANDARDS_FILE: (validate_standards, _BUILTIN_STANDARDS),
    CATEGORIES_FILE: (validate_categories, _BUILTIN_CATEGORIES),
    CROSS_SELL_FILE: (validate_cross_sell, _BUILTIN_CROSS_SELL),
}
_LOCK = threading.RLock()
_CACHE: dict[str, tuple[tuple, Any]] = {}
_ISSUES: dict[str, list[str]] = {}
_SOURCES: dict[str, str] = {}


def _stamp(path: Path) -> tuple:
    try:
        st = path.stat()
        return (str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return (str(path), None, None)


def _load_file(path: Path, name: str) -> tuple[Any, list[str], str]:
    validator, builtin = _VALIDATORS[name]
    issues: list[str] = []
    value = None
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            issues.append(f"{name}: unreadable ({exc})")
        else:
            value = validator(raw, issues)
        if value is None:
            issues.append(f"{name}: using built-in defaults")
    source = "file" if value is not None else "builtin"
    if value is None:
        value = validator(copy.deepcopy(builtin), [])
    for msg in issues:
        log.warning("knowledge data: %s", msg)
    return value, issues, source


def _cached(name: str, path: Path | str | None = None) -> Any:
    """Validated data (shared object - callers must not mutate it)."""
    p = Path(path) if path is not None else DATA_DIR / name
    stamp = _stamp(p)
    cache_key = f"{name}|{p}"
    with _LOCK:
        hit = _CACHE.get(cache_key)
        if hit is not None and hit[0] == stamp:
            return hit[1]
    value, issues, source = _load_file(p, name)
    with _LOCK:
        _CACHE[cache_key] = (stamp, value)
        if path is None:
            _ISSUES[name] = issues
            _SOURCES[name] = source
    return value


def load_region_terms(path: Path | str | None = None) -> dict:
    """``{"version", "regions": [{key, label}], "concepts": [{key, canonical, category, terms: [{term,
    region, language, usage}], notes}]}`` (a copy; safe to modify)."""
    return copy.deepcopy(_cached(REGION_TERMS_FILE, path))


def load_standards(path: Path | str | None = None) -> dict:
    """``{"version", "standards": [{code, title, region: [...], applies_to: [...], notes}]}``."""
    return copy.deepcopy(_cached(STANDARDS_FILE, path))


def default_categories(path: Path | str | None = None) -> list[dict]:
    """Default mail categories (work categories + bills, promotions, internal, ...)."""
    return copy.deepcopy(_cached(CATEGORIES_FILE, path))


def load_cross_sell(path: Path | str | None = None) -> dict:
    """``{"version", "service_adjacency": [{from, to, reason}], "customer_kind_needs": {...},
    "project_type_needs": {...}}``."""
    return copy.deepcopy(_cached(CROSS_SELL_FILE, path))


def load_issues() -> dict[str, list[str]]:
    """Problems found while loading the data files (per file name)."""
    for name in _VALIDATORS:
        _cached(name)
    with _LOCK:
        return {k: list(v) for k, v in _ISSUES.items()}


def data_sources() -> dict[str, str]:
    """``{file name: "file" | "builtin"}`` - where each data set currently comes from."""
    for name in _VALIDATORS:
        _cached(name)
    with _LOCK:
        return dict(_SOURCES)


def clear_caches() -> None:
    with _LOCK:
        _CACHE.clear()
        _ISSUES.clear()
        _SOURCES.clear()
        _INDEX_CACHE.clear()


def region_labels(region_terms: Mapping[str, Any] | None = None) -> dict[str, str]:
    rt = region_terms if region_terms is not None else _cached(REGION_TERMS_FILE)
    return {r["key"]: r.get("label") or r["key"] for r in rt.get("regions") or []}


def coerce_region_terms(region_terms: Any) -> dict:
    """Accept ``None`` (data file), a path, or an in-memory document; always return validated data."""
    if region_terms is None:
        return _cached(REGION_TERMS_FILE)
    if isinstance(region_terms, (str, Path)):
        return _cached(REGION_TERMS_FILE, region_terms)
    issues: list[str] = []
    value = validate_region_terms(region_terms, issues)
    for msg in issues:
        log.warning("knowledge data: %s", msg)
    return value if value is not None else _cached(REGION_TERMS_FILE)


def coerce_categories(categories: Any) -> list[dict]:
    if categories is None:
        return _cached(CATEGORIES_FILE)
    if isinstance(categories, (str, Path)):
        return _cached(CATEGORIES_FILE, categories)
    value = validate_categories(categories, [])
    return value if value is not None else _cached(CATEGORIES_FILE)


def coerce_standards(standards: Any) -> list[dict]:
    if standards is None:
        return _cached(STANDARDS_FILE)["standards"]
    if isinstance(standards, (str, Path)):
        return _cached(STANDARDS_FILE, standards)["standards"]
    value = validate_standards(standards, [])
    return value["standards"] if value is not None else _cached(STANDARDS_FILE)["standards"]


def coerce_cross_sell(cross_sell: Any) -> dict:
    if cross_sell is None:
        return _cached(CROSS_SELL_FILE)
    if isinstance(cross_sell, (str, Path)):
        return _cached(CROSS_SELL_FILE, cross_sell)
    value = validate_cross_sell(cross_sell, [])
    return value if value is not None else {"version": 1, "service_adjacency": [], "customer_kind_needs": {},
                                            "project_type_needs": {}}
