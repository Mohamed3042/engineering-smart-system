"""Document extraction on generated fixtures: PDF (drawing pages + BOQ), DOCX, XLSX, CSV, image, ZIP, EML, DXF."""
from __future__ import annotations

import io
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

import ess_input_fixtures as fx  # noqa: E402

from ess.documents.extract import classify_document, detect_kind, extract_document, render_pdf_page  # noqa: E402
from ess.documents.pdf import drawing_score, sheet_size  # noqa: E402

MM = fx.MM


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    root = tmp_path_factory.mktemp("docs")
    return {
        "pdf": fx.make_tender_pdf(root / "Tender package.pdf"),
        "docx": fx.make_docx(root / "RFQ BMU.docx"),
        "xlsx": fx.make_boq_xlsx(root / "Div 11 pricing.xlsx"),
        "root": root,
    }


def test_pdf_pages_drawing_detection_and_boq(files):
    doc = extract_document(files["pdf"])
    assert doc.kind == "pdf" and doc.doc_kind == "tender_doc"
    assert doc.meta["pages"] == 3 and doc.meta["author"] == "UE Estimation" and doc.meta["title"] == "Tender package"
    assert doc.meta["created"].startswith("2026-08-26")
    spec, drawing, boq = doc.pages
    assert [p["n"] for p in doc.pages] == [1, 2, 3]
    assert (spec["sheet"], drawing["sheet"], boq["sheet"]) == ("A4", "A1", "A3")
    assert [p["is_drawing_like"] for p in doc.pages] == [False, True, False]
    assert doc.drawing_pages == [2] and doc.meta["drawing_pages"] == [2]
    assert "SECTION 11 24 23" in spec["text"] and "DRAWING NO: A-501" in drawing["text"]
    assert "\f" in doc.text and not doc.warnings

    relevant = doc.relevant_boq_items
    assert [b["ref"] for b in relevant] == ["11.1", "11.2"]
    assert relevant[0]["qty"] == 1 and relevant[0]["unit"] == "No" and relevant[0]["page"] == 3
    assert relevant[0]["section"] == "DIVISION 11 - EQUIPMENT › 11 24 23 Facade Access Equipment"
    doors = next(b for b in doc.boq_items if b["ref"] == "8.1")
    assert doors["relevant"] is False and doors["amount"] == 4200 and doors["rate"] == 350
    assert doc.tables[0]["page"] == 3
    assert doc["kind"] == "pdf" and doc.get("missing", "x") == "x"  # dict-style access too


def test_render_pdf_page(files):
    png = render_pdf_page(files["pdf"], 2, dpi=30)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    from PIL import Image

    image = Image.open(io.BytesIO(png))
    assert abs(image.width - round(841 / 25.4 * 30)) <= 2 and abs(image.height - round(594 / 25.4 * 30)) <= 2
    with pytest.raises(IndexError):
        render_pdf_page(files["pdf"], 0)
    with pytest.raises(IndexError):
        render_pdf_page(files["pdf"], 9)


def test_sheet_sizes_and_scores():
    assert sheet_size(841 * MM, 594 * MM) == "A1" and sheet_size(210 * MM, 297 * MM) == "A4"
    assert sheet_size(24 * 72, 36 * 72) == "ARCH D" and sheet_size(1500 * MM, 1000 * MM) == "oversize"
    title_block = "DRAWING NO: S-101 SCALE 1:50 REV A DRAWN AB CHECKED CD"
    assert drawing_score(title_block, 420 * MM, 297 * MM) >= 3  # A3 sheet with a title block
    assert drawing_score(title_block, 210 * MM, 297 * MM) >= 3  # even on A4
    assert drawing_score("PROJECT: X\nREV 2\n" + "word " * 2000, 210 * MM, 297 * MM) < 3  # text-heavy A4


