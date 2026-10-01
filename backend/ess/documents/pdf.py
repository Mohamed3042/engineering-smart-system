"""PDF text extraction (pypdf, pypdfium2 fallback), drawing-page detection and page rendering."""
from __future__ import annotations

import io
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .boq import parse_boq_text

__all__ = ["drawing_score", "extract_pdf", "render_pdf_page", "sheet_size"]

_PDFIUM_LOCK = threading.Lock()  # pdfium is not thread-safe
_SLOW_PAGE_S = 4.0  # a pypdf page slower than this switches the rest of the file to pdfium
_SLOW_TOTAL_S = 90.0

_ISO = {"A0": (841, 1189), "A1": (594, 841), "A2": (420, 594), "A3": (297, 420), "A4": (210, 297), "A5": (148, 210)}
_US = {
    "ANSI A": (216, 279), "ANSI B": (279, 432), "ANSI C": (432, 559), "ANSI D": (559, 864), "ANSI E": (864, 1118),
    "ARCH A": (229, 305), "ARCH B": (305, 457), "ARCH C": (457, 610), "ARCH D": (610, 914), "ARCH E": (914, 1219),
    "ARCH E1": (762, 1067),
}
_LARGE_SHEETS = {"A0", "A1", "A2", "ANSI D", "ANSI E", "ARCH D", "ARCH E", "ARCH E1", "ARCH C", "ANSI C", "oversize"}
_MEDIUM_SHEETS = {"A3", "ANSI B", "ARCH B"}
_TITLE_BLOCK_RES = [
    re.compile(p, re.I)
    for p in (
        r"\b(drawing|dwg|drg)\.?\s*(no|number|nr|#)\b",
        r"\bscale\b",
        r"\brev(\.|ision)?\b",
        r"\bchecked\b",
        r"\bdrawn\b",
        r"\bapproved\b",
        r"\bdesigned\b",
        r"\bproject\b",
        r"\bsheet\b",
        r"\btitle\b",
        r"\bclient\b|\bowner\b",
        r"\bconsultant\b",
        r"\bnorth\b|\bkey\s*plan\b",
        r"\bissued?\s+for\b|\bstatus\b",
        r"\bnot\s+to\s+scale\b|\bn\.?t\.?s\.?\b",
        r"مقياس\s*الرسم|رقم\s*اللوحة|اللوحة|المشروع|الاستشاري|المالك",
    )
]
_SCALE_RE = re.compile(r"\b1\s?:\s?\d{1,4}\b")


def sheet_size(width_pt: float, height_pt: float) -> str | None:
    """Paper name (``A1``, ``ANSI D`` ...) for a page size in points, ``oversize`` above A0."""
    w_mm, h_mm = sorted((width_pt * 25.4 / 72.0, height_pt * 25.4 / 72.0))
    for table in (_ISO, _US):
        for name, (sw, sh) in table.items():
            tol_w, tol_h = max(6.0, sw * 0.03), max(6.0, sh * 0.03)
            if abs(w_mm - sw) <= tol_w and abs(h_mm - sh) <= tol_h:
                return name
    if w_mm > 860 or h_mm > 1220:
        return "oversize"
    return None


def drawing_score(text: str, width_pt: float, height_pt: float) -> int:
    """Higher means more drawing-like: big sheet, title-block words, scale, sparse text."""
    sheet = sheet_size(width_pt, height_pt)
    w_mm, h_mm = sorted((width_pt * 25.4 / 72.0, height_pt * 25.4 / 72.0))
    score = 0
    if sheet in _LARGE_SHEETS or (sheet is None and w_mm >= 400):
        score += 2
    elif sheet in _MEDIUM_SHEETS or (sheet is None and w_mm >= 280 and h_mm >= 400):
        score += 1
    hits = sum(1 for rx in _TITLE_BLOCK_RES if rx.search(text))
    if hits >= 4:
        score += 2
    elif hits >= 2:
        score += 1
    if _SCALE_RE.search(text):
        score += 1
    area_in2 = max((width_pt / 72.0) * (height_pt / 72.0), 1.0)
    density = len(re.sub(r"\s+", "", text)) / area_in2
    if density < 6:
        score += 1
    elif density > 25:
        score -= 2
    return score


