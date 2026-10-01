#!/usr/bin/env python3
"""Install the company letterhead, papers, stamp, signature and catalog into the private data dir.

Copies from a local Medmack Quotation Builder checkout (app/assets and app/data) into::

    <data>/private/letterhead/{header.jpg, footer.jpg, stamp.png, watermark.png, letterhead.json}
    <data>/private/papers/<prefix>-letterhead/   the full letterhead paper   (paper.json + images)
    <data>/private/papers/<prefix>-preprinted/   body only, for pre-printed paper (paper.json + stamp)
    <data>/private/signatures/<INITIALS>.png
    <data>/private/catalog/scaffolding-catalog.json

<data> is $ESS_DATA_DIR, or data/ in this repository (git-ignored). These files are
company-private: the script refuses to write anywhere inside a git work tree except an
ignored data directory, and it prints file names and sizes only. Standard library only.

    python scripts/import_letterhead.py
    python scripts/import_letterhead.py --from ~/src/medmack-quotation-builder/app/assets --initials AA
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = REPO_ROOT.parent / "medmack-quotation-builder" / "app" / "assets"
DEFAULT_COMPANY = "Medmac Kuwait Co. General Trading and Contracting"

LETTERHEAD_FILES = (
    ("header", ("header.jpg", "header.jpeg", "header.png")),
    ("footer", ("footer.jpg", "footer.jpeg", "footer.png")),
    ("stamp", ("stamp.png",)),
    ("watermark", ("watermark.png",)),
)
SIGNATURE_NAMES = ("sign.png", "signature.png")
CATALOG_NAMES = ("scaffolding-catalog.json",)
# The builder's placement (app/quotation.html .band / .wm, app/stamp.js defaults), millimetres.
BAND = {"header": {"left_mm": 6.4, "top_mm": 4.7, "width_mm": 198.4},
        "footer": {"left_mm": 6.4, "bottom_mm": 0.9, "width_mm": 198.4}}
WATERMARK = {"left_mm": 38.0, "top_mm": 101.0, "width_mm": 135.0, "opacity": 0.07}
STAMP = {"x_mm": 40.0, "y_mm": 232.0, "width_mm": 36.0}


class Refused(Exception):
    pass


def resolve_data_dir(cli_value: str | None) -> Path:
    if cli_value:
        return Path(cli_value).expanduser().resolve()
    env = os.environ.get("ESS_DATA_DIR")
    return Path(env).expanduser().resolve() if env else (REPO_ROOT / "data").resolve()


def _within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _git_root(path: Path) -> Path | None:
    probe = path.resolve()
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    for candidate in (probe, *probe.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def _git_ignored(root: Path, path: Path) -> bool | None:
    """True / False from ``git check-ignore``; None when git cannot answer."""
    try:
        result = subprocess.run(["git", "-C", str(root), "check-ignore", "-q", str(path)],
                                capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode in (0, 1):
        return result.returncode == 0
    return None


def check_target(private_dir: Path) -> None:
    """Refuse any target inside a git work tree unless it is an ignored data directory."""
    private_dir = private_dir.resolve()
    allowed = (REPO_ROOT / "data").resolve()
    probe = private_dir / "letterhead" / "header.jpg"
    if _within(private_dir, REPO_ROOT):
        if not _within(private_dir, allowed):
            raise Refused(f"{private_dir} is inside the repository; only {allowed} (git-ignored) may hold private files.")
        if _git_root(REPO_ROOT) and _git_ignored(REPO_ROOT, probe) is False:
            raise Refused(f"{allowed} is not git-ignored in this checkout; fix .gitignore first.")
        return
    root = _git_root(private_dir)
    if root is not None and not _git_ignored(root, probe):
        raise Refused(f"{private_dir} is inside the git work tree {root} and is not git-ignored.")


def _builder_paper(source: Path) -> str | None:
    """The builder prints on the scanned paper colour (.page background in app/quotation.html)."""
    try:
        css = (source.parent / "quotation.html").read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"\.page\s*\{[^}]*background:\s*(#[0-9A-Fa-f]{6})", css)
    return match.group(1).upper() if match else None


def _image_size(path: Path) -> tuple[int, int] | None:
    """(width, height) of a PNG or JPEG without third-party libraries."""
    data = path.read_bytes()
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", data[i + 5:i + 9])
                return width, height
            i += 2 + length
    return None


def _find(source: Path, names: tuple[str, ...]) -> Path | None:
    for name in names:
        candidate = source / name
        if candidate.is_file():
            return candidate
    return None


def _private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def _copy(src: Path, dst: Path) -> str:
    existed = dst.exists()
    _private_dir(dst.parent)
    tmp = dst.with_name(dst.name + ".part")
    shutil.copyfile(src, tmp)
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    tmp.replace(dst)
    return "replaced" if existed else "copied"


def _write_json(path: Path, data: dict) -> None:
    _private_dir(path.parent)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _band_geometry(found: dict[str, Path]) -> dict:
    geometry = {kind: dict(values) for kind, values in BAND.items()}
    for kind in ("header", "footer"):
        size = _image_size(found[kind]) if kind in found else None
        if size and size[0]:
            geometry[kind]["height_mm"] = round(geometry[kind]["width_mm"] * size[1] / size[0], 3)
    return geometry


def run(source: Path, data_dir: Path, initials: str, *, company: str = DEFAULT_COMPANY,
        prefix: str = "medmack") -> int:
    source = source.expanduser().resolve()
    private_dir = data_dir / "private"
    if not source.is_dir():
        print(f"error: source folder not found: {source} (use --from)", file=sys.stderr)
        return 1
    try:
        check_target(private_dir)
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    initials = re.sub(r"[^A-Za-z]", "", initials).upper()[:5]
    prefix = re.sub(r"[^a-z0-9-]", "", prefix.lower())[:40] or "company"
    if not initials:
        print("error: --initials must contain letters", file=sys.stderr)
        return 1

    found: dict[str, Path] = {}
    for kind, names in LETTERHEAD_FILES:
        path = _find(source, names)
        if path is None:
            print(f"missing: {kind} (looked for {', '.join(names)})")
        else:
            found[kind] = path
    signature = _find(source, SIGNATURE_NAMES)
    if signature is None:
        print(f"missing: signature (looked for {', '.join(SIGNATURE_NAMES)})")
    catalog = _find(source.parent / "data", CATALOG_NAMES)
    if not found and signature is None and catalog is None:
        print(f"error: nothing to import from {source}", file=sys.stderr)
        return 1

    full_paper, preprinted_paper = f"{prefix}-letterhead", f"{prefix}-preprinted"
    plan: list[tuple[Path, Path]] = []
    for kind, path in found.items():
        name = f"{kind}{path.suffix.lower()}"
        plan.append((path, private_dir / "letterhead" / name))              # the "default" paper
        plan.append((path, private_dir / "papers" / full_paper / name))
        if kind == "stamp":
            plan.append((path, private_dir / "papers" / preprinted_paper / name))
    if signature is not None:
        plan.append((signature, private_dir / "signatures" / f"{initials}.png"))
    if catalog is not None:
        plan.append((catalog, private_dir / "catalog" / catalog.name))

    print(f"source: {source}")
    print(f"target: {private_dir}")
    for src, dst in plan:
        # A previous import may have used another extension (header.png vs header.jpg).
        if dst.parent.name not in ("signatures", "catalog") and dst.parent.exists():
            for stale in dst.parent.glob(dst.stem + ".*"):
                if stale != dst and stale.suffix.lower() in {".jpg", ".jpeg", ".png"}:
                    stale.unlink()
        action = _copy(src, dst)
        print(f"{action}: {src.name} -> {dst.relative_to(private_dir).as_posix()} ({dst.stat().st_size:,} bytes)")

    paper_colour = _builder_paper(source)
    geometry = _band_geometry(found)
    if paper_colour:
        _write_json(private_dir / "letterhead" / "letterhead.json",
                    {"paper": paper_colour, "source": "medmack-quotation-builder"})
        print(f"wrote: letterhead/letterhead.json (paper {paper_colour})")
    if found:
        full = {"paper": paper_colour, **geometry, "watermark": WATERMARK, "stamp": STAMP}
        _write_json(private_dir / "papers" / full_paper / "paper.json", {
            "id": full_paper, "name": f"{company} – letterhead", "company_name": company,
            "mode": "letterhead", "languages": ["en", "ar"],
            "geometry": {k: v for k, v in full.items() if v is not None}})
        print(f"wrote: papers/{full_paper}/paper.json (full letterhead)")
        _write_json(private_dir / "papers" / preprinted_paper / "paper.json", {
            "id": preprinted_paper, "name": f"{company} – pre-printed paper (body only)",
            "company_name": company, "mode": "preprinted", "languages": ["en", "ar"],
            "geometry": {**geometry, "stamp": STAMP}})
        print(f"wrote: papers/{preprinted_paper}/paper.json (body only, same text position)")
    print("done. These files are private: keep them out of version control.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", default=str(DEFAULT_SOURCE),
                        help=f"builder assets folder (default: {DEFAULT_SOURCE})")
    parser.add_argument("--data-dir", default=None,
                        help="data directory (default: $ESS_DATA_DIR or <repo>/data)")
    parser.add_argument("--initials", default="AA", help="signatory initials for the signature (default: AA)")
    parser.add_argument("--company-name", default=DEFAULT_COMPANY, help="company name stored with the papers")
    parser.add_argument("--paper-prefix", default="medmack", help="paper ids: <prefix>-letterhead, <prefix>-preprinted")
    args = parser.parse_args(argv)
    return run(Path(args.source), resolve_data_dir(args.data_dir), args.initials,
               company=args.company_name, prefix=args.paper_prefix)


if __name__ == "__main__":
    sys.exit(main())