def test_docx_text_tables_and_meta(files):
    doc = extract_document(files["docx"])
    assert doc.kind == "docx" and doc.doc_kind == "tender_doc"
    assert "Request for Quotation" in doc.text and "Item | Description | Qty" in doc.text
    assert "UE/RFQ/2026/118" in doc.text  # header text kept
    assert doc.meta["author"] == "A. Engineer" and doc.meta["tables"] == 1
    assert [(b["description"], b["relevant"]) for b in doc.boq_items] == [
        ("Roof-mounted BMU with cradle", True), ("Painting of plant room", False)]
    assert doc.boq_items[1]["unit"] == "LS" and doc.boq_items[1]["sheet"] == "Table 1"


def test_xlsx_boq_sections_and_relevance(files):
    doc = extract_document(files["xlsx"])
    assert doc.kind == "spreadsheet" and doc.doc_kind == "boq"
    assert doc.meta["sheets"] == ["Div 11 - Equipment", "ملخص"] and len(doc.pages) == 2
    items = {b["ref"]: b for b in doc.boq_items if b["sheet"] == "Div 11 - Equipment"}
    bmu = items["11.1"]
    assert bmu["relevant"] and bmu["row"] == 7 and bmu["qty"] == 1 and bmu["unit"] == "No"
    assert bmu["section"] == "DIVISION 11 – EQUIPMENT › 11 24 23 Façade Access Equipment"
    assert bmu["description"].endswith("all accessories as per Section 11 24 23.")  # wrapped line joined
    assert items["11.2"]["relevant"] and items["11.3"]["relevant"] and items["11.3"]["unit"] == "Nos"
    assert not items["11.4"]["relevant"] and items["11.4"]["section"].endswith("11 13 00 Loading Dock Equipment")
    assert items["11.4"]["amount"] == 3000 and items["8.1"]["section"] == "DIVISION 08 – OPENINGS"
    assert "Total carried to collection" not in {b["description"] for b in doc.boq_items}
    arabic = [b for b in doc.boq_items if b["sheet"] == "ملخص"]
    assert [(b["ref"], b["relevant"]) for b in arabic] == [("1", True), ("2", False)]
    assert arabic[1]["rate"] == 2.5 and arabic[1]["amount"] == 250
    assert doc.tables[0]["row_numbers"][0] == 1 and doc.meta["boq_relevant"] == 4


def test_csv_and_image(tmp_path):
    csv_path = tmp_path / "pricing.csv"
    csv_path.write_text("Ref;Description;Qty;Unit;Rate;Amount\n1;Gondola rental (monthly);3;month;450;1350\n"
                        "2;Scaffold;10;m2;;\n", encoding="cp1256")
    doc = extract_document(csv_path)
    assert doc.kind == "csv" and [b["relevant"] for b in doc.boq_items] == [True, False]
    assert doc.boq_items[0]["amount"] == 1350

    from PIL import Image

    image = Image.new("RGB", (64, 48), "white")
    exif = Image.Exif()
    exif[0x010F] = "Canon"
    exif[0x0110] = "EOS R6"
    photo = tmp_path / "IMG_2041.jpg"
    image.save(photo, exif=exif)
    doc = extract_document(photo)
    assert doc.kind == "image" and doc.doc_kind == "photo"
    assert doc.meta["width"] == 64 and doc.meta["camera"] == "Canon EOS R6"
    assert any("no OCR" in w for w in doc.warnings)


