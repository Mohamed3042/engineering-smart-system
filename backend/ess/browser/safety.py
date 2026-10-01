"""Safety rules for everything the downloader writes to disk.

* executables and scripts are never saved (by extension *and* by content sniffing),
* file names are sanitised (no paths, control/reserved characters, Windows device names),
* host allow-lists match a host and its subdomains,
* MIME types come from magic bytes first, then the extension, then the server's header.
"""
from __future__ import annotations

import mimetypes
import os
import re
import unicodedata
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote, urlsplit

__all__ = [
    "BLOCKED_EXTENSIONS",
    "KIND_HOSTS",
    "LOGIN_HOSTS",
    "blocked_reason",
    "filename_from_content_disposition",
    "host_matches",
    "hosts_for_kind",
    "name_from_url",
    "sanitize_filename",
    "sniff_executable",
    "sniff_mime",
    "unique_path",
    "with_extension",
]

BLOCKED_EXTENSIONS = frozenset(
    {
        ".exe", ".msi", ".bat", ".cmd", ".ps1", ".sh", ".app", ".dmg", ".js", ".vbs", ".jar", ".scr",
        ".com", ".pif", ".cpl", ".hta", ".wsf", ".wsh", ".vbe", ".jse", ".lnk", ".reg", ".msp", ".mst",
        ".apk", ".psm1", ".scf", ".command", ".pkg", ".gadget", ".msc", ".mjs", ".ps2", ".bash", ".zsh",
    }
)
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}

#: Hosts each link kind legitimately touches (share page, API and file CDN).
KIND_HOSTS: dict[str, tuple[str, ...]] = {
    "google_drive_file": ("drive.google.com", "drive.usercontent.google.com", "docs.google.com", "googleusercontent.com"),
    "google_drive_folder": ("drive.google.com", "drive.usercontent.google.com", "docs.google.com", "googleusercontent.com"),
    "google_docs": ("docs.google.com", "drive.google.com", "googleusercontent.com"),
    "wetransfer": ("wetransfer.com", "we.tl", "wetransfer.net"),
    "dropbox": ("dropbox.com", "dropboxusercontent.com", "db.tt", "dropbox.net"),
    "onedrive": ("1drv.ms", "onedrive.live.com", "1drv.com", "api.onedrive.com", "sharepoint.com", "svc.ms", "livefilestore.com"),
    "sharepoint": ("sharepoint.com", "svc.ms", "sharepointonline.com"),
    "box": ("box.com", "boxcloud.com", "box.net"),
    "mediafire": ("mediafire.com",),
    "mega": ("mega.nz", "mega.co.nz", "mega.io"),
}

#: Sign-in pages: reaching one means the link is not public (status ``needs_login``).
LOGIN_HOSTS = (
    "accounts.google.com", "login.microsoftonline.com", "login.live.com", "login.windows.net",
    "account.live.com", "account.box.com", "login.yahoo.com", "auth.wetransfer.com",
)


def hosts_for_kind(kind: str, url: str | None = None) -> list[str]:
    """Allow-list for one link: the kind's hosts plus the link's own host."""
    hosts = list(KIND_HOSTS.get(kind, ()))
    if url:
        host = (urlsplit(url).hostname or "").lower()
        if host and host not in hosts:
            hosts.append(host)
    return hosts


def host_matches(host: str | None, patterns: Iterable[str]) -> bool:
    """``host`` equals a pattern or is a subdomain of it (``*.x.com`` and ``.x.com`` accepted)."""
    if not host:
        return False
    host = host.lower().rstrip(".")
    for pattern in patterns:
        p = (pattern or "").lower().strip().rstrip(".")
        if p.startswith("*."):
            p = p[2:]
        p = p.lstrip(".")
        if p and (host == p or host.endswith("." + p)):
            return True
    return False


def sanitize_filename(name: str | None, default: str = "download") -> str:
    """A safe single path component (keeps Arabic and other letters)."""
    name = unicodedata.normalize("NFC", str(name or ""))
    name = name.replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = re.sub(r'[<>:"|?*]', "_", name)
    name = re.sub(r"\s+", " ", name).strip().strip(".").strip()
    stem, ext = os.path.splitext(name)
    if not stem and ext:  # ".pdf" -> "download.pdf"
        stem = default
    if stem.split(".")[0].upper() in _WINDOWS_RESERVED:
        stem = "_" + stem
    ext = ext[:16]
    while len((stem + ext).encode("utf-8")) > 180 and stem:
        stem = stem[:-1]
    name = (stem + ext).strip()
    return name or default


