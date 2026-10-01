"""ess.quotation builder features: papers, signature import, stamp settings, catalog, photos.

All images and catalogs here are generated on the fly: no company asset or real signature.
"""
from __future__ import annotations

import io
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from ess.quotation import (
    LetterheadAssets,
    SignatureNotFound,
    catalog_item,
    detect_signature,
    extract_signature,
    get_paper,
    list_papers,
    load_catalog,
    normalize_photo,
    render_quotation_html,
    search_catalog,
)
from test_quotation import (  # noqa: E402  (shared helpers of the main quotation tests)
    HEADER_PX,
    FOOTER_PX,
    IMPORT_SCRIPT,
    SIGNATORY,
    STAMP_PX,
    WORKSPACE,
    _fake_builder,
    make_private,
    page_images,
    pdf_of,
    quotation,
    visible,
)

CREAM, BROWN, BLUE, BLACK = (255, 253, 215), (70, 40, 20), (30, 50, 170), (25, 25, 25)


# ---------------------------------------------------------------------------------- papers
def make_papers(root: Path) -> Path:
    make_private(root)  # legacy letterhead/ = paper "default"
    for paper_id, mode in (("acme-letterhead", "letterhead"), ("acme-preprinted", "preprinted")):
        folder = root / "papers" / paper_id
        folder.mkdir(parents=True)
        for name in ("stamp.png",) + (("header.jpg", "footer.jpg", "watermark.png") if mode == "letterhead" else ()):
            (folder / name).write_bytes((root / "letterhead" / name).read_bytes())
        (folder / "paper.json").write_text(json.dumps({
            "id": paper_id, "name": f"Acme {mode}", "company_name": "Acme Co.", "mode": mode,
            "languages": ["en", "ar"],
            "geometry": {"header": {"height_mm": 38.24}, "footer": {"height_mm": 25.49}}}))
    return root


def test_list_papers_and_legacy_default(tmp_path):
    private = make_papers(tmp_path / "private")
    papers = list_papers(private)
    assert [p.id for p in papers] == ["default", "acme-letterhead", "acme-preprinted"]
    described = [p.to_dict() for p in papers]
    assert str(tmp_path) not in json.dumps(described)  # never leaks private paths
    assert described[2]["mode"] == "preprinted" and described[2]["complete"] is True
    assert get_paper(private, "ACME-LETTERHEAD").company_name == "Acme Co."
    assert get_paper(private, "missing") is None
    assert list_papers(tmp_path / "nothing-here") == []


def test_load_assets_for_a_paper(tmp_path):
    private = make_papers(tmp_path / "private")
    full = LetterheadAssets.load(private, "Acme Co.", "AA", paper_id="acme-letterhead")
    assert full.status["paper_id"] == "acme-letterhead" and full.status["header"] == "real"
    pre = LetterheadAssets.load(private, "Acme Co.", "AA", paper_id="acme-preprinted")
    status = pre.status
    assert (status["mode"], status["header"], status["footer"], status["stamp"]) == (
        "preprinted", "preprinted", "preprinted", "real")
    assert pre.paper == "#FFFFFF" and pre.content_top_mm == full.content_top_mm  # same text position
    html = render_quotation_html(quotation(), WORKSPACE, SIGNATORY, pre)
    assert 'class="band' not in html and "Specimen" not in html and 'class="wm"' not in html
    assert 'class="page-stamp"' in html and pre.signature.data_uri in html

    unknown = LetterheadAssets.load(private, "Acme Co.", "AA", paper_id="nope")
    assert unknown.status["header"] == "default" and not unknown.paper_found
    assert any("nope" in w for w in unknown.status["warnings"])

    only_papers = tmp_path / "only-papers"
    make_papers(only_papers)
    for child in (only_papers / "letterhead").iterdir():
        child.unlink()
    (only_papers / "letterhead").rmdir()
    assert LetterheadAssets.load(only_papers, "Acme Co.", "AA").paper_id == "acme-letterhead"