def test_zip_safe_extraction_and_recursion(files, tmp_path):
    archive = fx.make_zip_with_slip(tmp_path / "Tender docs.zip", {
        "Tender/BOQ.xlsx": files["xlsx"].read_bytes(),
        "Tender/Drawings/A-501.pdf": files["pdf"].read_bytes(),
        "Tender/nested.zip": fx.zip_bytes({"site photo.png": b"\x89PNG\r\n\x1a\n not really"}),
        "readme.txt": b"Site visit on 2 September.",
    })
    doc = extract_document(archive)
    assert doc.kind == "archive"
    names = sorted(m["name"] for m in doc.meta["members"])
    assert names == ["Tender/BOQ.xlsx", "Tender/Drawings/A-501.pdf", "Tender/nested.zip", "readme.txt"]
    warnings = " ".join(doc.warnings)
    assert "zip-slip" in warnings and "../../evil.txt" in warnings and "/tmp/absolute-evil.txt" in warnings
    assert "setup.exe" in warnings and "disguised.pdf" in warnings
    assert not (tmp_path / "evil.txt").exists() and not (tmp_path.parent / "evil.txt").exists()
    unpacked = Path(doc.meta["extracted_to"])
    assert unpacked == tmp_path / "Tender docs.zip_unpacked"
    assert all(str(p.resolve()).startswith(str(unpacked)) for p in unpacked.rglob("*"))
    kinds = {c.name: (c.kind, c.doc_kind) for c in doc.children}
    assert kinds["Tender/BOQ.xlsx"] == ("spreadsheet", "boq") and kinds["Tender/Drawings/A-501.pdf"][0] == "pdf"
    nested = next(c for c in doc.children if c.name == "Tender/nested.zip")
    assert nested.kind == "archive" and nested.meta["member_count"] == 1
    assert any(b["source"] == "Tender/BOQ.xlsx" and b["relevant"] for b in doc.boq_items)
    assert "=== Tender/BOQ.xlsx ===" in doc.text


