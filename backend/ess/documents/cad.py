"""CAD / BIM files: what can be read without a CAD viewer.

* DXF (ASCII): TEXT, MTEXT, ATTRIB/ATTDEF (title-block attributes), DIMENSION overrides and
  MLEADER text are read with a small group-code parser; MTEXT formatting codes are removed.
* DWG: AutoCAD release from the file header.
* IFC (STEP text): schema, authoring tool, project / site / building / storey names.
* RVT/RFA: Revit build and file info from the OLE ``BasicFileInfo`` stream when readable.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

__all__ = ["DWG_VERSIONS", "parse_dxf", "read_cad"]

DWG_VERSIONS = {
    "AC1.40": "R1.4", "AC2.10": "R2.10", "AC1002": "R2.5", "AC1003": "R2.6", "AC1004": "R9", "AC1006": "R10",
    "AC1009": "R11/R12", "AC1012": "R13", "AC1014": "R14", "AC1015": "AutoCAD 2000", "AC1018": "AutoCAD 2004",
    "AC1021": "AutoCAD 2007", "AC1024": "AutoCAD 2010", "AC1027": "AutoCAD 2013", "AC1032": "AutoCAD 2018",
}
_TEXT_ENTITIES = {"TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION", "MLEADER", "MULTILEADER", "ACAD_TABLE"}
_SPECIAL = {"%%c": "Ø", "%%C": "Ø", "%%d": "°", "%%D": "°", "%%p": "±", "%%P": "±", "%%%": "%"}


def _clean_mtext(text: str) -> str:
    text = re.sub(r"\\U\+([0-9A-Fa-f]{4})", lambda m: chr(int(m.group(1), 16)), text)
    text = re.sub(r"\\M\+[0-9A-Fa-f]([0-9A-Fa-f]{4})", lambda m: chr(int(m.group(1), 16)), text)
    text = re.sub(r"\\S([^;^/#]*)[\^/#]([^;]*);", r"\1/\2", text)  # stacked fractions
    text = re.sub(r"\\[ACcFfHhQTtWwp][^;\\{}]*;", "", text)  # codes with parameters
    text = text.replace("\\P", "\n").replace("\\X", "\n").replace("\\~", " ")
    text = re.sub(r"\\[LlOoKkNn]", "", text)
    text = text.replace("\\\\", "\\").replace("\\{", "{").replace("\\}", "}")
    text = re.sub(r"(?<!\\)[{}]", "", text)
    for code, char in _SPECIAL.items():
        text = text.replace(code, char)
    text = re.sub(r"%%[uUoOkK]", "", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def parse_dxf(path: Path, *, max_bytes: int = 80_000_000) -> tuple[list[str], dict, list[str]]:
    """(text lines, meta, warnings) from an ASCII DXF file."""
    warnings: list[str] = []
    raw = Path(path).read_bytes()[:max_bytes]
    if raw.startswith(b"AutoCAD Binary DXF"):
        return [], {"format": "binary DXF"}, ["binary DXF: text not extracted (needs a CAD viewer)"]
    codepage = re.search(rb"\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)", raw[:200_000])
    encoding = "utf-8"
    if codepage:
        cp = codepage.group(1).decode("ascii", "ignore").upper()
        encoding = {"ANSI_1256": "cp1256", "ANSI_1252": "cp1252", "ANSI_1251": "cp1251", "ANSI_1250": "cp1250"}.get(cp, "utf-8")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode(encoding if encoding != "utf-8" else "cp1252", errors="replace")
    lines = content.splitlines()
    meta: dict[str, Any] = {"format": "DXF"}
    texts: list[str] = []
    seen: set[str] = set()
    entity: str | None = None
    groups: list[tuple[int, str]] = []
    header_var: str | None = None

    def flush() -> None:
        if entity not in _TEXT_ENTITIES or not groups:
            return
        if entity == "MTEXT" or entity in ("MLEADER", "MULTILEADER", "ACAD_TABLE"):
            chunks = [v for c, v in groups if c in (3, 1, 304, 302)]
            value = _clean_mtext("".join(chunks))
        else:
            value = _clean_mtext(next((v for c, v in groups if c == 1), ""))
        if entity == "DIMENSION" and value in ("", "<>"):
            return
        tag = next((v for c, v in groups if c == 2), "") if entity in ("ATTRIB", "ATTDEF") else ""
        if entity == "ATTDEF" and not value:
            return
        line = f"{tag.strip()}: {value}" if tag and value else value
        if line and line not in seen:
            seen.add(line)
            texts.append(line)

    i = 0
    n = len(lines) - 1
    while i < n:
        code_s = lines[i].strip()
        value = lines[i + 1].rstrip("\r")
        i += 2
        try:
            code = int(code_s)
        except ValueError:
            continue
        if code == 9:
            header_var = value.strip()
            continue
        if header_var and code in (1, 3) and header_var in ("$ACADVER", "$DWGCODEPAGE", "$PROJECTNAME"):
            meta[header_var.lstrip("$").lower()] = value.strip()
            header_var = None
            continue
        if code == 0:
            flush()
            entity = value.strip()
            groups = []
            if entity == "EOF":
                break
            continue
        if entity in _TEXT_ENTITIES:
            groups.append((code, value))
    flush()
    if meta.get("acadver"):
        meta["release"] = DWG_VERSIONS.get(meta["acadver"], meta["acadver"])
    meta["text_entities"] = len(texts)
    return texts, meta, warnings


def _read_dwg(path: Path) -> dict:
    head = Path(path).read_bytes()[:6].decode("ascii", "ignore")
    return {"format": "DWG", "dwg_version": head, "release": DWG_VERSIONS.get(head, "unknown")}


def _read_ifc(path: Path) -> tuple[list[str], dict]:
    data = Path(path).read_bytes()[:8_000_000].decode("utf-8", errors="replace")
    meta: dict[str, Any] = {"format": "IFC"}
    schema = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", data)
    if schema:
        meta["schema"] = schema.group(1)
    file_name = re.search(r"FILE_NAME\s*\((.*?)\);", data, re.S)
    if file_name:
        strings = re.findall(r"'((?:[^']|'')*)'", file_name.group(1))
        if strings:
            meta["file_name"] = strings[0]
        if len(strings) >= 2:
            meta["timestamp"] = strings[1]
        tools = [s for s in strings[2:] if s and not s.startswith("$")]
        if tools:
            meta["authoring"] = tools[-1]
    lines: list[str] = []

    def names(entity: str) -> list[str]:
        found = re.findall(rf"{entity}\s*\(\s*'[^']*'\s*,\s*[#$\w]*\s*,\s*'((?:[^']|'')*)'", data)
        return [re.sub(r"\\X2\\([0-9A-F]+)\\X0\\", lambda m: bytes.fromhex(m.group(1)).decode("utf-16-be", "ignore"), f)
                for f in found]

    for entity, label in (("IFCPROJECT", "Project"), ("IFCSITE", "Site"), ("IFCBUILDING", "Building"),
                          ("IFCBUILDINGSTOREY", "Storey")):
        values = [v for v in dict.fromkeys(names(entity)) if v][:60]
        if values:
            meta[label.lower() + ("s" if label == "Storey" else "")] = values if label == "Storey" else values[0]
            lines += [f"{label}: {v}" for v in values]
    return lines, meta


def _read_revit(path: Path) -> tuple[list[str], dict]:
    meta: dict[str, Any] = {"format": "Revit"}
    lines: list[str] = []
    try:
        import olefile

        if olefile.isOleFile(str(path)):
            with olefile.OleFileIO(str(path)) as ole:
                if ole.exists("BasicFileInfo"):
                    raw = ole.openstream("BasicFileInfo").read()
                    text = raw.decode("utf-16-le", errors="ignore")
                    for key in ("Format", "Build", "Central Model Path", "Last Save Path", "Revit Build"):
                        match = re.search(rf"{key}:\s*([^\r\n\x00]+)", text)
                        if match:
                            meta[key.lower().replace(" ", "_")] = match.group(1).strip()[:200]
                    lines = [f"{k}: {v}" for k, v in meta.items() if k != "format"]
    except Exception:
        pass
    return lines, meta


def read_cad(path: Path) -> dict:
    """Parts of a DocExtract for CAD/BIM files (kind ``cad``)."""
    ext = Path(path).suffix.lower()
    warnings = ["needs CAD viewer: geometry is not interpreted; review the drawing in a CAD/BIM viewer"]
    lines: list[str] = []
    meta: dict[str, Any] = {}
    try:
        if ext == ".dxf":
            lines, meta, extra = parse_dxf(path)
            warnings += extra
        elif ext == ".dwg":
            meta = _read_dwg(path)
        elif ext == ".ifc":
            lines, meta = _read_ifc(path)
        elif ext in (".rvt", ".rfa", ".rte"):
            lines, meta = _read_revit(path)
        else:
            meta = {"format": ext.lstrip(".").upper()}
    except Exception as exc:
        warnings.append(f"could not read {ext} details: {type(exc).__name__}: {exc}")
    return {"text": "\n".join(lines), "meta": meta, "warnings": warnings}