async def test_pdf_on_preprinted_paper_prints_body_and_stamp_only(tmp_path):
    pre = LetterheadAssets.load(make_papers(tmp_path / "private"), "Acme Co.", "AA", paper_id="acme-preprinted")
    reader = await pdf_of(tmp_path, quotation(status="approved"), pre)
    for page in reader.pages:
        sizes = page_images(page)
        assert STAMP_PX in sizes and HEADER_PX not in sizes and FOOTER_PX not in sizes
    assert "Roof-mounted BMU" in "\n".join(p.extract_text() for p in reader.pages)


# ---------------------------------------------------------------------------------- stamp settings
def test_stamp_default_pages_and_auto_fit(tmp_path):
    assets = LetterheadAssets.load(make_private(tmp_path / "private"), "Acme", "AA")
    settings = {"show": True, "default": {"x_mm": 150, "y_mm": 228, "width_mm": 30},
                "pages": {"2": {"show": False}, "3": {"x_mm": 500, "y_mm": 400, "width_mm": 99}}}
    html = render_quotation_html(quotation(stamp=settings), WORKSPACE, SIGNATORY, assets)
    assert "left:150.0mm;top:228.0mm;width:30.0mm" in html
    pages = json.loads(re.search(r'data-stamp-pages="([^"]*)"', html).group(1).replace("&#34;", '"'))
    assert pages["2"]["show"] is False
    assert pages["3"]["width"] == 58.0 and pages["3"]["x"] == 210 - 6 - 58  # fitted inside the page
    assert pages["3"]["y"] <= 276 - 58 * STAMP_PX[1] / STAMP_PX[0] + 0.01


async def test_pdf_stamp_per_page_visibility(tmp_path):
    assets = LetterheadAssets.load(make_private(tmp_path / "private"), "Acme", "AA")
    items = [{"no": i, "description": f"Row {i}", "qty": 1, "unit": "No.", "unit_price": None, "total": None}
             for i in range(1, 30)]
    reader = await pdf_of(tmp_path, quotation(items=items, stamp={"show": False, "pages": {"1": {"show": True}}}), assets)
    assert len(reader.pages) >= 2
    assert STAMP_PX in page_images(reader.pages[0])
    assert all(STAMP_PX not in page_images(p) for p in reader.pages[1:])


