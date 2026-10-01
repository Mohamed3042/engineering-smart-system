"""Letterhead assets for quotation PDFs.

The company's real letterhead, stamp and signatures are private: they live only in the
git-ignored data directory::

    <private_dir>/letterhead/header.(jpg|png)    the "default" paper: printed on every page
    <private_dir>/letterhead/footer.(jpg|png)
    <private_dir>/letterhead/stamp.png           company stamp (every page, unless hidden)
    <private_dir>/letterhead/watermark.png       faint logo behind the text (optional)
    <private_dir>/letterhead/letterhead.json     optional: paper colour and placement overrides
    <private_dir>/papers/<paper_id>/...          more papers (see ess.quotation.papers)
    <private_dir>/signatures/<INITIALS>.png      signature of that representative

Anything missing falls back to a *neutral default*: a plain header with the workspace company
name, no stamp, no signature image, and a small "Specimen" note in the footer. ``status`` tells
the UI exactly which parts are real so it can warn before anything is sent.

Images are embedded as data URIs, so the rendered HTML is self-contained (no file paths).
"""
from __future__ import annotations

import base64
import hashlib
import io
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image

from .papers import DEFAULT_PAPER_ID, default_paper_id, find_image, get_paper, list_papers

_IMAGE_NAMES = {
    "header": ("header.jpg", "header.jpeg", "header.png"),
    "footer": ("footer.jpg", "footer.jpeg", "footer.png"),
    "stamp": ("stamp.png",),
    "watermark": ("watermark.png",),
}
_MAX_BYTES = 12 * 1024 * 1024

SPECIMEN_NOTE = "Specimen – company letterhead not installed"

# Placement used by the Medmack Quotation Builder (app/quotation.html, app/stamp.js), in mm.
DEFAULT_GEOMETRY: dict[str, dict[str, float]] = {
    "header": {"left_mm": 6.4, "top_mm": 4.7, "width_mm": 198.4, "height_mm": 198.4 * 450 / 2335},
    "footer": {"left_mm": 6.4, "bottom_mm": 0.9, "width_mm": 198.4, "height_mm": 198.4 * 300 / 2335},
    "watermark": {"left_mm": 38.0, "top_mm": 101.0, "width_mm": 135.0, "opacity": 0.07},
    "stamp": {"x_mm": 40.0, "y_mm": 232.0, "width_mm": 36.0},
}


@dataclass(frozen=True)
class ImageAsset:
    kind: str
    filename: str
    mime: str
    width_px: int
    height_px: int
    data_uri: str = field(repr=False)
    sha256: str = ""

    @property
    def aspect(self) -> float:
        return self.height_px / self.width_px if self.width_px else 1.0


def _read_image(path: Path, kind: str, warnings: list[str]) -> tuple[ImageAsset | None, Image.Image | None]:
    try:
        data = path.read_bytes()
        if len(data) > _MAX_BYTES:
            warnings.append(f"{kind}: {path.name} is larger than {_MAX_BYTES // (1024 * 1024)} MB and was ignored.")
            return None, None
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # unreadable / not an image
        warnings.append(f"{kind}: {path.name} could not be read as an image ({exc.__class__.__name__}).")
        return None, None
    mime = Image.MIME.get(image.format or "", "image/png")
    asset = ImageAsset(
        kind=kind,
        filename=path.name,
        mime=mime,
        width_px=image.width,
        height_px=image.height,
        data_uri=f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}",
        sha256=hashlib.sha256(data).hexdigest(),
    )
    return asset, image


def _hex(value: Any) -> str | None:
    text = str(value or "").strip()
    return text.upper() if re.fullmatch(r"#[0-9A-Fa-f]{6}", text) else None


def _paper_from(image: Image.Image) -> str:
    """Paper colour of a scanned (opaque) letterhead band: its most common light border colour,
    nudged a hair darker so the ``darken`` blend leaves only the ink (no visible box)."""
    rgb = image.convert("RGB")
    rgb.thumbnail((600, 600))
    w, h = rgb.size
    border = [rgb.getpixel((x, y)) for x in range(w) for y in (0, 1, h - 2, h - 1)]
    border += [rgb.getpixel((x, y)) for y in range(h) for x in (0, 1, w - 2, w - 1)]
    light = [px for px in border if sum(px) / 3 > 200] or border
    r, g, b = Counter(light).most_common(1)[0][0]
    return "#{:02X}{:02X}{:02X}".format(max(0, r - 1), max(0, g - 2), max(0, b - 2))


