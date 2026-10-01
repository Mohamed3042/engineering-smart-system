"""ess.quotation: templates, numbering, letterhead assets, HTML and PDF rendering.

Private company assets are never used here: the "real" letterhead is generated on the fly.
PDF tests need Chromium (see ess.chromium); they are skipped when no browser is installed.
"""
from __future__ import annotations

import copy
import html as htmllib
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import pypdf
import pytest
from PIL import Image, ImageDraw

from ess.quotation import (
    TEMPLATES,
    LetterheadAssets,
    choose_template,
    default_quotation,
    next_reference,
    parse_reference,
    render_quotation_html,
    render_quotation_pdf,
)
from ess.quotation.templates import TENDERS_PARAGRAPHS, fill_placeholders

REPO_ROOT = Path(__file__).resolve().parents[2]
IMPORT_SCRIPT = REPO_ROOT / "scripts" / "import_letterhead.py"

WORKSPACE = {"company_name": "Example Engineering Co. W.L.L.", "name": "Example"}
SIGNATORY = {"initials": "AA", "full_name": "Sample Signatory", "title": "General Manager",
             "company": "Example Engineering Co.", "city": "Kuwait", "email": "sales@example.com", "phone": None}

# Distinct pixel sizes so the PDF tests can recognise each image.
HEADER_PX, FOOTER_PX, STAMP_PX, WATERMARK_PX, SIGNATURE_PX = (1600, 308), (1600, 206), (300, 291), (150, 138), (280, 185)


def quotation(**overrides):
    base = {
        "reference": "AA/26/0118", "date": "2026-10-01", "language": "en", "template_key": "tenders",
        "status": "draft",
        "to": {"company": "Example Contracting Co.", "attention": "Eng. Sample Person / Tendering",
               "address": "Kuwait.", "email": "tenders@example.com", "phone": None},
        "project_name": "Sample Tower", "subject": "Quotation for BMU Window Cleaning Equipment.",
        "tender_no": "T-2026/045", "enquiry_ref": None, "intro": None,
        "items": [
            {"no": 1, "description": "Roof-mounted BMU with telescopic jib", "spec": "240 kg SWL cradle",
             "qty": 1, "unit": "No.", "unit_price": None, "total": None},
            {"no": 2, "description": "Removable davit arms", "spec": "Stainless steel sockets",
             "qty": 8, "unit": "Set", "unit_price": None, "total": None},
        ],
        "currency": "KWD", "price_unit": "Each", "terms": [{"label": "Validity", "text": "30 days"}],
        "exclusions": ["Civil works and main electrical supply."], "notes": None, "show_total": True,
        "stamp": {"show": True}, "signatory_initials": "AA",
    }
    base.update(overrides)
    return base