def test_eml_with_attachment(files, tmp_path):
    eml = fx.make_eml(tmp_path / "rfq.eml", "BOQ.xlsx", files["xlsx"].read_bytes(),
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    doc = extract_document(eml)
    assert doc.kind == "email" and doc.doc_kind == "correspondence"
    assert doc.meta["subject"] == "RFQ – BMU (طلب تسعير)" and doc.meta["from"] == "a.engineer@contractor.example"
    assert [a["name"] for a in doc.meta["attachments"]] == ["BOQ.xlsx"]
    [child] = doc.children
    assert child.kind == "spreadsheet" and child.doc_kind == "boq"
    assert any(b["relevant"] and b["source"] == "BOQ.xlsx" for b in doc.boq_items)
    assert "Please find the BOQ attached" in doc.text and "=== attachment: BOQ.xlsx ===" in doc.text

    canned = tmp_path / "rfq_arabic.eml"
    shutil.copy(Path(__file__).resolve().parent / "fixtures" / "rfq_arabic.eml", canned)
    doc = extract_document(canned)
    assert doc.meta["from_name"] == "محمد إبراهيم" and "وحدة صيانة المباني" in doc.meta["subject"]
    assert [c.name for c in doc.children] == ["BOQ - جدول الكميات.pdf", "attachment-2.eml"]


def test_msg_mapping_with_extract_msg_stub(files, tmp_path, monkeypatch):
    """Outlook .msg files are read through extract-msg; its object is stubbed (no .msg writer exists)."""
    import extract_msg

    class Attachment:
        def __init__(self, name, data):
            self.longFilename, self.shortFilename, self.data = name, None, data

    class Message:
        sender = "Ali K. <ali.k@contractor.example>"
        to = "Sales <sales@medmack.com>; tenders@medmack.com"
        cc = None
        subject = "FW: Addendum 2 – BMU"
        date = None
        messageId = "<msg-1@contractor.example>"
        body = "Please see the revised BOQ."
        htmlBody = None
        attachments = [Attachment("BOQ rev2.xlsx", files["xlsx"].read_bytes()), Attachment("viewer.exe", b"MZ..")]
        closed = False

        def close(self):
            Message.closed = True

    monkeypatch.setattr(extract_msg, "openMsg", lambda path: Message())
    msg_path = tmp_path / "FW Addendum 2.msg"
    msg_path.write_bytes(b"\xd0\xcf\x11\xe0 stub")
    doc = extract_document(msg_path)
    assert doc.kind == "email" and doc.doc_kind == "correspondence" and Message.closed
    assert doc.meta["from"] == "ali.k@contractor.example" and doc.meta["to"] == ["sales@medmack.com", "tenders@medmack.com"]
    assert [c.name for c in doc.children] == ["BOQ rev2.xlsx"]
    assert any("viewer.exe" in w for w in doc.warnings)
    assert any(b["relevant"] and b["source"] == "BOQ rev2.xlsx" for b in doc.boq_items)


def test_cad_files(tmp_path):
    dxf = fx.make_dxf(tmp_path / "Roof BMU.dxf")
    doc = extract_document(dxf)
    assert doc.kind == "cad" and doc.doc_kind == "cad"
    assert doc.text.splitlines() == ["ROOF BMU LAYOUT", "BMU TRACK", "DETAIL A Ø50", "DWG_NO: A-501", "مقياس 1:100"]
    assert doc.meta["release"] == "AutoCAD 2013" and any("needs CAD viewer" in w for w in doc.warnings)

    dwg = tmp_path / "A-501.dwg"
    dwg.write_bytes(b"AC1032" + b"\x00" * 64)
    doc = extract_document(dwg)
    assert doc.kind == "cad" and doc.meta["release"] == "AutoCAD 2018" and doc.pages == []

    ifc = tmp_path / "Tower.ifc"
    ifc.write_text("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition'),'2;1');\n"
                   "FILE_NAME('Tower.ifc','2026-08-20T10:00:00',('UE'),('UE'),'IFC Engine','Revit 2025','');\n"
                   "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('2Xn$',#2,'Harbour Tower',$,$,$,$,$,$);\n"
                   "#9=IFCBUILDING('3Yz$',#2,'Tower A',$,$,$,$,$,.ELEMENT.,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n")
    doc = extract_document(ifc)
    assert doc.meta["schema"] == "IFC4" and doc.meta["project"] == "Harbour Tower" and "Building: Tower A" in doc.text


def test_unsupported_and_corrupt_inputs(tmp_path):
    legacy = tmp_path / "old.doc"
    legacy.write_bytes(b"\xd0\xcf\x11\xe0 legacy word")
    doc = extract_document(legacy)
    assert doc.kind == "unsupported" and "legacy .doc" in doc.warnings[0]

    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4\n garbage")
    doc = extract_document(broken)
    assert doc.kind == "pdf" and doc.warnings  # reported, not raised

    xls = tmp_path / "old.xls"
    xls.write_bytes(b"\xd0\xcf\x11\xe0")
    assert any("xlrd" in w for w in extract_document(xls).warnings)

    bare = tmp_path / "download"
    bare.write_bytes(fx.zip_bytes({"word/document.xml": b"<w/>"}))
    assert detect_kind(bare) == "docx"
    with pytest.raises(FileNotFoundError):
        extract_document(tmp_path / "missing.pdf")


@pytest.mark.parametrize("name,text,expected", [
    ("A-101 Rev B.pdf", "DRAWING NO A-101 SCALE 1:100 CHECKED", "drawing"),
    ("Tender drawings.pdf", "", "drawing"),
    ("BOQ - Div 11.xlsx", "", "boq"),
    ("Section 11 24 23 BMU spec.pdf", "", "specification"),
    ("doc.pdf", "SECTION 11 24 23\nPART 1 - GENERAL\n1.1 SUMMARY\nA. Section includes BMU.\nSUBMITTALS", "specification"),
    ("Addendum 2 - Revised BOQ.xlsx", "", "addendum"),
    ("notice.pdf", "ADDENDUM NO. 3\nThe closing date is extended", "addendum"),
    ("RFQ-2026-118.pdf", "", "tender_doc"),
    ("instructions.pdf", "INVITATION TO TENDER ... Instructions to Tenderers ... Form of Tender", "tender_doc"),
    ("IMG_1234.jpg", "", "photo"),
    ("WhatsApp Image 2026-08-26.jpeg", "", "photo"),
    ("Roof.dwg", "", "cad"),
    ("Fwd RFQ.msg", "", "correspondence"),
    ("letter.pdf", "Dear Sir,\nWe are pleased ...\nYours faithfully", "correspondence"),
    ("notes.txt", "random words", "other"),
])
def test_classify_document(name, text, expected):
    assert classify_document(name, text) == expected
