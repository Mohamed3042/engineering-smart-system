"""Render official quotations: HTML (Jinja2, self-contained) and A4 PDF (Chromium).

The layout reproduces the Medmack Quotation Builder v1.5.0: letterhead header and footer, the
faint logo watermark and the company stamp on every page; the builder's title block, items
table, conditions grid and closing; the signature once, at the end. Added for the engineer
gate: "Page x of y", a continuation line on later pages, and a diagonal DRAFT mark until the
quotation is approved. Prices are printed exactly as given; ``None`` prints as an empty cell.

    html = render_quotation_html(quotation, workspace, signatory, assets)
    path = await render_quotation_pdf(quotation, workspace, signatory, assets, out_path)
"""
from __future__ import annotations

import base64
import json
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from markupsafe import Markup, escape

from .assets import SPECIMEN_NOTE, LetterheadAssets
from .photos import normalize_photo, normalize_placement
from .templates import (
    TEMPLATES,
    Column,
    TemplateCopy,
    TemplateSpec,
    currency_label,
    default_quotation,
    fill_placeholders,
)

__all__ = ["render_quotation_html", "render_quotation_pdf", "default_quotation", "FINAL_STATUSES"]

HERE = Path(__file__).resolve().parent
HTML_DIR = HERE / "html"
FONT_DIR = HERE / "fonts"

# Statuses that mean an engineer approved the document: no DRAFT mark.
FINAL_STATUSES = frozenset({"approved", "sent"})

_ARABIC = re.compile(r"[\u0600-\u06FF\u0750-\u077F\u0870-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]")
_ARABIC_RANGE = "U+0600-06FF, U+0750-077F, U+0870-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200F"
_FONT_SENTINEL = "/*ess-fonts*/"
_THREE_DECIMALS = {"KWD", "KD", "BHD", "OMR", "JOD", "IQD", "LYD", "TND"}
_NUMERIC_COLUMNS = {"no", "qty", "unit_price", "total"}
_OFFLINE_ARGS = ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability",
                 "--disable-sync", "--no-pings", "--disable-features=OptimizationHints,MediaRouter,Translate"]

LATIN_FONTS = '"ESS Arabic", "Times New Roman", Tinos, "Liberation Serif", Times, serif'
RTL_FONTS = '"ESS Arabic", Arial, "Liberation Sans", Arimo, Helvetica, sans-serif'

LABELS: dict[str, dict[str, str]] = {
    "en": {
        "to": "To", "attn": "Attn.", "project": "Project", "date": "Date", "ref": "Ref.", "from": "From",
        "tender_no": "Tender No.", "your_ref": "Your Ref.", "subject": "Subject: ",
        "letter_date": "Date :", "letter_ref": "Ref. :", "letter_your_ref": "Your Ref. :",
        "letter_project": "Project Name : ", "letter_tender": "Tender No. : ",
        "exclusions": "Exclusions", "notes": "Notes:", "page": "Page", "of": "of",
        "continued": "continued", "quotation": "Quotation", "email": "Email:", "phone": "Tel:",
        "annex": "Product Reference Annex", "photo": "Product reference", "included": "Included",
    },
    "ar": {
        "to": "السادة", "attn": "عناية", "project": "المشروع", "date": "التاريخ", "ref": "المرجع", "from": "من",
        "tender_no": "رقم المناقصة", "your_ref": "مرجعكم", "subject": "الموضوع: ",
        "letter_date": "التاريخ :", "letter_ref": "المرجع :", "letter_your_ref": "مرجعكم :",
        "letter_project": "المشروع : ", "letter_tender": "رقم المناقصة : ",
        "exclusions": "الاستثناءات", "notes": "ملاحظات:", "page": "صفحة", "of": "من",
        "continued": "تابع", "quotation": "عرض سعر", "email": "البريد الإلكتروني:", "phone": "هاتف:",
        "annex": "ملحق الصور المرجعية للمنتج", "photo": "صورة مرجعية", "included": "مشمول",
    },
}


# --------------------------------------------------------------------------------------------
# Formatting
# --------------------------------------------------------------------------------------------
def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _number(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(repr(value))
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "")
        if re.fullmatch(r"[-+]?\d+(\.\d+)?", cleaned):
            try:
                return Decimal(cleaned)
            except InvalidOperation:
                return None
    return None