def make_private(root: Path, *, initials: str = "AA") -> Path:
    """A fake company letterhead (never the real one)."""
    letterhead = root / "letterhead"
    letterhead.mkdir(parents=True)
    paper = (255, 255, 217)
    for name, size in (("header.jpg", HEADER_PX), ("footer.jpg", FOOTER_PX)):
        img = Image.new("RGB", size, paper)
        ImageDraw.Draw(img).rectangle((40, 40, size[0] // 3, size[1] - 40), fill=(70, 30, 20))
        img.save(letterhead / name, quality=85)
    for name, size, colour in (("stamp.png", STAMP_PX, (30, 60, 200, 255)),
                               ("watermark.png", WATERMARK_PX, (150, 6, 1, 255))):
        img = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse((10, 10, size[0] - 10, size[1] - 10), outline=colour, width=8)
        img.save(letterhead / name)
    signatures = root / "signatures"
    signatures.mkdir()
    sig = Image.new("RGBA", SIGNATURE_PX, (0, 0, 0, 0))
    ImageDraw.Draw(sig).line((10, 150, 270, 30), fill=(20, 30, 160, 255), width=6)
    sig.save(signatures / f"{initials}.png")
    return root


@pytest.fixture
def real_assets(tmp_path):
    return LetterheadAssets.load(make_private(tmp_path / "private"), WORKSPACE["company_name"], "AA")


@pytest.fixture
def neutral_assets(tmp_path):
    empty = tmp_path / "empty-private"
    empty.mkdir()
    return LetterheadAssets.load(empty, WORKSPACE["company_name"], "AA")


def visible(html: str) -> str:
    """Rendered HTML without tags, entity-decoded (what a reader would see)."""
    text = re.sub(r"<style.*?</style>|<script.*?</script>", " ", html, flags=re.S).replace("<wbr>", "")
    return htmllib.unescape(re.sub(r"<[^>]+>", " ", text))


async def pdf_of(tmp_path, q, assets, name="q.pdf", signatory=SIGNATORY):
    try:
        path = await render_quotation_pdf(q, WORKSPACE, signatory, assets, tmp_path / name)
    except RuntimeError as exc:
        if "No usable Chromium" in str(exc):
            pytest.skip(str(exc))
        raise
    return pypdf.PdfReader(str(path))


def page_images(page) -> list[tuple[int, int]]:
    found, seen = [], set()

    def walk(resources):
        if resources is None:
            return
        for ref in (resources.get_object().get("/XObject") or {}).values():
            obj = ref.get_object()
            key = getattr(ref, "idnum", id(obj))
            if key in seen:
                continue
            seen.add(key)
            if obj.get("/Subtype") == "/Image":
                found.append((int(obj["/Width"]), int(obj["/Height"])))
            elif obj.get("/Subtype") == "/Form":
                walk(obj.get("/Resources"))

    walk(page.get("/Resources"))
    return found


def pdf_fonts(reader) -> set[str]:
    fonts, seen = set(), set()

    def walk(resources):
        if resources is None:
            return
        resources = resources.get_object()
        for font in (resources.get("/Font") or {}).values():
            fonts.add(str(font.get_object().get("/BaseFont")))
        for ref in (resources.get("/XObject") or {}).values():
            obj = ref.get_object()
            if obj.get("/Subtype") == "/Form" and getattr(ref, "idnum", id(obj)) not in seen:
                seen.add(getattr(ref, "idnum", id(obj)))
                walk(obj.get("/Resources"))

    for page in reader.pages:
        walk(page.get("/Resources"))
    return fonts


def arabic_text(text: str) -> str:
    """PDF text uses Arabic presentation forms; fold them back to letters for comparisons."""
    return re.sub(r"[\u0640\u200c-\u200f]", "", unicodedata.normalize("NFKC", text))


# ---------------------------------------------------------------------------------- templates
def test_registry_mirrors_builder_families():
    assert set(TEMPLATES) == {"tenders", "supply_installation", "annual_maintenance",
                              "equipment_rental", "service_repair"}
    assert TEMPLATES["tenders"].languages == ("en",)
    for key in ("supply_installation", "annual_maintenance", "equipment_rental", "service_repair"):
        assert TEMPLATES[key].languages == ("en", "ar")
    assert TEMPLATES["tenders"].builder_ids == {"en": "tenders"}
    assert TEMPLATES["supply_installation"].builder_ids == {"en": "supply-en", "ar": "supply-ar"}
    assert TEMPLATES["annual_maintenance"].builder_ids == {"en": "maintenance-en", "ar": "maintenance-ar"}
    assert TEMPLATES["equipment_rental"].builder_ids == {"en": "rental-en", "ar": "rental-ar"}
    assert TEMPLATES["service_repair"].builder_ids == {"en": "service-en", "ar": "service-ar"}
    assert TEMPLATES["equipment_rental"].copy["en"].price_units == ("Day", "Week", "Month", "m²", "Lump sum")
    assert TEMPLATES["supply_installation"].copy["ar"].price_units[0] == "للوحدة"
    json.dumps([spec.to_dict() for spec in TEMPLATES.values()])  # API-serialisable


def test_locked_wording_is_the_builders():
    # Spot checks against app/letter.html and app/quotation.js of the builder, word for word.
    assert TENDERS_PARAGRAPHS[1] == (
        "We have taken care to ensure that our pricing is both competitive and reflective of the quality "
        "and reliability of the equipment and services offered. We hope our prices are satisfactory for "
        "your kind approval.")
    assert TENDERS_PARAGRAPHS[-1] == "Thank you for considering our proposal."
    assert TEMPLATES["tenders"].copy["en"].signoff == "Yours faithfully,"
    maintenance = TEMPLATES["annual_maintenance"].copy
    assert maintenance["en"].terms_title == "Preventive Maintenance Scope"
    assert maintenance["en"].scope[1] == "Hoist and control-panel maintenance."
    assert maintenance["ar"].scope[0] == "التشغيل والفحص العام."
    assert TEMPLATES["supply_installation"].copy["en"].intro == (
        "Reference made to your inquiry, we are pleased to quote our best price for the supply and "
        "installation works detailed below:",)
    assert TEMPLATES["equipment_rental"].copy["en"].terms_title == "Rental Charge Conditions"
    assert TEMPLATES["service_repair"].copy["ar"].terms_title == "شروط عرض الخدمة"
    assert TEMPLATES["supply_installation"].copy["ar"].closing == ("آملين أن يحوز عرضنا على رضاكم.",)
    assert TEMPLATES["supply_installation"].copy["ar"].signoff == "وتفضلوا بقبول فائق الاحترام،"


@pytest.mark.parametrize("args, expected", [
    (("bmu", "supply_installation", "tender_rfq", "en"), "tenders"),
    (("wce", None, "Tender RFQ", "en"), "tenders"),
    (("bmu", "annual_maintenance", "direct_rfq", "en"), "annual_maintenance"),
    (("bmu", None, "o_and_m", "ar"), "annual_maintenance"),
    (("cradle", "O&M contract", None, "en"), "annual_maintenance"),
    (("access_rental", "equipment_rental", "direct_rfq", "ar"), "equipment_rental"),
    (("access_rental", None, "direct_rfq", "en"), "equipment_rental"),
    (("scaffolding", "Scaffold hire", None, "en"), "equipment_rental"),
    (("cradle", "service_repair", "direct_rfq", "en"), "service_repair"),
    (("crane", "inspection_certification", None, "en"), "service_repair"),
    (("hoist", "Repair of hoist motor", None, "en"), "service_repair"),
    (("bmu", "supply_installation", "direct_rfq", "en"), "supply_installation"),
    (("access_rental", "supply_installation", "direct_rfq", "en"), "supply_installation"),
    ((None, None, None, "en"), "supply_installation"),
])
def test_choose_template_rules(args, expected):
    key, reason = choose_template(*args)
    assert key == expected
    assert reason and TEMPLATES[key].label["en"] in reason


def test_choose_template_falls_back_to_english():
    key, reason = choose_template("bmu", "supply_installation", "tender_rfq", "ar")
    assert key == "tenders"
    assert "English" in reason
    assert TEMPLATES[key].resolve_language("ar") == "en"
    assert TEMPLATES["supply_installation"].resolve_language("ar") == "ar"
    _, reason_ar = choose_template("bmu", "supply_installation", "direct_rfq", "ar")
    assert "English" not in reason_ar


def test_default_quotation_prefills_template_and_never_prices():
    project = {"name": "Sample Tower", "service_family": "bmu", "work_type": "supply_installation",
               "request_kind": "tender_rfq", "tender_no": "T-1",
               "scope_items": [{"description": "Roof BMU", "qty": 1, "unit": "No.", "unit_price": 99, "total": 99}]}
    enquiry = {"customer": {"name": "Example Contracting Co.", "city": "Kuwait"},
               "contact": {"name": "Eng. Sample", "title": "Estimator", "email": "e@example.com"}}
    q = default_quotation("tenders", "ar", project, enquiry, SIGNATORY, existing_refs=["AA/26/0117"])
    assert q["language"] == "en" and q["template_key"] == "tenders" and q["status"] == "draft"
    assert q["reference"] == "AA/26/0118"
    assert q["subject"] == "Quotation for BMU (Building Maintenance Unit) System."
    assert q["to"] == {"company": "Example Contracting Co.", "attention": "Eng. Sample / Estimator",
                       "address": "Kuwait", "email": "e@example.com", "phone": None}
    assert q["items"][0]["unit_price"] is None and q["items"][0]["total"] is None
    assert {t["label"]: t["text"] for t in q["terms"]}["Validity"] == "One month."
    assert q["exclusions"] == ["Civil works and main electrical supply."]
    assert q["tender_no"] == "T-1" and q["signatory_initials"] == "AA" and q["stamp"] == {"show": True}

    ar = default_quotation("annual_maintenance", "ar", {"service_family": "wce"}, {}, SIGNATORY)
    assert ar["language"] == "ar" and ar["reference"] is None
    assert ar["subject"] == "عقد الصيانة السنوية – معدات تنظيف الواجهات"
    assert {t["key"]: t for t in ar["terms"]}["contract_value"] == {
        "key": "contract_value", "label": "قيمة العقد (د.ك)", "text": None}  # a price: left to the engineer
    with pytest.raises(KeyError):
        default_quotation("nope", "en", {}, {}, SIGNATORY)


# ---------------------------------------------------------------------------------- numbering
def test_next_reference_continues_highest_serial_for_initials_and_year():
    existing = ["AA/26/0117", "AA/26/0009", "AB/26/0500", "AA/25/0999", "aa-2026-0042", "AA/26/0116-R2",
                "garbage", None, ""]
    assert next_reference("AA", 2026, existing) == "AA/26/0118"
    assert next_reference("aa", "26", existing) == "AA/26/0118"
    assert next_reference("AB", 2026, existing) == "AB/26/0501"
    assert next_reference("A.A.", 2027, existing) == "AA/27/0001"
    assert next_reference("ZZ", 2026, []) == "ZZ/26/0001"
    assert next_reference("AA", 2026, ["AA/26/9999"]) == "AA/26/10000"


def test_parse_reference():
    ref = parse_reference("AA/26/0117")
    assert (ref.initials, ref.year, ref.serial, ref.revision) == ("AA", 26, 117, None)
    assert str(ref) == "AA/26/0117"
    assert parse_reference(" ab - 2026 - 7 ") .serial == 7
    assert parse_reference("AA/26/0117-R2").revision == 2
    for bad in ("", None, "AA26/0117", "Quotation 117", "AA/26/"):
        assert parse_reference(bad) is None


# ---------------------------------------------------------------------------------- assets
def test_empty_private_dir_uses_neutral_default_and_references_nothing_private(tmp_path, neutral_assets):
    status = neutral_assets.status
    assert (status["header"], status["footer"], status["stamp"], status["watermark"], status["signature"]) == (
        "default", "default", "missing", "missing", "missing")
    assert status["letterhead_installed"] is False
    assert any("letterhead not installed" in w for w in status["warnings"])
    html = render_quotation_html(quotation(), WORKSPACE, SIGNATORY, neutral_assets)
    assert "data:image" not in html and "<img" not in html
    assert "Specimen – company letterhead not installed" in html
    assert WORKSPACE["company_name"] in html  # the neutral header names the workspace company
    assert str(tmp_path) not in html and "file:" not in html


def test_real_assets_are_embedded_and_signature_matches_initials(tmp_path, real_assets):
    status = real_assets.status
    assert {k: status[k] for k in ("header", "footer", "stamp", "watermark", "signature")} == dict.fromkeys(
        ("header", "footer", "stamp", "watermark", "signature"), "real")
    assert status["letterhead_installed"] and status["signature_initials"] == "AA"
    assert status["paper"] != "#FFFFFF"  # scanned (JPEG) letterhead: page takes the paper colour
    html = render_quotation_html(quotation(), WORKSPACE, SIGNATORY, real_assets)
    for asset in (real_assets.header, real_assets.footer, real_assets.stamp, real_assets.watermark,
                  real_assets.signature):
        assert asset.data_uri in html
    assert str(tmp_path) not in html
    other = dict(SIGNATORY, initials="BB", full_name="Other Person")
    html_other = render_quotation_html(quotation(signatory_initials="BB"), WORKSPACE, other, real_assets)
    assert real_assets.signature.data_uri not in html_other  # never sign with someone else's signature
    assert "Other Person" in html_other


# ---------------------------------------------------------------------------------- HTML
@pytest.mark.parametrize("key, lang", [(k, lang) for k, spec in TEMPLATES.items() for lang in spec.languages])
def test_html_contains_locked_wording(key, lang, real_assets):
    spec = TEMPLATES[key]
    copy_ = spec.copy[lang]
    q = quotation(template_key=key, language=lang, subject="Sample subject",
                  variables={"equipment": "Sample Equipment", "system": "sample systems"})
    text = visible(render_quotation_html(q, WORKSPACE, SIGNATORY, real_assets))
    for paragraph in copy_.intro:
        assert fill_placeholders(paragraph, {"equipment": "Sample Equipment", "system": "sample systems"}) in text
    for fixed in (copy_.salutation, copy_.terms_title, copy_.signoff, *copy_.closing, *copy_.scope):
        assert fixed in text
    assert copy_.table_title in text  # items present


def test_html_escapes_user_content(real_assets):
    q = quotation(subject='<script>alert("x")</script> & Co', to={"company": "<b>Bold</b> Co."})
    html = render_quotation_html(q, WORKSPACE, SIGNATORY, real_assets)
    assert "<script>alert" not in html and "<b>Bold</b>" not in html
    assert "&lt;script&gt;" in html and "&amp; Co" in html


def test_null_prices_print_as_empty_cells_and_no_partial_total(real_assets):
    items = [
        {"no": 1, "description": "Priced row", "qty": 2, "unit": "No.", "unit_price": 1250, "total": "2500"},
        {"no": 2, "description": "Unpriced row", "qty": 1, "unit": "Lot", "unit_price": None, "total": None},
    ]
    html = render_quotation_html(quotation(items=items), WORKSPACE, SIGNATORY, real_assets)
    cells = lambda key: [re.sub(r"<[^>]+>", "", c) for c in re.findall(rf'<td class="c-{key}">(.*?)</td>', html)]
    assert cells("unit_price") == ["1,250.000", ""]
    assert cells("total")[:2] == ["2,500.000", ""]
    assert cells("total")[2] == ""  # grand total stays blank while any row is unpriced
    assert "None" not in visible(html) and "null" not in visible(html)

    priced = copy.deepcopy(items)
    priced[1].update(unit_price=500, total=500)
    html = render_quotation_html(quotation(items=priced), WORKSPACE, SIGNATORY, real_assets)
    assert "3,000.000" in visible(html)  # 2,500 + 500, KWD with three decimals

    included = copy.deepcopy(items)
    included[1]["included"] = True  # priced inside another row: prints "Included", total still computable
    html = render_quotation_html(quotation(items=included), WORKSPACE, SIGNATORY, real_assets)
    assert cells("unit_price") == ["1,250.000", "Included"] and cells("total")[2] == "2,500.000"


def test_draft_watermark_only_until_approved(real_assets):
    assert 'class="draft-mark"' in render_quotation_html(quotation(status="draft"), WORKSPACE, SIGNATORY, real_assets)
    assert 'class="draft-mark"' in render_quotation_html(quotation(status="in_review"), WORKSPACE, SIGNATORY, real_assets)
    approved = render_quotation_html(quotation(status="approved"), WORKSPACE, SIGNATORY, real_assets)
    assert 'class="draft-mark"' not in approved and "DRAFT" not in approved


def test_intro_override_stamp_toggle_and_arabic_font(real_assets):
    html = render_quotation_html(quotation(intro="First custom paragraph.\n\nSecond one."), WORKSPACE,
                                 SIGNATORY, real_assets)
    text = visible(html)
    assert "First custom paragraph." in text and "Second one." in text
    assert "Please find attached our quotation" not in text
    assert 'class="page-stamp"' in html
    assert "@font-face" not in html  # no Arabic font embedded for an English-only document

    hidden = render_quotation_html(quotation(stamp={"show": False}), WORKSPACE, SIGNATORY, real_assets)
    assert 'class="page-stamp"' not in hidden and real_assets.stamp.data_uri not in hidden

    ar = render_quotation_html(quotation(template_key="supply_installation", language="ar"), WORKSPACE,
                               SIGNATORY, real_assets)
    assert '<html lang="ar" dir="rtl"' in ar and "data:font/woff2;base64," in ar


# ---------------------------------------------------------------------------------- PDF
async def test_pdf_tenders_english(tmp_path, real_assets):
    q = quotation(variables={"equipment": "BMU (Building Maintenance Unit) Window Cleaning Equipment",
                             "system": "BMU systems"})
    reader = await pdf_of(tmp_path, q, real_assets)
    text = "\n".join(p.extract_text() for p in reader.pages)
    for expected in ("AA/26/0118", "Quotation for BMU Window Cleaning Equipment.", "Roof-mounted BMU with telescopic jib",
                     "Removable davit arms", "Please find attached our quotation for the BMU (Building Maintenance Unit)",
                     "Yours faithfully,", "Sample Signatory", "01/10/2026", "Example Contracting Co."):
        assert expected in text
    total = len(reader.pages)
    for number, page in enumerate(reader.pages, 1):
        page_text = page.extract_text()
        assert f"Page {number} of {total}" in page_text
        assert "DRAFT" in page_text
        sizes = page_images(page)
        assert HEADER_PX in sizes and FOOTER_PX in sizes and STAMP_PX in sizes  # on EVERY page
    assert sum(SIGNATURE_PX in page_images(p) for p in reader.pages) == 1  # signature once ...
    assert SIGNATURE_PX in page_images(reader.pages[-1])  # ... at the end
    assert reader.pages[0].mediabox.width == pytest.approx(595.3, abs=1)  # A4
    assert reader.pages[0].mediabox.height == pytest.approx(841.9, abs=1)


async def test_pdf_arabic_rtl_with_embedded_font(tmp_path, real_assets):
    q = quotation(template_key="supply_installation", language="ar", reference="AA/26/0120",
                  subject="عرض توريد وتركيب معدات الوصول للواجهات",
                  to={"company": "شركة المثال للتجارة العامة والمقاولات", "attention": "مدير المشتريات"},
                  items=[{"no": 1, "description": "منصة رفع أفراد كهربائية", "spec": "ارتفاع عمل 18 متر",
                          "qty": 1, "unit": "عدد", "unit_price": None, "total": None}],
                  terms=[{"label": "صلاحية العرض", "text": "شهر واحد"}], exclusions=[])
    reader = await pdf_of(tmp_path, q, real_assets)
    text = arabic_text("\n".join(p.extract_text() for p in reader.pages))
    # pypdf emits RTL lines in visual word order, so compare word by word.
    for word in ("توريد", "وتركيب", "للواجهات", "منصة", "كهربائية", "تحية", "طيبة", "وبعد", "شروط",
                 "والتركيب", "AA/26/0120", "صفحة"):
        assert word in text
    assert "\x00" not in text  # a real text layer: Arabic can be searched and copied
    assert any("IBMPlexSansArabic" in font for font in pdf_fonts(reader))


async def test_pdf_25_items_paginates_with_header_and_stamp_on_every_page(tmp_path, real_assets):
    items = [{"no": i, "description": f"Sample item {i:02d} – access component", "spec": "Galvanised steel",
              "qty": i, "unit": "No.", "unit_price": None, "total": None} for i in range(1, 26)]
    reader = await pdf_of(tmp_path, quotation(items=items), real_assets)
    pages = [p.extract_text() for p in reader.pages]
    total = len(pages)
    assert total >= 2
    everything = "\n".join(pages)
    for i in range(1, 26):
        assert everything.count(f"Sample item {i:02d} – access component") == 1
    for number, (page, text) in enumerate(zip(reader.pages, pages), 1):
        assert f"Page {number} of {total}" in text
        sizes = page_images(page)
        assert HEADER_PX in sizes and FOOTER_PX in sizes and STAMP_PX in sizes
        if "Sample item" in text:
            assert "Description" in text and "Unit price (KWD)" in text  # table header repeated
        if number > 1:
            assert "continued" in text
    assert "Sample Signatory" not in "\n".join(pages[:-1]) and "Sample Signatory" in pages[-1]


async def test_pdf_approved_neutral_letterhead_has_no_images_or_draft(tmp_path, neutral_assets):
    items = [{"no": 1, "description": "Priced", "qty": 1, "unit": "No.", "unit_price": 1250, "total": 1250},
             {"no": 2, "description": "Unpriced", "qty": 1, "unit": "No.", "unit_price": None, "total": None}]
    reader = await pdf_of(tmp_path, quotation(status="approved", items=items), neutral_assets)
    text = "\n".join(p.extract_text() for p in reader.pages)
    assert "DRAFT" not in text and "pending engineer approval" not in text
    assert "Specimen – company letterhead not installed" in text
    assert "1,250.000" in text and "None" not in text
    assert all(page_images(p) == [] for p in reader.pages)


async def test_pdf_stamp_hidden(tmp_path, real_assets):
    reader = await pdf_of(tmp_path, quotation(stamp={"show": False}), real_assets)
    assert all(STAMP_PX not in page_images(p) for p in reader.pages)
    assert all(HEADER_PX in page_images(p) for p in reader.pages)


# ---------------------------------------------------------------------------------- import script
def _fake_builder(root: Path) -> Path:
    assets = root / "medmack-quotation-builder" / "app" / "assets"
    assets.mkdir(parents=True)
    Image.new("RGB", (400, 80), (255, 255, 217)).save(assets / "header.jpg")
    Image.new("RGB", (400, 50), (255, 255, 217)).save(assets / "footer.jpg")
    for name in ("stamp.png", "watermark.png", "sign.png"):
        Image.new("RGBA", (60, 60), (0, 0, 200, 255)).save(assets / name)
    (assets.parent / "quotation.html").write_text(".page { position:relative; background:#FEFDD7; color:#241606 }")
    return assets


def _run_import(*args, env=None):
    return subprocess.run([sys.executable, str(IMPORT_SCRIPT), *args], capture_output=True, text=True,
                          env=env, timeout=60)


def test_import_letterhead_copies_into_private_data_dir(tmp_path, monkeypatch):
    source = _fake_builder(tmp_path)
    data = tmp_path / "data"
    env = {**__import__("os").environ, "ESS_DATA_DIR": str(data)}
    result = _run_import("--from", str(source), "--initials", "AB", env=env)
    assert result.returncode == 0, result.stderr
    private = data / "private"
    for rel in ("letterhead/header.jpg", "letterhead/footer.jpg", "letterhead/stamp.png",
                "letterhead/watermark.png", "signatures/AB.png"):
        assert (private / rel).is_file(), rel
        assert rel.split("/")[-1] in result.stdout
    assert json.loads((private / "letterhead" / "letterhead.json").read_text())["paper"] == "#FEFDD7"
    assets = LetterheadAssets.load(private, "Example", "AB")
    assert assets.letterhead_installed and assets.status["signature"] == "real" and assets.paper == "#FEFDD7"


def test_import_letterhead_refuses_git_tree_outside_data(tmp_path):
    source = _fake_builder(tmp_path)
    inside_repo = REPO_ROOT / "backend" / "tests" / "_should_not_exist"
    result = _run_import("--from", str(source), "--data-dir", str(inside_repo))
    assert result.returncode == 2 and "refused" in result.stderr
    assert not inside_repo.exists()

    other_repo = tmp_path / "other-repo"
    other_repo.mkdir()
    if subprocess.run(["git", "init", "-q", str(other_repo)], capture_output=True).returncode != 0:
        pytest.skip("git not available")
    result = _run_import("--from", str(source), "--data-dir", str(other_repo / "data"))
    assert result.returncode == 2 and not (other_repo / "data").exists()