def sniff_executable(head: bytes) -> str | None:
    """Executable formats by magic bytes, whatever the file is called."""
    if not head:
        return None
    if head.startswith(b"MZ"):
        return "Windows executable"
    if head.startswith(b"\x7fELF"):
        return "Linux executable"
    if head[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        return "macOS executable"
    if head.startswith(b"#!"):
        return "script"
    return None


def blocked_reason(name: str, head: bytes = b"") -> str | None:
    """Why this file must not be saved, or ``None`` when it is acceptable."""
    ext = os.path.splitext((name or "").lower().strip())[1]
    if ext in BLOCKED_EXTENSIONS:
        return f"executable or script ({ext}) files are never downloaded"
    kind = sniff_executable(head)
    if kind:
        return f"content is a {kind}; refused"
    return None


_OFFICE = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
_OLE = {".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".msg": "application/vnd.ms-outlook",
        ".ppt": "application/vnd.ms-powerpoint"}
_EXTRA_TYPES = {".dwg": "image/vnd.dwg", ".dxf": "image/vnd.dxf", ".ifc": "application/x-step", ".rvt": "application/octet-stream",
                ".eml": "message/rfc822", ".heic": "image/heic", ".7z": "application/x-7z-compressed",
                ".rar": "application/vnd.rar"}


def _guess(name: str) -> str | None:
    ext = os.path.splitext(name.lower())[1]
    return _OFFICE.get(ext) or _OLE.get(ext) or _EXTRA_TYPES.get(ext) or mimetypes.guess_type(name)[0]


def sniff_mime(head: bytes, name: str = "", declared: str | None = None) -> str:
    ext = os.path.splitext(name.lower())[1]
    if head.startswith(b"%PDF"):
        return "application/pdf"
    if head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06"):
        return _OFFICE.get(ext) or ("application/zip" if ext in ("", ".zip") else (_guess(name) or "application/zip"))
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        return _OLE.get(ext, "application/x-ole-storage")
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    if head.startswith(b"AC10") or head.startswith(b"AC1."):
        return "image/vnd.dwg"
    if head.startswith(b"Rar!"):
        return "application/vnd.rar"
    if head.startswith(b"7z\xbc\xaf\x27\x1c"):
        return "application/x-7z-compressed"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    guessed = _guess(name)
    generic = {"application/octet-stream", "binary/octet-stream", "application/force-download", "application/download", ""}
    declared = (declared or "").split(";")[0].strip().lower()
    if guessed:
        return guessed
    return declared if declared not in generic else "application/octet-stream"


def with_extension(name: str, mime: str | None, head: bytes = b"") -> str:
    """Add an extension from the content type when the server gave a bare name."""
    if os.path.splitext(name)[1]:
        return name
    sniffed = sniff_mime(head, name, mime)
    ext = {"application/pdf": ".pdf", "application/zip": ".zip", "image/png": ".png", "image/jpeg": ".jpg",
           "image/tiff": ".tif", "image/vnd.dwg": ".dwg"}.get(sniffed) or mimetypes.guess_extension(sniffed or "") or ""
    if ext in (".bin", ".a", ".ksh"):
        ext = ""
    return name + ext


def filename_from_content_disposition(value: str | None) -> str | None:
    """File name from a Content-Disposition header (RFC 6266 / RFC 5987 aware)."""
    if not value:
        return None
    m = re.search(r"filename\*\s*=\s*([\w!#$%&+^`{}~-]*)'[^']*'([^;]+)", value, re.I)
    if m:
        charset = m.group(1) or "utf-8"
        raw = m.group(2).strip().strip('"')
        try:
            return unquote(raw, encoding=charset, errors="strict")
        except (LookupError, UnicodeDecodeError):
            return unquote(raw)
    m = re.search(r'filename\s*=\s*"((?:[^"\\]|\\.)*)"', value, re.I)
    if m:
        name = m.group(1).replace('\\"', '"')
    else:
        m = re.search(r"filename\s*=\s*([^;]+)", value, re.I)
        if not m:
            return None
        name = m.group(1).strip()
    if "%" in name and re.search(r"%[0-9A-Fa-f]{2}", name):
        name = unquote(name)
    try:  # servers that send raw UTF-8 bytes that were decoded as latin-1
        fixed = name.encode("latin-1").decode("utf-8")
        if fixed != name:
            name = fixed
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return name or None


_GENERIC_SEGMENTS = {"uc", "download", "downloads", "file", "files", "view", "content", "export", "get", "open",
                     "edit", "preview", "raw", "attachment", "dl", "index", "root"}


def name_from_url(url: str) -> str | None:
    """Last path segment when it looks like a file name (``/files/BOQ.xlsx``, ``/files/BOQ``)."""
    path = urlsplit(url).path
    last = unquote(path.rstrip("/").rsplit("/", 1)[-1]) if path else ""
    if not last or len(last) > 200:
        return None
    if "." in last:
        return last
    if last.lower() in _GENERIC_SEGMENTS or not re.fullmatch(r"[\w\- ()؀-ۿ]{2,100}", last):
        return None
    return last


def unique_path(directory: Path, name: str) -> Path:
    """``directory/name``, or ``name (2).ext`` ... when taken."""
    candidate = directory / name
    if not candidate.exists():
        return candidate
    stem, ext = os.path.splitext(name)
    for i in range(2, 10_000):
        candidate = directory / f"{stem} ({i}){ext}"
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"too many files named {name!r} in {directory}")
