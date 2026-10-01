"""Product reference photos (builder v1.4.0): JPEG, longest edge at most 1600 px, ~85% quality.

A quotation may carry ``photos = [{"path" | "data_url", "caption", "placement"}]`` where
``placement`` is ``"annex"`` (default: a "Product Reference Annex" page after the quotation, two
photos per page) or ``{"page": n, "x_mm", "y_mm", "width_mm"}`` to place it on a quotation page.
A placed photo that would collide with the letterhead, the text, the stamp or the logo moves to
the nearest free spot, or to the annex when there is none (checked in the browser at layout time).
"""
from __future__ import annotations

import base64
import hashlib
import io
import re
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from PIL import Image, ImageOps

MAX_EDGE = 1600
QUALITY = 85
MAX_SOURCE_BYTES = 40 * 1024 * 1024
DEFAULT_PLACEMENT = {"page": 1, "x": 137.0, "y": 58.0, "width": 55.0}  # builder ReferencePhotos


@dataclass(frozen=True)
class NormalizedPhoto:
    jpeg: bytes
    width: int
    height: int

    @property
    def data_uri(self) -> str:
        return "data:image/jpeg;base64," + base64.b64encode(self.jpeg).decode("ascii")


_CACHE: "OrderedDict[tuple[str, int, int], NormalizedPhoto]" = OrderedDict()  # previews re-render often


def _normalize_bytes(data: bytes, max_edge: int, quality: int) -> NormalizedPhoto:
    key = (hashlib.sha256(data).hexdigest(), max_edge, quality)
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    photo = _encode(data, max_edge, quality)
    _CACHE[key] = photo
    while len(_CACHE) > 32:
        _CACHE.popitem(last=False)
    return photo


def _encode(data: bytes, max_edge: int, quality: int) -> NormalizedPhoto:
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source)
        image.load()
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        flat = Image.new("RGB", image.size, (255, 255, 255))
        flat.paste(image, mask=image.getchannel("A"))
        image = flat
    else:
        image = image.convert("RGB")
    image.thumbnail((max_edge, max_edge), Image.LANCZOS)
    out = io.BytesIO()
    image.save(out, "JPEG", quality=quality, optimize=True)
    return NormalizedPhoto(out.getvalue(), image.width, image.height)


def normalize_photo(source: Path | str | bytes, *, max_edge: int = MAX_EDGE, quality: int = QUALITY) -> NormalizedPhoto:
    """A photo (file path, ``data:image/...`` URL or raw bytes) as a compact upright JPEG.

    Raises ``ValueError`` when it is not a readable image.
    """
    if isinstance(source, bytes):
        data = source
    elif isinstance(source, str) and source.startswith("data:"):
        match = re.match(r"^data:image/[a-z0-9.+-]+;base64,(.+)$", source, re.I | re.S)
        if not match:
            raise ValueError("Unsupported data URL for a reference photo")
        data = base64.b64decode(match.group(1), validate=False)
    else:
        path = Path(source)
        if not path.is_file():
            raise ValueError(f"Reference photo not found: {path.name}")
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError(f"Reference photo is too large: {path.name}")
        data = path.read_bytes()
    if len(data) > MAX_SOURCE_BYTES:
        raise ValueError("Reference photo is too large")
    try:
        return _normalize_bytes(data, max_edge, quality)
    except Exception as exc:
        raise ValueError(f"Reference photo could not be read as an image ({exc.__class__.__name__})") from exc


def _num(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if number == number else fallback  # NaN guard


def normalize_placement(value: Any) -> dict[str, Any]:
    """``"annex"`` or ``{"page", "x_mm", "y_mm", "width_mm"}`` -> the builder's placement record."""
    if not isinstance(value, Mapping):
        return {"mode": "annex", **DEFAULT_PLACEMENT}
    return {
        "mode": "page" if str(value.get("mode", "page")) != "annex" else "annex",
        "page": max(1, int(_num(value.get("page"), 1))),
        "x": round(_num(value.get("x_mm", value.get("x")), DEFAULT_PLACEMENT["x"]), 1),
        "y": round(_num(value.get("y_mm", value.get("y")), DEFAULT_PLACEMENT["y"]), 1),
        "width": round(min(100.0, max(25.0, _num(value.get("width_mm", value.get("width")), 55.0))), 1),
    }