def format_amount(value: Any, currency: str) -> str:
    """Engineer-entered price as printed: grouped, 3 decimals for KWD; ``None`` -> ``""``."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return ""
    number = _number(value)
    if number is None:  # "Included", "N/A", ...
        return _text(value)
    places = 3 if currency.upper() in _THREE_DECIMALS else 2
    return f"{number:,.{places}f}"


def format_qty(value: Any) -> str:
    number = _number(value)
    if number is None:
        return _text(value)
    if number == number.to_integral_value():
        return f"{int(number):,}"
    return f"{number.normalize():f}"


def format_date(value: Any) -> str:
    """``2026-10-01`` -> ``01/10/2026`` (the builder's day/month/year)."""
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    text = _text(value)
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    return f"{match.group(3)}/{match.group(2)}/{match.group(1)}" if match else text


def _paragraphs(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [t for t in (_text(v) for v in value) if t]
    return [p.strip() for p in re.split(r"\n\s*\n", str(value)) if p.strip()]


def _lines(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = value.splitlines()
    return [t for t in (_text(v).lstrip("•-– ").strip() for v in value) if t]


def _breakable_number(text: str) -> Markup:
    """A number may wrap only after a thousands separator, never mid-digits (narrow columns)."""
    return Markup(str(escape(text)).replace(",", ",<wbr>"))


def _equipment_from_subject(subject: str) -> str:
    text = re.sub(r"^\s*(?:quotation|offer|proposal|price)\s+for\s+(?:the\s+)?", "", subject, flags=re.I)
    return text.strip().rstrip(".").strip()


# --------------------------------------------------------------------------------------------
# Assets that ship with the code
# --------------------------------------------------------------------------------------------
@lru_cache(maxsize=None)
def _static(name: str) -> str:
    return (HTML_DIR / name).read_text(encoding="utf-8")


@lru_cache(maxsize=None)
def _font_css() -> str:
    """IBM Plex Sans Arabic (OFL), embedded. Chosen over Noto Naskh Arabic because Chromium keeps
    a correct PDF text layer with it (Noto Naskh 2.x composes letters from dotless skeletons plus
    dot glyphs, which come out of the PDF as NULs: Arabic could not be searched or copied)."""
    faces = []
    for weight, filename in ((400, "IBMPlexSansArabic-Regular.woff2"), (700, "IBMPlexSansArabic-Bold.woff2")):
        data = base64.b64encode((FONT_DIR / filename).read_bytes()).decode("ascii")
        faces.append(
            '@font-face{font-family:"ESS Arabic";'
            f'src:url(data:font/woff2;base64,{data}) format("woff2");'
            # Plex Arabic runs ~12% wider than the builder's Geeza Pro / Arial Arabic at the same size.
            f"font-weight:{weight};font-style:normal;font-display:block;size-adjust:88%;"
            f"unicode-range:{_ARABIC_RANGE}}}"
        )
    return "\n".join(faces)


@lru_cache(maxsize=None)
def _environment() -> Environment:
    return Environment(loader=FileSystemLoader(str(HTML_DIR)), autoescape=True, undefined=StrictUndefined)


def _mm(value: float) -> str:
    return f"{round(float(value), 2):g}mm"


def _root_css(assets: LetterheadAssets) -> Markup:
    g = assets.geometry
    paper = assets.paper if re.fullmatch(r"#[0-9A-F]{6}", assets.paper) else "#FFFFFF"
    white = paper in {"#FFFFFF", "#FEFEFE", "#FDFDFD"}
    opacity = g["watermark"]["opacity"]
    variables = {
        "--paper": paper,
        "--table-bg": "transparent" if white else "rgba(255, 254, 223, .8)",
        "--latin": LATIN_FONTS,
        "--rtl": RTL_FONTS,
        "--rtl-size": "10.4pt",
        "--head-left": _mm(g["header"]["left_mm"]),
        "--head-top": _mm(g["header"]["top_mm"]),
        "--head-width": _mm(g["header"]["width_mm"]),
        "--head-height": _mm(assets.header_height_mm),
        "--foot-left": _mm(g["footer"]["left_mm"]),
        "--foot-bottom": _mm(g["footer"]["bottom_mm"]),
        "--foot-width": _mm(g["footer"]["width_mm"]),
        "--foot-height": _mm(assets.footer_height_mm),
        "--wm-left": _mm(g["watermark"]["left_mm"]),
        "--wm-top": _mm(g["watermark"]["top_mm"]),
        "--wm-width": _mm(g["watermark"]["width_mm"]),
        "--wm-opacity": f"{opacity:g}",
        "--wm-opacity-letter": f"{min(1.0, opacity * 0.085 / 0.07):.3f}",
        "--content-top": _mm(assets.content_top_mm),
        "--content-bottom": _mm(assets.content_bottom_mm),
        "--letter-top": _mm(assets.content_top_mm + 3),
        "--letter-bottom": _mm(assets.content_bottom_mm + 9),
        "--pageno-top": _mm(assets.footer_top_mm - 4.2),
    }
    body = "\n".join(f"  {name}: {value};" for name, value in variables.items())
    if "<" in body:  # values are generated here; never let markup into the stylesheet
        raise ValueError("invalid CSS value")
    return Markup(":root {\n" + body + "\n}")


# --------------------------------------------------------------------------------------------
# Context
# --------------------------------------------------------------------------------------------
def _resolve(quotation: Mapping[str, Any]) -> tuple[TemplateSpec, str, TemplateCopy]:
    key = quotation.get("template_key")
    if key not in TEMPLATES:
        raise ValueError(f"Unknown quotation template_key: {key!r} (expected one of {sorted(TEMPLATES)})")
    spec = TEMPLATES[key]
    lang = spec.resolve_language(quotation.get("language"))
    return spec, lang, spec.copy[lang]


def _columns(copy: TemplateCopy, items: list[Mapping[str, Any]]) -> list[Column]:
    columns = list(copy.columns)
    if copy.extra_price_columns and any(
        _text(item.get("unit_price")) or _text(item.get("total")) for item in items
    ):
        columns += list(copy.extra_price_columns)
    return columns


def _table(copy: TemplateCopy, spec: TemplateSpec, quotation: Mapping[str, Any], cur: str,
           labels: Mapping[str, str]) -> dict[str, Any] | None:
    items = [item for item in (quotation.get("items") or []) if isinstance(item, Mapping)]
    currency = _text(quotation.get("currency")) or "KWD"
    columns = _columns(copy, items)
    keys = [c.key for c in columns]
    total_weight = sum(c.weight for c in columns)
    default_unit = _text(quotation.get("price_unit"))

    rows = []
    for index, item in enumerate(items, 1):
        description = _text(item.get("description"))
        spec_text = _text(item.get("spec") or item.get("specification"))
        unit = _text(item.get("unit"))
        qty = format_qty(item.get("qty"))
        if "unit" not in keys and unit and qty:
            qty = f"{qty} {unit}"
        included = bool(item.get("included"))  # priced inside another row ("Included")
        values = {
            "no": _text(item.get("no")) or str(index),
            "description": description,
            "spec": spec_text,
            "qty": qty,
            "unit": unit,
            "unit_price": format_amount(item.get("unit_price"), currency) or (labels["included"] if included else ""),
            "price_unit": _text(item.get("price_unit")) or default_unit,
            "total": format_amount(item.get("total"), currency) or (labels["included"] if included else ""),
        }
        row = []
        for col in columns:
            numeric = col.key in _NUMERIC_COLUMNS
            text = values.get(col.key, "")
            row.append({
                "key": col.key,
                "text": _breakable_number(text) if numeric and _number(text) is not None else text,
                "sub": spec_text if col.key == "description" and "spec" not in keys else "",
                "bidi": numeric,
            })
        rows.append(row)

    total = None
    if quotation.get("show_total", spec.show_total) and copy.total_label and "total" in keys:
        totals = [_number(item.get("total")) for item in items
                  if not (item.get("included") and _number(item.get("total")) is None)]
        value = ""
        if totals and all(t is not None for t in totals):  # never a partial sum
            value = format_amount(sum(totals, Decimal(0)), currency)
        position = keys.index("total")
        total = {
            "label": fill_placeholders(copy.total_label, {"currency": cur}),
            "value": _breakable_number(value),
            "span": position,
            "after": len(keys) - position - 1,
        }

    if not rows:
        if spec.layout == "letter":
            return None  # a Tenders cover letter without a schedule is the builder's letter as-is
        rows.append([{"key": c.key, "text": "", "sub": "", "bidi": False} for c in columns])  # builder: one blank row
    return {
        "title": copy.table_title,
        "columns": [
            {"key": c.key, "label": fill_placeholders(c.label, {"currency": cur}),
             "width": round(c.weight / total_weight * 100, 3)}
            for c in columns
        ],
        "rows": rows,
        "total": total,
    }


def _conditions(copy: TemplateCopy, spec: TemplateSpec, quotation: Mapping[str, Any], cur: str,
                labels: Mapping[str, str]) -> dict[str, Any]:
    terms = []
    for term in quotation.get("terms") or []:
        if not isinstance(term, Mapping):
            continue
        label = fill_placeholders(_text(term.get("label")), {"currency": cur}).rstrip(":")
        text = _text(term.get("text"))
        if not text:
            continue  # empty terms never print (the builder drops them too)
        terms.append({"label": label, "text": text,
                      "wide": len(text) > 60 or "\n" in text or len(label) > 26})
    exclusions = _lines(quotation.get("exclusions"))
    if exclusions:  # one more conditions row, as the builder prints "Exclusions: …"
        text = exclusions[0] if len(exclusions) == 1 else "\n".join(f"• {line}" for line in exclusions)
        terms.append({"label": labels["exclusions"], "text": text,
                      "wide": len(exclusions) > 1 or len(text) > 60})
    notes = "\n\n".join(_paragraphs(quotation.get("notes")))
    scope = list(copy.scope)
    has_content = bool(scope or terms or notes)
    return {
        "title": copy.terms_title,
        # The purpose templates always print their fixed conditions heading (builder "marker").
        "show_title": spec.layout == "purpose" or bool(terms),
        "scope": scope,
        "terms": terms,
        "exclusions": exclusions,
        "notes": notes,
        "has_content": has_content,
    }


def _stamp_settings(quotation: Mapping[str, Any]) -> Mapping[str, Any]:
    settings = quotation.get("stamp")
    return settings if isinstance(settings, Mapping) else {}


def _fit_stamp(settings: Mapping[str, Any], fallback: Mapping[str, float], aspect: float) -> dict[str, float]:
    """Same limits as the builder's StampControl.fitSingle (A4 printable area above the footer)."""

    def pick(names: tuple[str, ...], default: float) -> float:
        for name in names:
            number = _number(settings.get(name))
            if number is not None:
                return float(number)
        return default

    width = min(max(pick(("width_mm", "width"), fallback["width"]), 18.0), 58.0)
    x = min(max(pick(("x_mm", "x"), fallback["x"]), 6.0), 210.0 - 6.0 - width)
    y = min(max(pick(("y_mm", "y"), fallback["y"]), 6.0), 276.0 - width * aspect)
    return {"x": round(x, 2), "y": round(y, 2), "width": round(width, 2)}


def _stamp(quotation: Mapping[str, Any], assets: LetterheadAssets) -> dict[str, Any] | None:
    """Company stamp settings, as the builder's StampControl (v1.2.1 / v1.3.0)::

        {"show": true,                                   # every page (default)
         "default": {"x_mm": 40, "y_mm": 232, "width_mm": 36},   # placement for all pages
         "pages": {"2": {"show": false}, "3": {"x_mm": 150, "y_mm": 240}}}   # per page

    Every placement is auto-fitted inside the printable area above the footer. A page override
    inherits the document settings, so ``show: false`` + ``pages: {"1": {"show": true}}`` stamps
    page 1 only.
    """
    if assets.stamp is None:
        return None
    settings = _stamp_settings(quotation)
    paper_default = assets.geometry["stamp"]
    base = {"x": paper_default["x_mm"], "y": paper_default["y_mm"], "width": paper_default["width_mm"]}
    document = dict(settings)  # older callers put x / y / width at the top level
    if isinstance(settings.get("default"), Mapping):
        document.update(settings["default"])
    fitted = _fit_stamp(document, base, assets.stamp.aspect)
    show = settings.get("show", True) is not False

    pages: dict[str, dict[str, Any]] = {}
    raw_pages = settings.get("pages")
    if isinstance(raw_pages, Mapping):
        for page, override in raw_pages.items():
            if not re.fullmatch(r"\d{1,3}", str(page).strip()) or not isinstance(override, Mapping):
                continue
            pages[str(int(page))] = {"show": override.get("show", show) is not False,
                                     **_fit_stamp(override, fitted, assets.stamp.aspect)}
    if not show and not any(p["show"] for p in pages.values()):
        return None
    return {"src": assets.stamp.data_uri, **fitted, "hidden": not show,
            "pages_json": json.dumps(pages, separators=(",", ":"))}


def _photos(quotation: Mapping[str, Any], labels: Mapping[str, str]) -> list[dict[str, Any]]:
    """Reference photos, normalised like the builder (JPEG, <= 1600 px). Unreadable -> ValueError."""
    photos = []
    for index, photo in enumerate(quotation.get("photos") or [], 1):
        if not isinstance(photo, Mapping):
            continue
        source = photo.get("data_url") or photo.get("path")
        if not source:
            continue
        image = normalize_photo(source)
        placement = normalize_placement(photo.get("placement"))
        photos.append({
            "src": image.data_uri,
            "caption": _text(photo.get("caption")) or f"{labels['photo']} {index}",
            "aspect": round(image.width / max(1, image.height), 4),
            **placement,
        })
    return photos


def build_context(quotation: Mapping[str, Any], workspace: Mapping[str, Any] | None,
                  signatory: Mapping[str, Any] | None, assets: LetterheadAssets) -> dict[str, Any]:
    """Everything the Jinja templates print (exposed for previews and tests)."""
    spec, lang, copy = _resolve(quotation)
    workspace = workspace or {}
    signatory = signatory or {}
    rtl = lang == "ar"
    labels = LABELS[lang]
    currency = _text(quotation.get("currency")) or "KWD"
    cur = currency_label(currency, lang)
    to = quotation.get("to") if isinstance(quotation.get("to"), Mapping) else {}

    subject = _text(quotation.get("subject"))
    project_name = _text(quotation.get("project_name"))
    reference = _text(quotation.get("reference"))
    variables = {k: _text(v) for k, v in (quotation.get("variables") or {}).items() if _text(v)}
    equipment = (variables.get("equipment") or _equipment_from_subject(subject) or project_name
                 or "equipment and works described below")
    variables.setdefault("equipment", equipment)
    variables.setdefault("system", equipment)
    intro = _paragraphs(quotation.get("intro")) or [fill_placeholders(p, variables) for p in copy.intro]

    initials = _text(signatory.get("initials") or quotation.get("signatory_initials"))
    signature = assets.signature_for(initials)
    name = _text(signatory.get("full_name") or signatory.get("name"))
    title = _text(signatory.get("title"))
    letter_lines = [title, _text(signatory.get("company")), _text(signatory.get("city"))]
    if _text(signatory.get("email")):
        letter_lines.append(f"{labels['email']} {_text(signatory.get('email'))}")
    if _text(signatory.get("phone")):
        letter_lines.append(f"{labels['phone']} {_text(signatory.get('phone'))}")

    status = _text(quotation.get("status")).lower() or "draft"
    company_name = _text(workspace.get("company_name")) or assets.company_name or _text(workspace.get("name"))
    address = _text(to.get("address"))
    company = _text(to.get("company"))
    doc_title = f"{labels['quotation']} {reference}".strip()
    cont_subject = subject or spec.label.get(lang, spec.label["en"])
    stamp = _stamp(quotation, assets)

    return {
        "lang": lang,
        "dir": "rtl" if rtl else "ltr",
        "rtl": rtl,
        "layout": spec.layout,
        "template_key": spec.key,
        "builder_id": copy.builder_id,
        "status": status,
        "title": doc_title + (f" – {subject}" if subject else ""),
        "labels": labels,
        "chrome": {
            "preprinted": assets.preprinted,  # body only: the sheet already carries the letterhead
            "header": assets.header.data_uri if assets.header else None,
            "footer": assets.footer.data_uri if assets.footer else None,
            "watermark": assets.watermark.data_uri if assets.watermark else None,
            "stamp": stamp,
            "company_name": company_name,
            "specimen": SPECIMEN_NOTE,
            "specimen_ar": "نسخة تجريبية – ترويسة الشركة غير مثبتة" if rtl else None,
            "draft": status not in FINAL_STATUSES,
        },
        "meta": {
            "date": format_date(quotation.get("date")),
            "reference": reference,
            "from_name": name,
            "company": company,
            "attention": _text(to.get("attention")),
            "address": address,
            "to_block": "\n".join(p for p in (company, address) if p),
            "project_name": project_name,
            "tender_no": _text(quotation.get("tender_no")),
            "enquiry_ref": _text(quotation.get("enquiry_ref")),
        },
        "subject": subject,
        "salutation": copy.salutation,
        "intro": intro,
        "table": _table(copy, spec, quotation, cur, labels),
        "conditions": _conditions(copy, spec, quotation, cur, labels),
        "closing": {
            "lines": _paragraphs(quotation.get("closing")) or list(copy.closing),
            "signoff": copy.signoff,
            "signature": {
                "src": signature.data_uri if signature else None,
                "name": name,
                "title": title,
                "lines": [line for line in letter_lines if line],
            },
        },
        "pages": {
            "page_word": labels["page"],
            "of_word": labels["of"],
            "cont_prefix": " — ".join(p for p in (cont_subject, reference, labels["continued"]) if p),
            "stamp_pages": stamp["pages_json"] if stamp else "{}",
            "annex_prefix": " — ".join(p for p in (cont_subject, reference) if p),
        },
        "photos": _photos(quotation, labels),
    }


def render_quotation_html(quotation: Mapping[str, Any], workspace: Mapping[str, Any] | None,
                          signatory: Mapping[str, Any] | None, assets: LetterheadAssets) -> str:
    """Self-contained HTML (images and fonts embedded). It paginates itself in the browser."""
    context = build_context(quotation, workspace, signatory, assets)
    html = _environment().get_template("quotation.html.j2").render(
        **context,
        font_css=Markup(_FONT_SENTINEL),
        root_css=_root_css(assets),
        css=Markup(_static("quotation.css")),
        js=Markup(_static("paginate.js")),
    )
    # Embed the Arabic font only when the document contains Arabic text.
    return html.replace(_FONT_SENTINEL, _font_css() if _ARABIC.search(html) else "", 1)


async def render_quotation_pdf(quotation: Mapping[str, Any], workspace: Mapping[str, Any] | None,
                               signatory: Mapping[str, Any] | None, assets: LetterheadAssets,
                               out_path: Path | str, *, browser: Any = None, timeout_ms: int = 60_000) -> Path:
    """Print the quotation to an A4 PDF at ``out_path`` (written atomically) and return the path.

    Rendering is offline: the page has no network access, everything it needs is embedded.
    Pass an open Playwright ``browser`` to reuse it across many renders.
    """
    from playwright.async_api import async_playwright

    from ..chromium import launch_chromium

    html = render_quotation_html(quotation, workspace, signatory, assets)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    async def _print(chromium: Any) -> bytes:
        context = await chromium.new_context(offline=True, viewport={"width": 900, "height": 1200})
        try:
            page = await context.new_page()
            await page.emulate_media(media="print")
            await page.set_content(html, wait_until="load", timeout=timeout_ms)
            await page.wait_for_function("window.__essPaginated === true", timeout=timeout_ms)
            error = await page.evaluate("window.__essError || null")
            if error:
                raise RuntimeError(f"Quotation layout failed: {error}")
            return await page.pdf(
                format="A4",
                print_background=True,
                prefer_css_page_size=True,
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            )
        finally:
            await context.close()

    if browser is not None:
        data = await _print(browser)
    else:
        async with async_playwright() as playwright:
            # Rendering needs no network at all: route the browser's own background traffic
            # (component updates, connectivity checks) into a dead end on this machine.
            chromium = await launch_chromium(playwright, proxy={"server": "http://127.0.0.1:9"}, args=_OFFLINE_ARGS)
            try:
                data = await _print(chromium)
            finally:
                await chromium.close()

    partial = out_path.with_name(out_path.name + ".part")
    partial.write_bytes(data)
    partial.replace(out_path)
    return out_path
