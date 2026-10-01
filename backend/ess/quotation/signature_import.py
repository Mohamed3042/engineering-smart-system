"""Signature import from a photo or scan of a signed letter (port of the builder's app/detect.js).

Everything printed on the company's letters (letterhead, body, footer) is brown or black on cream
paper, so its blue channel is never higher than its red channel. Pen ink and the company stamp are
blue: ``b - r > 20`` separates them from the rest of the page before any shape analysis. The dense,
round ink group is the stamp; the rest is the signature. The cut keeps the original pixels and
makes the paper transparent (alpha from how blue each pixel is); the stamp is erased from the cut.

Black pen cannot be told apart from printed text by colour. Automatic detection then finds
nothing and :func:`extract_signature` raises :class:`SignatureNotFound` (the builder reports 0%).
Passing ``crop_box`` (a box the user drew) cuts it anyway: inside a hand-drawn box the ink is keyed
on blueness when the box holds blue ink, otherwise on darkness (black pen).

    png = extract_signature(open("signed-letter.jpg", "rb").read())
    (private_dir / "signatures" / "AA.png").write_bytes(png)
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

from PIL import Image, ImageChops, ImageOps

BLUE_MIN = 20     # b - r needed to call a pixel ink
NORM_W = 1600     # detection resolution, so thresholds are size-independent
CELL = 8          # grid cell (px, at NORM_W) used for connected components
CELL_INK = 0.06   # fraction of a cell that must be ink for the cell to count
BRIDGE = 2        # cells: gaps this small are treated as one stroke
MIN_INK = 250     # components smaller than this are noise (dust, pen dots)
DENSE = 0.16      # ink / bbox area above this reads as a stamp, not a signature
PAD = 0.04        # padding added around the signature crop

Box = tuple[int, int, int, int]  # x, y, w, h in source pixels


class SignatureNotFound(ValueError):
    def __init__(self, notes: list[str]):
        super().__init__(" ".join(notes) or "No signature found.")
        self.notes = notes


@dataclass
class SignatureDetection:
    signature: Box | None
    stamp: Box | None
    confidence: int
    notes: list[str] = field(default_factory=list)
    ink_pixels: int = 0
    width: int = 0
    height: int = 0

    def to_dict(self) -> dict:
        return {"signature": self.signature, "stamp": self.stamp, "confidence": self.confidence,
                "notes": list(self.notes), "ink_pixels": self.ink_pixels, "size": [self.width, self.height]}


def _open(image_bytes: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            image = ImageOps.exif_transpose(source)
            image.load()
    except Exception as exc:
        raise ValueError(f"Not a readable image ({exc.__class__.__name__})") from exc
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        flat = Image.new("RGB", image.size, (255, 255, 255))
        flat.paste(image, mask=image.getchannel("A"))
        return flat
    return image.convert("RGB")


def _ink_mask(rgb: Image.Image) -> Image.Image:
    """255 where b - r > BLUE_MIN and b > 55 (the builder's inkGrid test), else 0."""
    r, _, b = rgb.split()
    blue = ImageChops.subtract(b, r).point(lambda v: 255 if v > BLUE_MIN else 0)
    bright = b.point(lambda v: 255 if v > 55 else 0)
    return ImageChops.multiply(blue, bright)


def _components(cells: list[int], gw: int, gh: int, bridge: int) -> list[dict]:
    """Connected components over the cell grid, bridging gaps up to ``bridge`` cells."""
    threshold = CELL * CELL * CELL_INK
    on = [c >= threshold for c in cells]
    seen = [False] * len(cells)
    out = []
    for start, lit in enumerate(on):
        if not lit or seen[start]:
            continue
        seen[start] = True
        queue = [start]
        x0, y0, x1, y1, ink = gw, gh, -1, -1, 0
        while queue:
            c = queue.pop()
            cx, cy = c % gw, c // gw
            ink += cells[c]
            x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
            for ny in range(max(0, cy - bridge), min(gh, cy + bridge + 1)):
                row = ny * gw
                for nx in range(max(0, cx - bridge), min(gw, cx + bridge + 1)):
                    n = row + nx
                    if on[n] and not seen[n]:
                        seen[n] = True
                        queue.append(n)
        if ink < MIN_INK:
            continue
        box = {"x": x0 * CELL, "y": y0 * CELL, "w": (x1 - x0 + 1) * CELL, "h": (y1 - y0 + 1) * CELL}
        out.append({**box, "ink": ink, "density": ink / (box["w"] * box["h"])})
    return sorted(out, key=lambda p: -p["ink"])


def _detect(rgb: Image.Image) -> SignatureDetection:
    W0, H0 = rgb.size
    scale = NORM_W / W0 if W0 > NORM_W else 1.0
    work = rgb.resize((round(W0 * scale), round(H0 * scale)), Image.BILINEAR) if scale != 1.0 else rgb
    W, H = work.size
    mask = _ink_mask(work)
    total = mask.histogram()[255]
    grid = mask.reduce(CELL)
    gw, gh = grid.size
    cells = [round(v * CELL * CELL / 255) for v in grid.tobytes()]

    def pick_stamp(parts: list[dict]) -> dict | None:
        return next((p for p in parts if p["density"] > DENSE and 0.6 < p["w"] / p["h"] < 1.7), None)

    parts = _components(cells, gw, gh, BRIDGE)
    stamp = pick_stamp(parts)
    if stamp is None:
        # A signature written across the stamp glues them into one blob; bridging less pulls the disc out.
        tight = _components(cells, gw, gh, 1)
        found = pick_stamp(tight)
        if found is not None:
            parts, stamp = tight, found
    rest = [p for p in parts if p is not stamp]

    signature = None
    notes: list[str] = []
    if rest:
        x0 = min(p["x"] for p in rest)
        y0 = min(p["y"] for p in rest)
        x1 = max(p["x"] + p["w"] for p in rest)
        y1 = max(p["y"] + p["h"] for p in rest)
        ink = sum(p["ink"] for p in rest)
        px, py = round((x1 - x0) * PAD), round((y1 - y0) * PAD)
        signature = {"x": max(0, x0 - px), "y": max(0, y0 - py), "w": min(W, x1 - x0 + 2 * px),
                     "h": min(H, y1 - y0 + 2 * py), "ink": ink}

    confidence = 0
    if signature:
        confidence = 100
        if len(rest) > 3:
            confidence -= 8 * (len(rest) - 3)
            notes.append(f"{len(rest)} separate ink groups merged — check the box covers only the signature")
        if not stamp:
            confidence -= 6
            notes.append("no round stamp found — if the page has one it may be inside the signature box")
        if signature["ink"] < 1200:
            confidence -= 15
            notes.append("very little ink — is the scan faint, or the signature in black pen?")
        if signature["y"] < H * 0.4:
            confidence -= 20
            notes.append("ink found in the top half of the page — unusual for a signature")
        if signature["w"] > W * 0.6:
            confidence -= 25
            notes.append("the box spans most of the page width")
        if stamp and not (signature["x"] + signature["w"] < stamp["x"] or stamp["x"] + stamp["w"] < signature["x"]):
            confidence -= 12
            notes.append("signature and stamp overlap horizontally — the crop may clip the stamp")
        confidence = max(0, min(100, confidence))
    else:
        notes.append("the only blue ink on this page is the stamp — nothing that looks like a signature."
                     if stamp else "no blue ink found on this page at all.")
        notes.append("A signature in black pen cannot be told apart from printed text by colour. "
                     "Draw a box around it (crop_box) instead.")

    def up(box: dict | None) -> Box | None:
        if not box:
            return None
        return (round(box["x"] / scale), round(box["y"] / scale), round(box["w"] / scale), round(box["h"] / scale))

    return SignatureDetection(up(signature), up(stamp), confidence, notes, total, W0, H0)


def detect_signature(image_bytes: bytes) -> SignatureDetection:
    """Where the signature and the stamp are on a signed letter, with a confidence and notes."""
    return _detect(_open(image_bytes))


def _clamp_box(box: tuple[float, float, float, float], width: int, height: int) -> Box:
    x, y, w, h = (int(round(float(v))) for v in box)
    x, y = max(0, min(x, width - 1)), max(0, min(y, height - 1))
    w, h = max(1, min(w, width - x)), max(1, min(h, height - y))
    return x, y, w, h


def _overlap(box: Box, other: Box | None) -> Box | None:
    """``other`` expressed inside ``box`` (crop coordinates), or ``None`` when they do not touch."""
    if other is None:
        return None
    x, y, w, h = box
    ox, oy, ow, oh = other
    if ox + ow < x or x + w < ox or oy + oh < y or y + h < oy:
        return None
    return ox - x, oy - y, ow, oh


def extract_signature(image_bytes: bytes, crop_box: tuple[float, float, float, float] | None = None) -> bytes:
    """Cut the signature out of a signed letter as a transparent PNG (original pixels).

    ``crop_box`` = ``(x, y, width, height)`` in source pixels overrides detection (a hand-drawn
    box always wins, as in the builder). Without it, a page with no blue signature ink raises
    :class:`SignatureNotFound` (black pen, or only the stamp is blue).
    """
    rgb = _open(image_bytes)
    detection = _detect(rgb)
    if crop_box is None:
        if detection.signature is None:
            raise SignatureNotFound(detection.notes)
        box = detection.signature
    else:
        box = _clamp_box(crop_box, *rgb.size)
    crop = rgb.crop((box[0], box[1], box[0] + box[2], box[1] + box[3]))
    erase = _overlap(box, detection.stamp)
    erase_rect = None
    if erase is not None:  # never carry the company stamp inside somebody's signature
        ex, ey, ew, eh = erase
        erase_rect = (max(0, ex), max(0, ey), min(crop.width, ex + ew), min(crop.height, ey + eh))
    r, _, b = crop.split()
    blueness = ImageChops.subtract(b, r)
    blue_mask = blueness.point(lambda v: 1 if v > BLUE_MIN else 0)
    if erase_rect:
        blue_mask.paste(0, erase_rect)  # stamp ink does not count as signature ink
    blue_pixels = sum(blue_mask.histogram()[1:])
    if crop_box is None or blue_pixels >= max(60, crop.width * crop.height // 1000):
        # alpha = min(1, inkness * 1.35), inkness = clamp((b - r - 6) / 50, 0, 1)  (detect.js keyInk)
        alpha = blueness.point(lambda v: round(min(1.0, max(0.0, (v - 6) / 50) * 1.35) * 255))
    else:  # hand-drawn box around black / dark ink: key on darkness instead
        alpha = crop.convert("L").point(lambda v: round(min(1.0, max(0.0, (215 - v) / 110)) * 255))
    if erase_rect:
        alpha.paste(0, erase_rect)
    cut = crop.convert("RGBA")
    cut.putalpha(alpha)
    if crop_box is not None:  # trim the empty margin of a loose hand-drawn box
        bbox = alpha.point(lambda v: 255 if v > 24 else 0).getbbox()
        if bbox:
            pad = max(2, round(max(cut.size) * 0.02))
            cut = cut.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                            min(cut.width, bbox[2] + pad), min(cut.height, bbox[3] + pad)))
    out = io.BytesIO()
    cut.save(out, "PNG", optimize=True)
    return out.getvalue()
