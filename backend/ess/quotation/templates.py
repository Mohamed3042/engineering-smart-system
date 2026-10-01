"""Official quotation templates, ported from the Medmack Quotation Builder (v1.5.0).

The builder's purpose families were derived from an audit of 4,732 historical quotations.
Each family keeps its *locked* wording (salutation, intro, conditions heading, standard scope,
closing) exactly as the builder prints it; only the repeatedly evidenced fields are variable:
customer / attention / subject / project, the item rows, and the editable default terms.

Registry keys map to the builder's quotation types and renderer branch IDs:

    tenders              -> "tenders"            (letter.html, English only)
    equipment_rental     -> "equipment-rental"   (rental-en / rental-ar)
    annual_maintenance   -> "annual-maintenance" (maintenance-en / maintenance-ar)
    supply_installation  -> "supply-install"     (supply-en / supply-ar)
    service_repair       -> "inspection-repair"  (service-en / service-ar)

Prices are never part of a template: ``default_quotation`` leaves every ``unit_price`` /
``total`` and every price-like term empty for the engineer to fill.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable, Mapping

from .numbering import next_reference

LANGUAGES = ("en", "ar")

# Builder price-unit choices (app/branches.js PRICE_UNITS_EN / PRICE_UNITS_AR).
PRICE_UNITS: dict[str, tuple[str, ...]] = {
    "en": ("Each", "Day", "Week", "Month", "m²", "Lump sum"),
    "ar": ("للوحدة", "يومي", "أسبوعي", "شهري", "م²", "مقطوعية"),
}


@dataclass(frozen=True)
class Column:
    """One items-table column. ``label`` may contain ``{currency}``."""

    key: str  # no | description | spec | qty | unit | unit_price | price_unit | total
    label: str
    weight: float = 1.0
    priced: bool = False  # filled by the engineer only (unit_price / total)


@dataclass(frozen=True)
class TermDefault:
    """An editable default term. ``text=None`` means "the engineer fills it" (never printed blank)."""

    key: str
    label: str
    text: str | None = None


@dataclass(frozen=True)
class VariableField:
    key: str
    label: Mapping[str, str]
    hint: str = ""


@dataclass(frozen=True)
class TemplateCopy:
    """Everything one template prints in one language."""

    builder_id: str
    salutation: str
    intro: tuple[str, ...]  # locked paragraphs; may contain {equipment} / {system}
    table_title: str
    terms_title: str  # the builder's fixed "marker" heading above the conditions
    closing: tuple[str, ...]
    signoff: str
    subject: str  # default subject pattern, uses {equipment}
    columns: tuple[Column, ...]
    terms: tuple[TermDefault, ...]
    price_units: tuple[str, ...]
    default_price_unit: str
    scope: tuple[str, ...] = ()  # locked standard scope (annual maintenance)
    exclusions: tuple[str, ...] = ()
    total_label: str | None = None  # grand-total row label; None = the template has no total row
    extra_price_columns: tuple[Column, ...] = ()  # shown only once a row carries a price


@dataclass(frozen=True)
class TemplateSpec:
    key: str
    label: Mapping[str, str]
    languages: tuple[str, ...]
    applies_to: Mapping[str, tuple[str, ...]]  # service_families / work_types / request_kinds
    builder_type: str
    layout: str  # "letter" (Tenders cover letter) | "purpose" (paginated purpose template)
    copy: Mapping[str, TemplateCopy]
    variables: tuple[VariableField, ...] = ()
    show_total: bool = True

    @property
    def builder_ids(self) -> dict[str, str]:
        return {lang: c.builder_id for lang, c in self.copy.items()}

    def resolve_language(self, language: str | None) -> str:
        """The requested language when the template has it, otherwise English."""
        lang = (language or "en").strip().lower()[:2]
        return lang if lang in self.languages else "en"

    def text(self, language: str | None) -> TemplateCopy:
        return self.copy[self.resolve_language(language)]

    def to_dict(self) -> dict[str, Any]:
        """JSON-friendly description for the API / UI."""
        return {
            "key": self.key,
            "label": dict(self.label),
            "languages": list(self.languages),
            "applies_to": {k: list(v) for k, v in self.applies_to.items()},
            "builder_type": self.builder_type,
            "builder_ids": self.builder_ids,
            "layout": self.layout,
            "show_total": self.show_total,
            "variables": [{"key": v.key, "label": dict(v.label), "hint": v.hint} for v in self.variables],
            "copy": {
                lang: {
                    "salutation": c.salutation,
                    "intro": list(c.intro),
                    "table_title": c.table_title,
                    "terms_title": c.terms_title,
                    "scope": list(c.scope),
                    "closing": list(c.closing),
                    "signoff": c.signoff,
                    "subject": c.subject,
                    "columns": [{"key": col.key, "label": col.label} for col in c.columns],
                    "terms": [{"key": t.key, "label": t.label, "text": t.text} for t in c.terms],
                    "exclusions": list(c.exclusions),
                    "price_units": list(c.price_units),
                    "default_price_unit": c.default_price_unit,
                    "total_label": c.total_label,
                }
                for lang, c in self.copy.items()
            },
        }


# --------------------------------------------------------------------------------------------
# Shared wording (app/quotation.js COPY, app/letter.html)
# --------------------------------------------------------------------------------------------
_DEAR_EN = "Dear Sir,"
_DEAR_AR = "تحية طيبة وبعد،"
_CLOSING_EN = ("We hope you will find our offer satisfactory.",)
_CLOSING_AR = ("آملين أن يحوز عرضنا على رضاكم.",)
_SIGNOFF_EN = "Best Regards,"
_SIGNOFF_AR = "وتفضلوا بقبول فائق الاحترام،"

_NO_EN = Column("no", "No.", 0.45)
_NO_AR = Column("no", "م", 0.45)

# The original Tenders cover letter (app/letter.html), word for word.
TENDERS_PARAGRAPHS = (
    "Please find attached our quotation for the {equipment}, prepared in accordance with your "
    "tender requirements and specifications.",
    "We have taken care to ensure that our pricing is both competitive and reflective of the "
    "quality and reliability of the equipment and services offered. We hope our prices are "
    "satisfactory for your kind approval.",
    "Our team has extensive experience in the supply, installation, and maintenance of {system}, "
    "and we are confident in our ability to meet your project's technical and operational "
    "requirements. Should you require any further information, clarification, or supporting "
    "documentation, we would be pleased to provide it at your earliest convenience.",
    "We look forward to the opportunity of working with you and remain available to discuss any "
    "aspect of this quotation in further detail.",
    "Thank you for considering our proposal.",
)

_ALL_FAMILIES = ("bmu", "wce", "cradle", "hoist", "crane", "access_rental", "scaffolding",
                 "space_frame", "other_work")

TEMPLATES: dict[str, TemplateSpec] = {
    "tenders": TemplateSpec(
        key="tenders",
        label={"en": "Tenders", "ar": "مناقصات"},
        languages=("en",),  # the builder has no Arabic Tenders source letter
        applies_to={
            "request_kinds": ("tender_rfq",),
            "work_types": ("supply_installation", "annual_maintenance", "service_repair",
                           "equipment_rental", "inspection_certification"),
            "service_families": _ALL_FAMILIES,
        },
        builder_type="tenders",
        layout="letter",
        show_total=True,
        variables=(
            VariableField("equipment", {"en": "Equipment (body, full name)", "ar": "المعدات"},
                          'Reads: "our quotation for the ___, prepared in accordance…"'),
            VariableField("system", {"en": "System (body, short name)", "ar": "النظام"},
                          'Reads: "supply, installation, and maintenance of ___"'),
        ),
        copy={
            "en": TemplateCopy(
                builder_id="tenders",
                salutation=_DEAR_EN,
                intro=TENDERS_PARAGRAPHS,
                table_title="Schedule of Prices",
                terms_title="Terms and Conditions",
                closing=(),
                signoff="Yours faithfully,",
                subject="Quotation for {equipment}.",
                columns=(
                    _NO_EN,
                    Column("description", "Description", 2.6),
                    Column("qty", "Qty.", 0.6),
                    Column("unit", "Unit", 0.6),
                    Column("unit_price", "Unit price ({currency})", 1.05, priced=True),
                    Column("total", "Total ({currency})", 1.05, priced=True),
                ),
                terms=(
                    TermDefault("delivery", "Delivery / installation", "To be agreed."),
                    TermDefault("payment", "Payment", "To be agreed."),
                    TermDefault("warranty", "Warranty"),
                    TermDefault("validity", "Validity", "One month."),
                ),
                exclusions=("Civil works and main electrical supply.",),
                price_units=PRICE_UNITS["en"],
                default_price_unit="Each",
                total_label="Total ({currency})",
            ),
        },
    ),
    "equipment_rental": TemplateSpec(
        key="equipment_rental",
        label={"en": "Equipment Rental", "ar": "تأجير معدات"},
        languages=("en", "ar"),
        applies_to={
            "work_types": ("equipment_rental",),
            "service_families": ("access_rental",),
            "request_kinds": ("direct_rfq",),
        },
        builder_type="equipment-rental",
        layout="purpose",
        show_total=False,  # rental rates per period: no grand total
        variables=(VariableField("equipment", {"en": "Equipment", "ar": "المعدات"}, "Used in the default subject."),),
        copy={
            "en": TemplateCopy(
                builder_id="rental-en",
                salutation=_DEAR_EN,
                intro=("Reference made to your inquiry for rental equipment, we are pleased to quote our "
                       "best rental rates as follows:",),
                table_title="Equipment and rental rates",
                terms_title="Rental Charge Conditions",
                closing=_CLOSING_EN,
                signoff=_SIGNOFF_EN,
                subject="Rental quotation for {equipment}",
                columns=(
                    _NO_EN,
                    Column("description", "Equipment", 2),
                    Column("spec", "Model / height / capacity", 2),
                    Column("qty", "Qty.", 1),
                    Column("unit_price", "Rate ({currency})", 1, priced=True),
                    Column("price_unit", "Rate unit", 1),
                ),
                terms=(
                    TermDefault("minimum_period", "Minimum rental period", "One month"),
                    TermDefault("transportation", "Transportation"),
                    TermDefault("operator", "Operator"),
                    TermDefault("delivery", "Delivery", "To be agreed."),
                    TermDefault("payment", "Payment", "Cash in advance."),
                    TermDefault("validity", "Validity", "One month."),
                ),
                price_units=PRICE_UNITS["en"][1:],
                default_price_unit="Month",
            ),
            "ar": TemplateCopy(
                builder_id="rental-ar",
                salutation=_DEAR_AR,
                intro=("بالإشارة إلى طلبكم لتأجير المعدات، يسرنا أن نقدم لكم أفضل أسعارنا حسب التفاصيل التالية:",),
                table_title="المعدات وأسعار التأجير",
                terms_title="شروط أسعار التأجير",
                closing=_CLOSING_AR,
                signoff=_SIGNOFF_AR,
                subject="عرض تأجير {equipment}",
                columns=(
                    _NO_AR,
                    Column("description", "المعدة", 2),
                    Column("spec", "الموديل / الارتفاع / الحمولة", 2),
                    Column("qty", "الكمية", 1),
                    Column("unit_price", "السعر ({currency})", 1, priced=True),
                    Column("price_unit", "وحدة السعر", 1),
                ),
                terms=(
                    TermDefault("minimum_period", "أقل مدة للإيجار", "شهر واحد"),
                    TermDefault("transportation", "النقل"),
                    TermDefault("operator", "المشغل"),
                    TermDefault("delivery", "التسليم", "حسب الاتفاق"),
                    TermDefault("payment", "الدفع", "مقدماً"),
                    TermDefault("validity", "صلاحية العرض", "شهر واحد"),
                ),
                price_units=PRICE_UNITS["ar"][1:],
                default_price_unit="شهري",
            ),
        },
    ),
    "annual_maintenance": TemplateSpec(
        key="annual_maintenance",
        label={"en": "Annual Maintenance", "ar": "صيانة سنوية"},
        languages=("en", "ar"),
        applies_to={
            "work_types": ("annual_maintenance",),
            "request_kinds": ("o_and_m",),
            "service_families": ("bmu", "wce", "cradle", "hoist", "crane"),
        },
        builder_type="annual-maintenance",
        layout="purpose",
        show_total=False,  # the contract value is a term the engineer fills
        variables=(VariableField("equipment", {"en": "Equipment", "ar": "المعدات"}, "Used in the default subject."),),
        copy={
            "en": TemplateCopy(
                builder_id="maintenance-en",
                salutation=_DEAR_EN,
                intro=("Kindly find below our offer for the annual maintenance contract at the "
                       "above-mentioned project:",),
                table_title="Equipment maintenance details",
                terms_title="Preventive Maintenance Scope",
                scope=(
                    "Operating and overall checking.",
                    "Hoist and control-panel maintenance.",
                    "Oiling and greasing.",
                    "Loading and testing.",
                    "Checking electrical connections and controls.",
                ),
                closing=_CLOSING_EN,
                signoff=_SIGNOFF_EN,
                subject="Annual maintenance of {equipment}",
                columns=(_NO_EN, Column("description", "Equipment", 2), Column("qty", "Qty.", 1)),
                extra_price_columns=(
                    Column("unit_price", "Unit price ({currency})", 1, priced=True),
                    Column("total", "Total ({currency})", 1, priced=True),
                ),
                terms=(
                    TermDefault("visits", "Scheduled visits", "12 visits — one visit per month"),
                    TermDefault("contract_period", "Contract period", "One year"),
                    TermDefault("contract_value", "Contract value ({currency})"),
                    TermDefault("payment", "Payment", "50% advance and 50% after six months."),
                    TermDefault("spare_parts", "Spare parts", "Excluded — quoted separately"),
                    TermDefault("validity", "Validity", "One month."),
                ),
                price_units=PRICE_UNITS["en"],
                default_price_unit="Each",
                total_label="Contract value ({currency})",
            ),
            "ar": TemplateCopy(
                builder_id="maintenance-ar",
                salutation=_DEAR_AR,
                intro=("يسرنا أن نقدم لكم عرضنا لعقد الصيانة السنوية للمعدات في المشروع المذكور أعلاه "
                       "وفقاً للتفاصيل التالية:",),
                table_title="تفاصيل المعدات المشمولة بالصيانة",
                terms_title="نطاق الصيانة الوقائية",
                scope=(
                    "التشغيل والفحص العام.",
                    "صيانة الرافعات ولوحات التحكم.",
                    "التزييت والتشحيم.",
                    "اختبار التشغيل والحمولة.",
                    "فحص التوصيلات الكهربائية وأنظمة التحكم.",
                ),
                closing=_CLOSING_AR,
                signoff=_SIGNOFF_AR,
                subject="عقد الصيانة السنوية – {equipment}",
                columns=(_NO_AR, Column("description", "المعدة", 2), Column("qty", "الكمية", 1)),
                extra_price_columns=(
                    Column("unit_price", "سعر الوحدة ({currency})", 1, priced=True),
                    Column("total", "الإجمالي ({currency})", 1, priced=True),
                ),
                terms=(
                    TermDefault("visits", "الزيارات الدورية", "12 زيارة — زيارة شهرية"),
                    TermDefault("contract_period", "مدة العقد", "سنة واحدة"),
                    TermDefault("contract_value", "قيمة العقد ({currency})"),
                    TermDefault("payment", "الدفع", "50% مقدماً و50% بعد ستة أشهر"),
                    TermDefault("spare_parts", "قطع الغيار", "غير مشمولة — تسعّر منفصلة"),
                    TermDefault("validity", "صلاحية العرض", "شهر واحد"),
                ),
                price_units=PRICE_UNITS["ar"],
                default_price_unit="للوحدة",
                total_label="قيمة العقد ({currency})",
            ),
        },
    ),
    "supply_installation": TemplateSpec(
        key="supply_installation",
        label={"en": "Supply & Installation", "ar": "توريد وتركيب"},
        languages=("en", "ar"),
        applies_to={
            "work_types": ("supply_installation",),
            "request_kinds": ("direct_rfq", "revision", "info_request"),
            "service_families": ("bmu", "wce", "cradle", "hoist", "crane", "scaffolding",
                                 "space_frame", "other_work"),
        },
        builder_type="supply-install",
        layout="purpose",
        show_total=True,
        variables=(VariableField("equipment", {"en": "Equipment", "ar": "المعدات"}, "Used in the default subject."),),
        copy={
            "en": TemplateCopy(
                builder_id="supply-en",
                salutation=_DEAR_EN,
                intro=("Reference made to your inquiry, we are pleased to quote our best price for the "
                       "supply and installation works detailed below:",),
                table_title="Items, specifications and prices",
                terms_title="Supply and Installation Terms",
                closing=_CLOSING_EN,
                signoff=_SIGNOFF_EN,
                subject="Supply and installation of {equipment}",
                columns=(  # seven columns: give the prices room so 12,500.000 never wraps
                    Column("no", "No.", 0.4),
                    Column("description", "Item / work", 2),
                    Column("qty", "Qty.", 1),
                    Column("unit_price", "Unit price ({currency})", 1.15, priced=True),
                    Column("price_unit", "Price unit", 1),
                    Column("total", "Total ({currency})", 1.15, priced=True),
                    Column("spec", "Specification", 1.9),
                ),
                terms=(
                    TermDefault("delivery", "Delivery / installation", "To be agreed."),
                    TermDefault("payment", "Payment", "To be agreed."),
                    TermDefault("warranty", "Warranty"),
                    TermDefault("validity", "Validity", "One month."),
                ),
                exclusions=("Civil works and main electrical supply.",),
                price_units=PRICE_UNITS["en"],
                default_price_unit="Each",
                total_label="Total ({currency})",
            ),
            "ar": TemplateCopy(
                builder_id="supply-ar",
                salutation=_DEAR_AR,
                intro=("بالإشارة إلى طلبكم، يسرنا أن نقدم لكم أفضل أسعارنا لأعمال التوريد والتركيب الموضحة أدناه:",),
                table_title="البنود والمواصفات والأسعار",
                terms_title="شروط التوريد والتركيب",
                closing=_CLOSING_AR,
                signoff=_SIGNOFF_AR,
                subject="عرض توريد وتركيب {equipment}",
                columns=(
                    Column("no", "م", 0.4),
                    Column("description", "البند / الأعمال", 2),
                    Column("qty", "الكمية", 1),
                    Column("unit_price", "سعر الوحدة ({currency})", 1.15, priced=True),
                    Column("price_unit", "الوحدة", 1),
                    Column("total", "الإجمالي ({currency})", 1.15, priced=True),
                    Column("spec", "المواصفات", 1.9),
                ),
                terms=(
                    TermDefault("delivery", "التوريد / التركيب", "حسب الاتفاق"),
                    TermDefault("payment", "الدفع", "حسب الاتفاق"),
                    TermDefault("warranty", "الضمان"),
                    TermDefault("validity", "صلاحية العرض", "شهر واحد"),
                ),
                exclusions=("الأعمال المدنية والكهرباء الرئيسية",),
                price_units=PRICE_UNITS["ar"],
                default_price_unit="للوحدة",
                total_label="الإجمالي ({currency})",
            ),
        },
    ),
    "service_repair": TemplateSpec(
        key="service_repair",
        label={"en": "Service & Repair", "ar": "خدمة وإصلاح"},
        languages=("en", "ar"),
        applies_to={
            "work_types": ("service_repair", "inspection_certification"),
            "request_kinds": ("direct_rfq",),
            "service_families": ("bmu", "wce", "cradle", "hoist", "crane", "scaffolding"),
        },
        builder_type="inspection-repair",
        layout="purpose",
        show_total=True,
        variables=(VariableField("equipment", {"en": "Equipment", "ar": "المعدات"}, "Used in the default subject."),),
        copy={
            "en": TemplateCopy(
                builder_id="service-en",
                salutation=_DEAR_EN,
                intro=("Reference made to your inquiry and our inspection where applicable, we are pleased "
                       "to quote our best price for the following scope:",),
                table_title="Scope, parts and prices",
                terms_title="Service Offer Conditions",
                closing=_CLOSING_EN,
                signoff=_SIGNOFF_EN,
                subject="Service and repair of {equipment}",
                columns=(
                    _NO_EN,
                    Column("description", "Scope / part", 2),
                    Column("qty", "Qty.", 1),
                    Column("unit_price", "Unit price ({currency})", 1, priced=True),
                    Column("price_unit", "Price unit", 1),
                    Column("total", "Total ({currency})", 1, priced=True),
                ),
                terms=(
                    TermDefault("service_kind", "Service type", "Repair"),
                    TermDefault("visits", "Visits / frequency"),
                    TermDefault("delivery", "Completion / delivery", "To be agreed."),
                    TermDefault("payment", "Payment", "Cash in advance."),
                    TermDefault("validity", "Validity", "One month."),
                ),
                price_units=PRICE_UNITS["en"],
                default_price_unit="Each",
                total_label="Offer total ({currency})",
            ),
            "ar": TemplateCopy(
                builder_id="service-ar",
                salutation=_DEAR_AR,
                intro=("بالإشارة إلى طلبكم ومعاينتنا عند انطباقها، يسرنا أن نقدم لكم أفضل أسعارنا لنطاق الأعمال التالي:",),
                table_title="الأعمال وقطع الغيار والأسعار",
                terms_title="شروط عرض الخدمة",
                closing=_CLOSING_AR,
                signoff=_SIGNOFF_AR,
                subject="عرض خدمة وإصلاح {equipment}",
                columns=(
                    _NO_AR,
                    Column("description", "الأعمال / قطع الغيار", 2),
                    Column("qty", "الكمية", 1),
                    Column("unit_price", "سعر الوحدة ({currency})", 1, priced=True),
                    Column("price_unit", "الوحدة", 1),
                    Column("total", "الإجمالي ({currency})", 1, priced=True),
                ),
                terms=(
                    TermDefault("service_kind", "نوع الخدمة", "إصلاح"),
                    TermDefault("visits", "الزيارات / التكرار"),
                    TermDefault("delivery", "التنفيذ / التسليم", "حسب الاتفاق"),
                    TermDefault("payment", "الدفع", "مقدماً"),
                    TermDefault("validity", "صلاحية العرض", "شهر واحد"),
                ),
                price_units=PRICE_UNITS["ar"],
                default_price_unit="للوحدة",
                total_label="إجمالي العرض ({currency})",
            ),
        },
    ),
}

# Service-family names used in default subjects ("equipment") and in the Tenders body ("system").
SERVICE_FAMILY_LABELS: dict[str, dict[str, str]] = {
    "bmu": {"en": "BMU (Building Maintenance Unit) System", "ar": "وحدات صيانة المباني (BMU)",
            "system": "BMU systems"},
    "wce": {"en": "Window Cleaning Equipment", "ar": "معدات تنظيف الواجهات",
            "system": "window cleaning systems"},
    "cradle": {"en": "Suspended Platforms (Cradles)", "ar": "المنصات المعلقة",
               "system": "suspended platform systems"},
    "hoist": {"en": "Construction Hoists", "ar": "المصاعد الإنشائية", "system": "construction hoists"},
    "crane": {"en": "Cranes and Lifting Equipment", "ar": "الرافعات ومعدات الرفع",
              "system": "cranes and lifting equipment"},
    "access_rental": {"en": "Access Equipment", "ar": "معدات الوصول", "system": "access equipment"},
    "scaffolding": {"en": "Scaffolding", "ar": "السقالات", "system": "scaffolding systems"},
    "space_frame": {"en": "Space Frame and Shade Structures", "ar": "الهياكل الفراغية والمظلات",
                    "system": "space frame structures"},
    "other_work": {"en": "Requested Works", "ar": "الأعمال المطلوبة", "system": "such works"},
}

_SERVICE_KIND_FROM_WORK_TYPE = {
    "inspection_certification": {"en": "Inspection", "ar": "فحص"},
    "service_repair": {"en": "Repair", "ar": "إصلاح"},
}


# --------------------------------------------------------------------------------------------
# Template choice
# --------------------------------------------------------------------------------------------
def _norm(value: Any) -> str:
    text = str(value or "").strip().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")


_TENDER = re.compile(r"(^|_)tender")
_ANNUAL = re.compile(r"(^|_)(o_and_m|o_m|om|amc|annual|operation_and_maintenance|maintenance_contract|ppm|preventive)(_|$)")
_RENTAL = re.compile(r"(^|_)(rental|rent|hire|hiring|lease|leasing)(_|$)|access_rental")
_SERVICE = re.compile(r"(^|_)(repair|repairs|service|servicing|inspection|inspections|certification|cleaning|"
                      r"breakdown|fault|troubleshooting|overhaul|refurbishment|modification)(_|$)")
_MAINTENANCE = re.compile(r"(^|_)maintenance(_|$)")

_REASONS = {
    "annual_maintenance": "O&M / annual maintenance",
    "equipment_rental": "rental",
    "service_repair": "repair / service / inspection",
}

# docs/snapshot-format.md work types, which name the purpose explicitly.
_WORK_TYPES = {
    "supply_installation": "supply_installation",
    "annual_maintenance": "annual_maintenance",
    "equipment_rental": "equipment_rental",
    "service_repair": "service_repair",
    "inspection_certification": "service_repair",
}


def _purpose_of(value: str) -> str | None:
    if not value:
        return None
    if _ANNUAL.search(value):
        return "annual_maintenance"
    if _RENTAL.search(value):
        return "equipment_rental"
    if _SERVICE.search(value):
        return "service_repair"
    if _MAINTENANCE.search(value):  # plain "maintenance" is quoted as an annual contract
        return "annual_maintenance"
    return None


def choose_template(service_family: str | None, work_type: str | None, request_kind: str | None,
                    language: str | None = "en") -> tuple[str, str]:
    """Pick the official template for a project. Returns ``(template_key, reason)``.

    Rules, in order: a tender RFQ from a contractor -> ``tenders``; O&M / annual maintenance ->
    ``annual_maintenance``; an explicit work type (docs/snapshot-format.md) -> its template;
    otherwise keywords in work type, request kind, then service family: rental ->
    ``equipment_rental``, repair / service / inspection -> ``service_repair``; anything else ->
    ``supply_installation``. When the template lacks the requested language the reason says
    English is used (``TemplateSpec.resolve_language`` gives the language to render).
    """
    sf, wt, rk = _norm(service_family), _norm(work_type), _norm(request_kind)
    key: str | None = None
    reason = ""
    if _TENDER.search(rk):
        key, reason = "tenders", f"Tender RFQ from a contractor (request kind '{request_kind}')"
    elif rk == "o_and_m" or _ANNUAL.search(rk) or _purpose_of(wt) == "annual_maintenance":
        field_name, raw = ("work type", work_type) if _purpose_of(wt) == "annual_maintenance" else ("request kind", request_kind)
        key, reason = "annual_maintenance", f"O&M / annual maintenance ({field_name} '{raw}')"
    elif wt in _WORK_TYPES:
        key, reason = _WORK_TYPES[wt], f"Work type '{work_type}'"
    else:
        for field_name, value, raw in (("work type", wt, work_type), ("request kind", rk, request_kind),
                                       ("service family", sf, service_family)):
            purpose = _purpose_of(value)
            if purpose:
                key, reason = purpose, f"{_REASONS[purpose].capitalize()} ({field_name} '{raw}')"
                break
    if key is None:
        key = "supply_installation"
        reason = "No tender, maintenance, rental or repair signal"
    spec = TEMPLATES[key]
    wanted = (language or "en").strip().lower()[:2]
    reason += f" → {spec.label['en']}"
    if wanted not in spec.languages:
        reason += f"; {spec.label['en']} has no '{wanted}' version, using English"
    return key, reason


# --------------------------------------------------------------------------------------------
# Default (pre-filled) quotation
# --------------------------------------------------------------------------------------------
def _first(*values: Any) -> Any:
    for value in values:
        if value not in (None, "", [], {}):
            return value
    return None


def _get(obj: Any, *path: str) -> Any:
    for part in path:
        if not isinstance(obj, Mapping):
            return None
        obj = obj.get(part)
    return obj


def fill_placeholders(text: str, values: Mapping[str, Any]) -> str:
    """Replace ``{name}`` placeholders without ``str.format`` (user text may contain braces)."""
    return re.sub(r"\{(\w+)\}", lambda m: str(values.get(m.group(1), m.group(0)) or ""), text)


def currency_label(currency: str | None, language: str) -> str:
    code = (currency or "KWD").strip().upper()
    if language == "ar":
        return {"KWD": "د.ك", "KD": "د.ك", "SAR": "ر.س", "AED": "د.إ", "QAR": "ر.ق", "BHD": "د.ب",
                "OMR": "ر.ع", "USD": "دولار", "EUR": "يورو"}.get(code, code)
    return code


def default_quotation(template_key: str, language: str | None, project: Mapping[str, Any] | None,
                      enquiry: Mapping[str, Any] | None, signatory: Mapping[str, Any] | None, *,
                      existing_refs: Iterable[str] | None = None, today: date | None = None,
                      currency: str | None = None) -> dict[str, Any]:
    """A draft quotation pre-filled from the template: subject, terms, exclusions, items.

    ``project`` / ``enquiry`` follow docs/snapshot-format.md. Item prices are always ``None``
    (AI never fills prices). ``reference`` is computed only when ``existing_refs`` is given.
    """
    if template_key not in TEMPLATES:
        raise KeyError(f"Unknown quotation template: {template_key!r}")
    spec = TEMPLATES[template_key]
    lang = spec.resolve_language(language)
    copy = spec.copy[lang]
    project = project or {}
    enquiry = enquiry or {}
    signatory = signatory or {}
    today = today or date.today()
    currency = (currency or _first(project.get("currency"), enquiry.get("currency")) or "KWD").upper()
    cur = currency_label(currency, lang)

    family = _norm(project.get("service_family")) or "other_work"
    names = SERVICE_FAMILY_LABELS.get(family, SERVICE_FAMILY_LABELS["other_work"])
    variables = {"equipment": names[lang] if lang in names else names["en"], "system": names["system"]}

    customer = _first(enquiry.get("customer"), project.get("customer")) or {}
    if isinstance(customer, str):
        customer = {"name": customer}
    contact = _first(enquiry.get("contact"), _get(customer, "contacts")) or {}
    if isinstance(contact, list):
        contact = contact[0] if contact else {}
    if not isinstance(contact, Mapping):
        contact = {"name": str(contact)}
    attention = _first(contact.get("name"))
    if attention and contact.get("title"):
        attention = f"{attention} / {contact['title']}"
    address = _first(customer.get("address"), customer.get("city"))

    items = []
    for index, scope in enumerate(_first(project.get("scope_items"), enquiry.get("scope_items")) or [], 1):
        if not isinstance(scope, Mapping):
            continue
        items.append({
            "no": index,
            "description": scope.get("description") or "",
            "spec": _first(scope.get("spec"), scope.get("specification")),
            "qty": scope.get("qty"),
            "unit": scope.get("unit"),
            "unit_price": None,  # never pre-filled: the engineer prices every row
            "total": None,
        })

    terms = []
    for term in copy.terms:
        text = term.text
        if term.key == "service_kind":
            text = _get(_SERVICE_KIND_FROM_WORK_TYPE, _norm(project.get("work_type")), lang) or text
        terms.append({"key": term.key, "label": fill_placeholders(term.label, {"currency": cur}), "text": text})

    initials = (signatory.get("initials") or "").strip().upper() or None
    reference = None
    if existing_refs is not None and initials:
        reference = next_reference(initials, today.year, existing_refs)

    return {
        "reference": reference,
        "date": today.isoformat(),
        "language": lang,
        "template_key": spec.key,
        "status": "draft",
        "to": {
            "company": _first(customer.get("name"), enquiry.get("customer_name"), enquiry.get("company"),
                              project.get("customer_name")),
            "attention": attention,
            "address": address or None,
            "email": _first(contact.get("email")),
            "phone": _first(contact.get("phone")),
        },
        "project_name": _first(project.get("name"), enquiry.get("project_name")),
        "subject": fill_placeholders(copy.subject, variables),
        "tender_no": _first(project.get("tender_no"), enquiry.get("tender_no")),
        "enquiry_ref": _first(enquiry.get("enquiry_ref"), enquiry.get("rfq_no")),
        "intro": None,
        "variables": variables,
        "items": items,
        "currency": currency,
        "price_unit": copy.default_price_unit,
        "terms": terms,
        "exclusions": list(copy.exclusions),
        "notes": None,
        "show_total": spec.show_total,
        "stamp": {"show": True},
        "signatory_initials": initials,
    }
