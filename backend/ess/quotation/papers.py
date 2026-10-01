"""Papers: the letterhead sets a workspace can print on (the builder's company-scoped papers).

    <private>/papers/<paper_id>/paper.json      {"id", "name", "company_name", "mode", "languages", "geometry"}
    <private>/papers/<paper_id>/header.(jpg|png), footer.(jpg|png), stamp.png, watermark.png

``mode`` is ``"letterhead"`` (print the full letterhead) or ``"preprinted"`` (print the body only,
on white, for feeding the company's own pre-printed paper; header and footer space stays empty
and the stamp is still controlled by the quotation, as in the builder's credit-invoice paper mode).

``geometry`` (all optional, millimetres)::

    {"paper": "#FEFDD7",
     "header": {"left_mm", "top_mm", "width_mm", "height_mm"},
     "footer": {"left_mm", "bottom_mm", "width_mm", "height_mm"},
     "watermark": {"left_mm", "top_mm", "width_mm", "opacity"},
     "stamp": {"x_mm", "y_mm", "width_mm"},
     "content_top_mm": 51, "content_bottom_mm": 31}

The older single letterhead folder ``<private>/letterhead/`` is the paper ``"default"``.
Nothing here returns file paths to callers that render pages: images are embedded later.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_PAPER_ID = "default"
MODES = ("letterhead", "preprinted")
_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_IMAGES = {
    "header": ("header.jpg", "header.jpeg", "header.png"),
    "footer": ("footer.jpg", "footer.jpeg", "footer.png"),
    "stamp": ("stamp.png",),
    "watermark": ("watermark.png",),
}


@dataclass(frozen=True)
class Paper:
    id: str
    name: str
    mode: str = "letterhead"
    company_name: str | None = None
    languages: tuple[str, ...] = ("en", "ar")
    geometry: dict[str, Any] = field(default_factory=dict)
    directory: Path | None = field(default=None, repr=False)  # private: never sent to a page
    source: str = "papers"  # "papers" | "legacy"
    files: dict[str, bool] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()

    @property
    def preprinted(self) -> bool:
        return self.mode == "preprinted"

    def supports(self, language: str | None) -> bool:
        return not self.languages or (language or "en")[:2].lower() in self.languages

    def to_dict(self) -> dict[str, Any]:
        """For the API / UI (no file paths)."""
        complete = self.preprinted or (self.files.get("header", False) and self.files.get("footer", False))
        return {
            "id": self.id, "name": self.name, "mode": self.mode, "company_name": self.company_name,
            "languages": list(self.languages), "source": self.source, "files": dict(self.files),
            "complete": bool(complete), "warnings": list(self.warnings),
        }


def find_image(directory: Path | None, names: tuple[str, ...]) -> Path | None:
    if directory is None or not directory.is_dir():
        return None
    by_lower = {p.name.lower(): p for p in directory.iterdir() if p.is_file()}
    for name in names:
        if name in by_lower:
            return by_lower[name]
    return None


def _files(directory: Path) -> dict[str, bool]:
    return {kind: find_image(directory, names) is not None for kind, names in _IMAGES.items()}


def read_settings(path: Path) -> tuple[dict[str, Any], list[str]]:
    """paper.json / letterhead.json as a dict (empty when missing or unreadable)."""
    if not path.is_file():
        return {}, []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("not an object")
        return data, []
    except Exception:
        return {}, [f"{path.name} could not be read; defaults used."]


def geometry_of(settings: dict[str, Any]) -> dict[str, Any]:
    """Placement settings, accepting both ``{"geometry": {...}}`` and the older top-level keys."""
    geometry = {k: v for k, v in settings.items() if k in {"paper", "header", "footer", "watermark", "stamp",
                                                          "content_top_mm", "content_bottom_mm"}}
    nested = settings.get("geometry")
    if isinstance(nested, dict):
        geometry.update(nested)
    return geometry


def _paper_from_dir(directory: Path, *, paper_id: str, source: str, default_name: str) -> Paper:
    settings, warnings = read_settings(directory / ("paper.json" if source == "papers" else "letterhead.json"))
    mode = str(settings.get("mode") or "letterhead").strip().lower()
    if mode not in MODES:
        warnings.append(f"Unknown paper mode {mode!r}; printing the full letterhead.")
        mode = "letterhead"
    languages = settings.get("languages")
    if not isinstance(languages, list) or not all(isinstance(x, str) for x in languages):
        languages = ["en", "ar"]
    name = str(settings.get("name") or default_name).strip()[:120]
    company = settings.get("company_name")
    return Paper(
        id=paper_id,
        name=name,
        mode=mode,
        company_name=str(company).strip()[:200] if company else None,
        languages=tuple(x.strip().lower()[:2] for x in languages if x.strip()),
        geometry=geometry_of(settings),
        directory=directory,
        source=source,
        files=_files(directory),
        warnings=tuple(warnings),
    )


def list_papers(private_dir: Path | str | None) -> list[Paper]:
    """Every installed paper: the legacy ``letterhead/`` folder as ``"default"``, then ``papers/*``."""
    if not private_dir:
        return []
    root = Path(private_dir)
    papers: list[Paper] = []
    legacy = root / "letterhead"
    if legacy.is_dir() and any(_files(legacy).values()):
        papers.append(_paper_from_dir(legacy, paper_id=DEFAULT_PAPER_ID, source="legacy",
                                      default_name="Company letterhead"))
    folder = root / "papers"
    if folder.is_dir():
        found = []
        for directory in sorted(p for p in folder.iterdir() if p.is_dir()):
            if not _ID.match(directory.name) or (directory.name == DEFAULT_PAPER_ID and papers):
                continue
            found.append(_paper_from_dir(directory, paper_id=directory.name, source="papers",
                                         default_name=directory.name.replace("-", " ").replace("_", " ").title()))
        papers.extend(sorted(found, key=lambda p: (p.mode != "letterhead", p.name.lower())))
    return papers


def get_paper(private_dir: Path | str | None, paper_id: str | None) -> Paper | None:
    wanted = (paper_id or DEFAULT_PAPER_ID).strip().lower()
    for paper in list_papers(private_dir):
        if paper.id == wanted:
            return paper
    return None


def default_paper_id(papers: list[Paper], language: str | None = None) -> str | None:
    """The paper to preselect: a full letterhead in this language, else the first paper."""
    for paper in papers:
        if not paper.preprinted and paper.supports(language):
            return paper.id
    return papers[0].id if papers else None