def _number(value: Any, low: float, high: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if low <= number <= high else None


def _merge_geometry(overrides: Any) -> dict[str, Any]:
    geometry: dict[str, Any] = {k: dict(v) for k, v in DEFAULT_GEOMETRY.items()}
    if not isinstance(overrides, dict):
        return geometry
    for part, values in geometry.items():
        given = overrides.get(part)
        if not isinstance(given, dict):
            continue
        for key in list(values):
            number = _number(given.get(key), *((0.0, 1.0) if key == "opacity" else (0.0, 297.0)))
            if number is not None:
                values[key] = number
        if part in ("header", "footer"):
            values["_given_height"] = _number(given.get("height_mm"), 0.0, 120.0) is not None
    for key in ("content_top_mm", "content_bottom_mm"):
        number = _number(overrides.get(key), 0.0, 200.0)
        if number is not None:
            geometry[key] = number
    return geometry


def _safe_initials(initials: str | None) -> str | None:
    letters = re.sub(r"[^A-Za-z]", "", str(initials or "")).upper()
    return letters[:5] or None


@dataclass
class LetterheadAssets:
    company_name: str
    initials: str | None = None
    header: ImageAsset | None = None
    footer: ImageAsset | None = None
    stamp: ImageAsset | None = None
    watermark: ImageAsset | None = None
    signature: ImageAsset | None = None
    paper: str = "#FFFFFF"
    geometry: dict[str, Any] = field(default_factory=lambda: _merge_geometry(None))
    warnings: list[str] = field(default_factory=list)
    paper_id: str = DEFAULT_PAPER_ID
    paper_name: str | None = None
    mode: str = "letterhead"  # "letterhead" | "preprinted"
    paper_found: bool = False

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, private_dir: Path | str | None, company_name: str, initials: str | None = None,
             paper_id: str | None = None) -> "LetterheadAssets":
        """Real assets of a paper from ``private_dir`` where present, the neutral default elsewhere.

        ``paper_id`` picks one of ``list_papers(private_dir)``; ``None`` / ``"default"`` is the
        ``letterhead/`` folder. An unknown paper falls back to the neutral default with a warning.
        """
        warnings: list[str] = []
        root = Path(private_dir) if private_dir else None
        wanted = (paper_id or DEFAULT_PAPER_ID).strip().lower()
        paper = get_paper(root, wanted) if root else None
        if paper is None and paper_id is None and root:
            # No legacy letterhead/ folder: preselect the first full letterhead paper, if any.
            fallback = default_paper_id(list_papers(root))
            paper = get_paper(root, fallback) if fallback else None
            wanted = paper.id if paper else wanted
        if paper is None and wanted != DEFAULT_PAPER_ID:
            warnings.append(f"Paper '{wanted}' is not installed: PDFs use a neutral specimen letterhead.")
        if paper is not None:
            warnings.extend(paper.warnings)
        directory = paper.directory if paper else None
        mode = paper.mode if paper else "letterhead"
        geometry = _merge_geometry(paper.geometry if paper else None)

        found: dict[str, ImageAsset | None] = dict.fromkeys(_IMAGE_NAMES)
        images: dict[str, Image.Image | None] = dict.fromkeys(_IMAGE_NAMES)
        for kind, names in _IMAGE_NAMES.items():
            path = find_image(directory, names)
            if path is None:
                continue
            asset, image = _read_image(path, kind, warnings)
            images[kind] = image
            # Pre-printed paper: the sheet already carries header, footer and logo; only the stamp prints.
            if mode == "letterhead" or kind == "stamp":
                found[kind] = asset

        for band in ("header", "footer"):  # band heights decide where the text box starts / ends
            spec = geometry[band]
            if not spec.pop("_given_height", False) and images[band] is not None:
                spec["height_mm"] = spec["width_mm"] * images[band].height / max(1, images[band].width)

        safe = _safe_initials(initials)
        signature = None
        if safe and root:
            sig_path = find_image(root / "signatures", (f"{safe.lower()}.png",))
            if sig_path:
                signature, _ = _read_image(sig_path, "signature", warnings)

        paper_colour = _hex((paper.geometry if paper else {}).get("paper"))
        if not paper_colour:
            paper_colour = "#FFFFFF"
            if mode == "letterhead" and found["header"] is not None and found["header"].mime == "image/jpeg":
                paper_colour = _paper_from(images["header"])
        if mode == "preprinted":
            paper_colour = "#FFFFFF"  # body only, on the company's own sheet

        return cls(
            company_name=(company_name or (paper.company_name if paper else "") or "").strip(),
            initials=safe,
            header=found["header"],
            footer=found["footer"],
            stamp=found["stamp"],
            watermark=found["watermark"],
            signature=signature,
            paper=paper_colour,
            geometry=geometry,
            warnings=warnings,
            paper_id=paper.id if paper else wanted,
            paper_name=paper.name if paper else None,
            mode=mode,
            paper_found=paper is not None,
        )

    @classmethod
    def neutral(cls, company_name: str, initials: str | None = None) -> "LetterheadAssets":
        """The neutral default letterhead only (nothing private)."""
        return cls(company_name=(company_name or "").strip(), initials=_safe_initials(initials))

    # ------------------------------------------------------------------ status
    @property
    def preprinted(self) -> bool:
        return self.mode == "preprinted"

    @property
    def letterhead_installed(self) -> bool:
        return self.preprinted or (self.header is not None and self.footer is not None)

    @property
    def status(self) -> dict[str, Any]:
        """Which parts are real and which are the neutral default; ``warnings`` is UI-ready."""
        warnings = list(self.warnings)
        if not self.letterhead_installed:
            missing = [k for k in ("header", "footer") if getattr(self, k) is None]
            warnings.append("Company letterhead not installed (" + ", ".join(missing) + "): "
                            "PDFs use a neutral specimen letterhead.")
        if self.stamp is None:
            warnings.append("Company stamp not installed: PDFs print without a stamp.")
        if self.signature is None:
            who = self.initials or "the signatory"
            warnings.append(f"No signature image for {who}: the signature space is left blank.")
        if self.preprinted:
            warnings.append("Pre-printed paper: only the body prints; load the company's own paper in the printer.")
        band = "preprinted" if self.preprinted else None
        return {
            "paper_id": self.paper_id,
            "paper_name": self.paper_name,
            "paper_found": self.paper_found,
            "mode": self.mode,
            "header": band or ("real" if self.header else "default"),
            "footer": band or ("real" if self.footer else "default"),
            "watermark": band or ("real" if self.watermark else "missing"),
            "stamp": "real" if self.stamp else "missing",
            "signature": "real" if self.signature else "missing",
            "signature_initials": self.initials if self.signature else None,
            "letterhead_installed": self.letterhead_installed,
            "paper": self.paper,
            "warnings": warnings,
        }

    # ------------------------------------------------------------------ helpers for the renderer
    def signature_for(self, initials: str | None) -> ImageAsset | None:
        """The signature image, only when it belongs to these initials."""
        if self.signature is None or not self.initials:
            return None
        return self.signature if _safe_initials(initials) == self.initials else None

    @property
    def header_height_mm(self) -> float:
        return float(self.geometry["header"]["height_mm"])

    @property
    def footer_height_mm(self) -> float:
        return float(self.geometry["footer"]["height_mm"])

    @property
    def content_top_mm(self) -> float:
        """Where the text starts: 51 mm in the builder, lower for a taller header."""
        if "content_top_mm" in self.geometry:
            return round(float(self.geometry["content_top_mm"]), 2)
        return round(max(51.0, self.geometry["header"]["top_mm"] + self.header_height_mm + 8.0), 2)

    @property
    def content_bottom_mm(self) -> float:
        """Distance of the text box from the bottom edge: 31 mm in the builder."""
        if "content_bottom_mm" in self.geometry:
            return round(float(self.geometry["content_bottom_mm"]), 2)
        return round(max(31.0, self.geometry["footer"]["bottom_mm"] + self.footer_height_mm + 4.6), 2)

    @property
    def footer_top_mm(self) -> float:
        return 297.0 - self.geometry["footer"]["bottom_mm"] - self.footer_height_mm