def _pdf_date(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    if not value:
        return None
    match = re.match(r"D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?", str(value))
    if not match:
        return None
    parts = [int(p) if p else d for p, d in zip(match.groups(), (1970, 1, 1, 0, 0, 0))]
    try:
        return datetime(*parts).isoformat()
    except ValueError:
        return None


def _image_count(page: Any) -> list[dict]:
    images: list[dict] = []
    try:
        resources = page.get("/Resources") or {}
        resources = resources.get_object() if hasattr(resources, "get_object") else resources
        xobjects = resources.get("/XObject") or {}
        xobjects = xobjects.get_object() if hasattr(xobjects, "get_object") else xobjects
        for name, ref in list(xobjects.items())[:50]:
            obj = ref.get_object()
            if obj.get("/Subtype") == "/Image":
                images.append({"name": str(name).lstrip("/"), "width": int(obj.get("/Width", 0) or 0),
                               "height": int(obj.get("/Height", 0) or 0)})
    except Exception:
        pass
    return images


def extract_pdf(path: Path, *, max_pages: int = 2000) -> dict:
    """Return the parts of a DocExtract for a PDF."""
    from pypdf import PdfReader

    warnings: list[str] = []
    meta: dict[str, Any] = {}
    pages: list[dict] = []
    tables: list[dict] = []
    boq_items: list[dict] = []
    images: list[dict] = []
    reader = None
    try:
        reader = PdfReader(str(path), strict=False)
        if reader.is_encrypted:
            try:
                ok = reader.decrypt("")
            except Exception:
                ok = 0
            if not ok:
                warnings.append("PDF is password-protected; text could not be read")
                reader = None
    except Exception as exc:
        warnings.append(f"pypdf could not open the file ({type(exc).__name__}: {exc}); using pdfium")
        reader = None

    pdfium_doc = None

    def pdfium_text(index: int) -> tuple[str, float, float]:
        nonlocal pdfium_doc
        import pypdfium2 as pdfium

        with _PDFIUM_LOCK:
            if pdfium_doc is None:
                pdfium_doc = pdfium.PdfDocument(str(path))
            page = pdfium_doc[index]
            try:
                width, height = page.get_size()
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range() or ""
                finally:
                    textpage.close()
            finally:
                page.close()
        return text.replace("\r\n", "\n").replace("\r", "\n"), float(width), float(height)

    try:
        if reader is not None:
            meta_obj = None
            try:
                meta_obj = reader.metadata
            except Exception:
                pass
            count = len(reader.pages)
            if meta_obj:
                meta["author"] = (meta_obj.get("/Author") or None) and str(meta_obj.get("/Author"))
                meta["title"] = (meta_obj.get("/Title") or None) and str(meta_obj.get("/Title"))
                meta["created"] = _pdf_date(meta_obj.get("/CreationDate"))
                meta["producer"] = (meta_obj.get("/Producer") or None) and str(meta_obj.get("/Producer"))
                meta["creator"] = (meta_obj.get("/Creator") or None) and str(meta_obj.get("/Creator"))
        else:
            import pypdfium2 as pdfium

            with _PDFIUM_LOCK:
                pdfium_doc = pdfium.PdfDocument(str(path))
                count = len(pdfium_doc)
        meta["pages"] = count
        if count > max_pages:
            warnings.append(f"only the first {max_pages} of {count} pages were read")
        use_pdfium = reader is None
        started = time.monotonic()
        for index in range(min(count, max_pages)):
            text = ""
            width = height = 0.0
            page = None
            if not use_pdfium:
                page = reader.pages[index]
                try:
                    box = page.mediabox
                    width, height = float(box.width), float(box.height)
                except Exception:
                    width, height = 595.0, 842.0
                t0 = time.monotonic()
                try:
                    text = page.extract_text() or ""
                except Exception as exc:
                    warnings.append(f"page {index + 1}: pypdf failed ({type(exc).__name__}); used pdfium")
                    text = ""
                took = time.monotonic() - t0
                if took > _SLOW_PAGE_S or time.monotonic() - started > _SLOW_TOTAL_S:
                    use_pdfium = True  # complex vector drawings: pdfium is much faster
                images += [{**img, "page": index + 1} for img in _image_count(page)][:20]
            if use_pdfium or len(text.strip()) < 15:
                try:
                    alt, w2, h2 = pdfium_text(index)
                    if len(alt.strip()) > len(text.strip()):
                        text = alt
                    if not width:
                        width, height = w2, h2
                except Exception as exc:
                    if not text:
                        warnings.append(f"page {index + 1}: no text ({type(exc).__name__})")
            sheet = sheet_size(width, height) if width else None
            score = drawing_score(text, width, height) if width else 0
            pages.append(
                {
                    "n": index + 1,
                    "text": text,
                    "is_drawing_like": score >= 3,
                    "width_mm": round(width * 25.4 / 72.0, 1) if width else None,
                    "height_mm": round(height * 25.4 / 72.0, 1) if height else None,
                    "sheet": sheet,
                    "chars": len(text.strip()),
                }
            )
            if page is not None and re.search(r"\b(qty|quantity|amount|unit\s*rate|الكمية)\b", text, re.I):
                try:
                    layout = page.extract_text(extraction_mode="layout") or ""
                except Exception:
                    layout = ""
                found, rows = parse_boq_text(layout, page=index + 1)
                if found:
                    boq_items += found
                    tables.append({"name": f"page {index + 1}", "page": index + 1, "rows": rows})
    finally:
        if pdfium_doc is not None:
            with _PDFIUM_LOCK:
                pdfium_doc.close()

    total_chars = sum(p["chars"] for p in pages)
    if pages and total_chars < 20 * len(pages):
        warnings.append("little or no text layer (scanned drawings or images): needs OCR or visual review")
    drawing_pages = [p["n"] for p in pages if p["is_drawing_like"]]
    meta["drawing_pages"] = drawing_pages
    sheets = sorted({p["sheet"] for p in pages if p.get("sheet")})
    meta["sheet_sizes"] = sheets
    return {
        "pages": pages,
        "tables": tables,
        "boq_items": boq_items,
        "images": images[:200],
        "meta": meta,
        "warnings": warnings,
        "text": "\n\f\n".join(p["text"] for p in pages),
    }


def render_pdf_page(path: str | Path, page_number: int, dpi: int = 110, *, max_pixels: int = 40_000_000) -> bytes:
    """PNG bytes of page ``page_number`` (**1-based**, like ``pages[i]["n"]``)."""
    import pypdfium2 as pdfium

    if page_number < 1:
        raise IndexError("page_number is 1-based")
    with _PDFIUM_LOCK:
        pdf = pdfium.PdfDocument(str(path))
        try:
            if page_number > len(pdf):
                raise IndexError(f"page {page_number} out of range (document has {len(pdf)} pages)")
            page = pdf[page_number - 1]
            try:
                width, height = page.get_size()
                scale = max(dpi, 10) / 72.0
                pixels = width * scale * height * scale
                if pixels > max_pixels:  # A0 sheets at high dpi: keep memory bounded
                    scale *= (max_pixels / pixels) ** 0.5
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            pdf.close()
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=False)
    return buf.getvalue()