# ---------------------------------------------------------------------------------- signature import
def letter_image(ink=BLUE, *, stamp=True) -> bytes:
    """A generated signed letter: brown 'printed' lines, a pen signature, a blue round stamp."""
    page = Image.new("RGB", (1240, 1754), CREAM)
    draw = ImageDraw.Draw(page)
    for i in range(28):  # printed text and letterhead in brown / black
        draw.rectangle((110, 260 + i * 38, 110 + 600 + (i * 37) % 400, 266 + i * 38), fill=BROWN)
    draw.rectangle((100, 80, 1140, 180), fill=BROWN)
    points = [(130 + x, 1490 + int(28 * ((x // 18) % 2 * 2 - 1) * (1 - abs(140 - x) / 160))) for x in range(0, 280, 6)]
    draw.line(points, fill=ink, width=5)
    draw.line([(125, 1540), (420, 1505)], fill=ink, width=4)
    if stamp:
        draw.ellipse((470, 1390, 650, 1570), outline=(40, 80, 200), width=10)
        draw.ellipse((505, 1425, 615, 1535), outline=(40, 80, 200), width=6)
        draw.ellipse((530, 1450, 590, 1510), fill=(40, 80, 200))
    out = io.BytesIO()
    page.save(out, "JPEG", quality=92)
    return out.getvalue()


def test_detect_and_extract_blue_signature():
    data = letter_image()
    found = detect_signature(data)
    assert found.confidence >= 90, found.notes
    x, y, w, h = found.signature
    assert x <= 130 and y <= 1470 and x + w >= 410 and y + h >= 1540  # the whole signature
    sx, sy, sw, sh = found.stamp
    assert sx <= 560 <= sx + sw and sy <= 1480 <= sy + sh and x + w < sx  # stamp found separately
    cut = Image.open(io.BytesIO(extract_signature(data)))
    assert cut.mode == "RGBA" and cut.size == (w, h)
    alpha = cut.getchannel("A")
    assert alpha.getpixel((0, 0)) == 0  # paper is transparent
    assert max(alpha.getdata()) == 255 and sum(1 for a in alpha.getdata() if a > 200) > 500  # ink kept


def test_black_pen_is_rejected_unless_boxed_by_hand():
    data = letter_image(ink=BLACK)
    found = detect_signature(data)
    assert found.signature is None and found.confidence == 0 and found.stamp is not None
    with pytest.raises(SignatureNotFound) as error:
        extract_signature(data)
    assert any("black pen" in note for note in error.value.notes)
    cut = Image.open(io.BytesIO(extract_signature(data, crop_box=(100, 1440, 340, 130))))
    alpha = cut.getchannel("A")
    assert sum(1 for a in alpha.getdata() if a > 200) > 500  # dark ink keyed when boxed by hand
    assert cut.width <= 340 and cut.height <= 130
    with pytest.raises(ValueError):
        extract_signature(b"not an image")


# ---------------------------------------------------------------------------------- catalog
CATALOG = {
    "schema": 1,
    "units": {"each": {"en": "Each", "ar": "للوحدة"}, "month": {"en": "Month", "ar": "شهري"}},
    "transactions": [{"id": "sale", "label": {"en": "Sale", "ar": "بيع"}},
                     {"id": "rental", "label": {"en": "Rental", "ar": "تأجير"}}],
    "products": [
        {"id": "electric-platform", "family": "suspended", "name": {"en": "Electric suspended platform", "ar": "منصة معلقة كهربائية"},
         "aliases": ["electric cradle", "سقالة كهربائية"], "specification": {"en": "6 m platform; 2 hoists", "ar": "منصة 6 متر"},
         "default_units": {"sale": "each", "rental": "month"}, "transactions": ["sale", "rental"],
         "prices": [{"year": 2023, "transaction": "sale", "amount": 1300, "currency": "KWD", "unit": "each", "context": "older"},
                    {"year": 2025, "transaction": "sale", "amount": 1450, "currency": "KWD", "unit": "each", "context": "new unit"}]},
        {"id": "steel-ledger", "family": "steel", "name": {"en": "Steel ledger 1.5 m", "ar": "ليدجر حديد 1.5 متر"},
         "default_units": {"sale": "each"}, "transactions": ["sale"], "prices": []},
    ],
}


def test_catalog_prefill_never_copies_prices(tmp_path):
    folder = tmp_path / "private" / "catalog"
    folder.mkdir(parents=True)
    (folder / "products.json").write_text(json.dumps(CATALOG, ensure_ascii=False), encoding="utf-8")
    (folder / "broken.json").write_text("{not json", encoding="utf-8")
    catalog = load_catalog(tmp_path / "private")
    assert len(catalog.products) == 2 and catalog.sources == ["products.json"] and catalog.warnings

    hits = search_catalog("electric cradle", catalog, transaction="sale")
    assert hits[0]["product_id"] == "electric-platform"
    assert hits[0]["price_hint"]["year"] == 2025 and "Historical guidance only (2025): 1,450 KWD / Each" in hits[0]["price_hint"]["text"]
    assert search_catalog("سقاله كهربائيه", catalog, language="ar")[0]["description"] == "منصة معلقة كهربائية"
    assert [h["product_id"] for h in search_catalog("", catalog, transaction="rental")] == ["electric-platform"]
    assert search_catalog("zzz-unknown", catalog) == []

    item = catalog_item(catalog.get("electric-platform"), catalog, language="en", transaction="rental", qty=2)
    assert item["description"] == "Electric suspended platform" and item["price_unit"] == "Month"
    assert item["unit_price"] is None and item["total"] is None  # guidance stays guidance
    html = render_quotation_html(quotation(items=[item]), WORKSPACE, SIGNATORY, LetterheadAssets.neutral("Acme"))
    assert "1,450" not in visible(html) and "1,300" not in visible(html)
    assert load_catalog(tmp_path / "missing").products == []


# ---------------------------------------------------------------------------------- photos
def photo_file(path: Path, size=(3000, 2000), fmt="PNG") -> Path:
    img = Image.new("RGB", size, (200, 205, 210))
    ImageDraw.Draw(img).rectangle((size[0] // 4, size[1] // 4, size[0] * 3 // 4, size[1] * 3 // 4), fill=(90, 95, 100))
    img.save(path, fmt)
    return path


def test_normalize_photo_like_the_builder(tmp_path):
    photo = normalize_photo(photo_file(tmp_path / "big.png"))
    assert (photo.width, photo.height) == (1600, 1067)
    assert Image.open(io.BytesIO(photo.jpeg)).format == "JPEG" and photo.data_uri.startswith("data:image/jpeg;base64,")
    with pytest.raises(ValueError):
        normalize_photo(tmp_path / "missing.jpg")


async def test_pdf_reference_photos_annex_and_page_placement(tmp_path):
    assets = LetterheadAssets.load(make_private(tmp_path / "private"), "Acme", "AA")
    items = [{"no": i, "description": f"Sample item {i:02d}", "qty": 1, "unit": "No.", "unit_price": None, "total": None}
             for i in range(1, 26)]
    photos = [
        {"path": str(photo_file(tmp_path / "annex.jpg", (1200, 900), "JPEG")), "caption": "Annex photo", "placement": "annex"},
        {"path": str(photo_file(tmp_path / "placed.png", (800, 600))), "caption": "Placed photo",
         "placement": {"page": 1, "x_mm": 110, "y_mm": 237, "width_mm": 25}},
    ]
    reader = await pdf_of(tmp_path, quotation(items=items, photos=photos), assets)
    last = reader.pages[-1].extract_text()
    total = len(reader.pages)
    assert "Product Reference Annex" in last and "Annex photo" in last and f"Page {total} of {total}" in last
    assert (1200, 900) in page_images(reader.pages[-1])
    assert (800, 600) in page_images(reader.pages[0])  # placed in the free space on page 1
    assert "Placed photo" not in last


def test_unreadable_photo_is_an_error(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"nope")
    with pytest.raises(ValueError):
        render_quotation_html(quotation(photos=[{"path": str(bad)}]), WORKSPACE, SIGNATORY, LetterheadAssets.neutral("A"))


# ---------------------------------------------------------------------------------- import script
def test_import_creates_papers_and_private_catalog(tmp_path):
    source = _fake_builder(tmp_path)
    data_dir = source.parent / "data"
    data_dir.mkdir()
    (data_dir / "scaffolding-catalog.json").write_text(json.dumps(CATALOG), encoding="utf-8")
    result = subprocess.run([sys.executable, str(IMPORT_SCRIPT), "--from", str(source), "--data-dir",
                             str(tmp_path / "data"), "--paper-prefix", "acme", "--company-name", "Acme Co."],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    private = tmp_path / "data" / "private"
    assert [p.id for p in list_papers(private)] == ["default", "acme-letterhead", "acme-preprinted"]
    pre = json.loads((private / "papers" / "acme-preprinted" / "paper.json").read_text())
    assert pre["mode"] == "preprinted" and pre["geometry"]["header"]["height_mm"] == pytest.approx(198.4 * 80 / 400, abs=0.01)
    assert not (private / "papers" / "acme-preprinted" / "header.jpg").exists()
    assert load_catalog(private).products[0].id == "electric-platform"
    assert "catalog/scaffolding-catalog.json" in result.stdout
