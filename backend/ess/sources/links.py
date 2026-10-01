"""Find the file-share links a customer put in an e-mail and classify them.

``extract_links(text, html)`` returns ``[{url, kind, label}]`` where ``kind`` is one of
:data:`LINK_KINDS`. URLs are normalised (trailing punctuation/brackets stripped, Outlook
SafeLinks / Proofpoint urldefense / Google redirect wrappers unwrapped), deduplicated (Drive
links by file id) and junk is dropped: mailto/tel, social profiles, logos and tracking pixels,
unsubscribe/preference links, mail-client boilerplate and plain homepages (signatures).
"""
from __future__ import annotations

import base64
import re
from typing import Iterable, Literal
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit, urlunsplit

__all__ = [
    "FILE_EXTENSIONS",
    "LINK_KINDS",
    "classify_link",
    "drive_id_from_url",
    "drive_resource_key",
    "extract_links",
    "is_junk_link",
    "normalize_url",
    "unwrap_url",
]

LinkKind = Literal[
    "google_drive_file", "google_drive_folder", "google_docs", "wetransfer", "dropbox", "onedrive",
    "sharepoint", "box", "mega", "mediafire", "direct_file", "other",
]
LINK_KINDS: tuple[str, ...] = (
    "google_drive_file", "google_drive_folder", "google_docs", "wetransfer", "dropbox", "onedrive",
    "sharepoint", "box", "mega", "mediafire", "direct_file", "other",
)
SHARE_KINDS = frozenset(LINK_KINDS) - {"direct_file", "other"}

FILE_EXTENSIONS = frozenset(
    {
        ".pdf", ".dwg", ".dxf", ".dwf", ".dwfx", ".rvt", ".rfa", ".ifc", ".nwd", ".nwc", ".skp", ".dgn",
        ".step", ".stp", ".iges", ".igs", ".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".xlsx", ".xls",
        ".xlsm", ".xlsb", ".csv", ".docx", ".doc", ".rtf", ".odt", ".ods", ".pptx", ".ppt", ".txt",
        ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".webp", ".bmp", ".mp4", ".mov", ".msg", ".eml",
    }
)
_IMAGE_EXT = (".gif", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".bmp", ".ico")
_SOCIAL_HOSTS = (
    "linkedin.com", "lnkd.in", "facebook.com", "fb.com", "fb.me", "twitter.com", "x.com", "t.co",
    "instagram.com", "youtube.com", "youtu.be", "tiktok.com", "wa.me", "whatsapp.com", "t.me",
    "telegram.me", "pinterest.com", "snapchat.com", "threads.net", "plus.google.com", "behance.net",
    "vimeo.com", "flickr.com",
)
_BOILERPLATE_HOSTS = (
    "aka.ms", "go.microsoft.com", "support.microsoft.com", "privacy.microsoft.com", "microsoft.com",
    "support.google.com", "policies.google.com", "accounts.google.com", "myaccount.google.com",
    "avg.com", "avast.com", "mailtrack.io", "getmailspring.com", "eepurl.com", "mailchimp.com",
    "list-manage.com", "mandrillapp.com", "sendgrid.net", "hubspotlinks.com", "mailchi.mp",
    "go.onelink.me", "outlook.office.com", "outlook.live.com", "apple.com", "play.google.com",
    "w3.org", "schema.org", "gstatic.com", "googleusercontent.com", "ggpht.com",
)
_JUNK_WORDS_RE = re.compile(
    r"(unsubscribe|optout|opt-out|opt_out|email-preferences|manage-preferences|preference-center"
    r"|subscription-center|/preferences\b|update-profile|view-in-browser|webversion|/track/open|/open\.php"
    r"|/wf/open|tracking-pixel|/pixel\b|/beacon\b|emailtracking)",
    re.I,
)
_IMAGE_JUNK_RE = re.compile(
    r"(logo|signature|sig[_-]|banner|icon|pixel|spacer|blank|track|beacon|footer|header|social|facebook"
    r"|linkedin|twitter|instagram|whatsapp|youtube|badge|award|certificate-logo|email[_-]?img)",
    re.I,
)
_URL_RE = re.compile(r"""(?:https?://|www\.)[^\s<>"'\[\]{}|\\^`]+""", re.I)
_BARE_SHARE_RE = re.compile(
    r"""(?<![\w@/.:-])(?:we\.tl|wetransfer\.com|drive\.google\.com|docs\.google\.com|1drv\.ms|onedrive\.live\.com"""
    r"""|(?:www\.)?dropbox\.com|[\w-]+(?:-my)?\.sharepoint\.com|app\.box\.com|mega\.nz|(?:www\.)?mediafire\.com)"""
    r"""/[^\s<>"'\[\]{}|\\^`]+""",
    re.I,
)
_TRAILING = ".,;:!?'\"…*~"  # not "_" or "-": Drive ids and we.tl codes may end with them
_PAIRS = {")": "(", "]": "[", "}": "{", ">": "<"}
_DRIVE_ID = r"[A-Za-z0-9_-]{10,}"


def _clean_tail(url: str) -> str:
    url = url.strip()
    for entity in ("&gt;", "&lt;", "&quot;", "&#39;", "&nbsp;"):
        if url.endswith(entity):
            url = url[: -len(entity)]
    changed = True
    while changed and url:
        changed = False
        if url[-1] in _TRAILING:
            url = url[:-1]
            changed = True
        elif url[-1] in _PAIRS and url.count(url[-1]) > url.count(_PAIRS[url[-1]]):
            url = url[:-1]
            changed = True
    return url


def _decode_urldefense_v3(url: str) -> str | None:
    match = re.search(r"/v3/__(?P<url>.+?)__;(?P<enc>[^!]*)!", url)
    if not match:
        return None
    inner = unquote(match.group("url"))
    enc = match.group("enc")
    try:
        replacement = base64.urlsafe_b64decode(enc + "=" * (-len(enc) % 4)).decode("utf-8") if enc else ""
    except Exception:
        replacement = ""
    run_values = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    run_length = {ch: idx + 2 for idx, ch in enumerate(run_values)}
    out: list[str] = []
    pos = 0
    i = 0
    while i < len(inner):
        if inner[i] == "*":
            if inner.startswith("**", i) and i + 2 < len(inner) and inner[i + 2] in run_length:
                n = run_length[inner[i + 2]]
                out.append(replacement[pos : pos + n])
                pos += n
                i += 3
                continue
            out.append(replacement[pos : pos + 1])
            pos += 1
            i += 1
            continue
        out.append(inner[i])
        i += 1
    return "".join(out)


def unwrap_url(url: str, _depth: int = 0) -> str:
    """Remove security / redirect wrappers (Outlook SafeLinks, Proofpoint, Google, LinkedIn)."""
    if _depth > 5:
        return url
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    host = (parts.hostname or "").lower()
    query = parse_qs(parts.query)
    inner: str | None = None
    if host.endswith("safelinks.protection.outlook.com") or host.endswith("safelinks.protection.office365.us"):
        inner = (query.get("url") or [None])[0]
    elif host == "urldefense.proofpoint.com":
        if "/v2/" in parts.path and query.get("u"):
            inner = unquote(query["u"][0].replace("-", "%").replace("_", "/"))
        elif query.get("u"):
            inner = unquote(query["u"][0])
    elif host == "urldefense.com" and "/v3/" in parts.path:
        inner = _decode_urldefense_v3(url)
    elif host in ("www.google.com", "google.com", "www.google.com.kw") and parts.path == "/url":
        inner = (query.get("q") or query.get("url") or [None])[0]
    elif host.endswith("linkedin.com") and parts.path.startswith("/redir/redirect"):
        inner = (query.get("url") or [None])[0]
    elif host == "l.facebook.com" and parts.path == "/l.php":
        inner = (query.get("u") or [None])[0]
    if inner and inner.lower().startswith(("http://", "https://")):
        return unwrap_url(inner, _depth + 1)
    return url


def normalize_url(url: str) -> str:
    """Clean one raw URL: unwrap, strip trailing junk, add a scheme, drop ``utm_*`` noise."""
    url = _clean_tail(url.replace("&amp;", "&"))
    if url.lower().startswith("www.") or not re.match(r"^[a-z][a-z0-9+.-]*://", url, re.I):
        url = "https://" + url
    url = unwrap_url(url)
    url = _clean_tail(url)
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    host = (parts.hostname or "").lower()
    netloc = parts.netloc.lower() if not parts.username else parts.netloc
    pairs = [(k, v) for k, v in parse_qs(parts.query, keep_blank_values=True).items()]
    if any(k.lower().startswith("utm_") for k, _ in pairs):
        kept = [(k, val) for k, vals in pairs if not k.lower().startswith("utm_") for val in vals]
        query = urlencode(kept, doseq=False, quote_via=quote)
    else:
        query = parts.query
    fragment = parts.fragment if host in ("mega.nz", "mega.co.nz") or parts.fragment.startswith("!") else ""
    if host.endswith("google.com") and "embeddedfolderview" in parts.path:
        fragment = parts.fragment
    return urlunsplit((parts.scheme.lower(), netloc, parts.path, query, fragment))


def drive_id_from_url(url: str) -> str | None:
    """Google Drive / Docs file or folder id from any Drive URL shape."""
    if not url:
        return None
    for pattern in (
        rf"/file/d/({_DRIVE_ID})",
        rf"/folders/({_DRIVE_ID})",
        rf"/(?:document|spreadsheets|presentation|drawings|forms)/d/(?:e/)?({_DRIVE_ID})",
        rf"[?&]id=({_DRIVE_ID})",
    ):
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def drive_resource_key(url: str) -> str | None:
    """``resourcekey`` query value (needed for some older shared Drive files)."""
    try:
        values = parse_qs(urlsplit(url).query).get("resourcekey")
    except ValueError:
        return None
    return values[0] if values else None


def _host(url: str) -> str:
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _host_in(host: str, domains: Iterable[str]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def classify_link(url: str) -> str:
    """One of :data:`LINK_KINDS` for an already-normalised URL."""
    parts = urlsplit(url)
    host = _host(url)
    path = parts.path or ""
    low_path = path.lower()
    if host in ("drive.google.com", "drive.usercontent.google.com"):
        if "/folders/" in path or "folderview" in low_path:
            return "google_drive_folder"
        if "/file/d/" in path or drive_id_from_url(url):
            return "google_drive_file"
        return "other"
    if host == "docs.google.com":
        if re.search(r"/(document|spreadsheets|presentation|drawings)/d/", path):
            return "google_docs"
        if "/file/d/" in path or low_path.startswith("/uc"):
            return "google_drive_file"
        return "other"
    if host == "we.tl" or host == "wetransfer.com" or host.endswith(".wetransfer.com"):
        return "wetransfer"
    if host in ("dropbox.com", "dl.dropbox.com", "db.tt") or host.endswith("dropboxusercontent.com"):
        return "dropbox"
    if host in ("1drv.ms", "onedrive.live.com", "api.onedrive.com") or host.endswith(".files.1drv.com"):
        return "onedrive"
    if host.endswith(".sharepoint.com") or host.endswith(".sharepoint.us"):
        return "sharepoint"
    if _host_in(host, ("box.com", "boxcloud.com", "box.net")):
        return "box"
    if host in ("mega.nz", "mega.co.nz", "mega.io"):
        return "mega"
    if _host_in(host, ("mediafire.com",)):
        return "mediafire"
    ext = re.search(r"(\.[a-z0-9]{2,5})$", unquote(low_path))
    if ext and ext.group(1) in FILE_EXTENSIONS:
        return "direct_file"
    return "other"


def is_junk_link(url: str, kind: str | None = None, *, sender_domain: str | None = None) -> bool:
    """True for links that never lead to project files (see module docstring)."""
    kind = kind or classify_link(url)
    try:
        parts = urlsplit(url)
    except ValueError:
        return True
    if parts.scheme not in ("http", "https"):
        return True
    host = _host(url)
    if not host or "." not in host:
        return True
    path = parts.path or ""
    if _JUNK_WORDS_RE.search(path + "?" + parts.query):
        return True
    if kind in SHARE_KINDS:
        if kind == "wetransfer" and host != "we.tl":
            return not re.match(r"^/(downloads|collections|t)/", path, re.I) and host == "wetransfer.com"
        if kind == "dropbox" and host == "dropbox.com":
            return not re.match(r"^/(s|sh|scl|l|t|transfer)/", path)
        if kind == "box" and not re.search(r"/(s|shared|file|folder|f)/", path):
            return True
        if kind == "onedrive" and host == "onedrive.live.com" and not (parts.query or len(path) > 1):
            return True
        if kind == "mega" and not (parts.fragment or re.search(r"/(file|folder)/", path)):
            return True
        if kind == "mediafire" and not re.search(r"/(file|folder|view|download)", path):
            return True
        return False
    if _host_in(host, _SOCIAL_HOSTS) or _host_in(host, _BOILERPLATE_HOSTS):
        return True
    low = path.lower()
    if low.endswith(_IMAGE_EXT) and (_IMAGE_JUNK_RE.search(low) or len(low) < 6):
        return True
    if low.endswith((".gif", ".svg", ".ico")):  # animated banners and icons, never project files
        return True
    if kind == "other":
        if path in ("", "/") or re.fullmatch(r"/(index\.(html?|php|aspx?)|home|en|ar|en/|ar/)", low):
            return True  # plain homepage (signatures, disclaimers)
        if sender_domain:
            sd = sender_domain.lower().lstrip("@")
            if host == sd or host.endswith("." + sd):
                depth = len([p for p in path.split("/") if p])
                if depth <= 1 and not parts.query:
                    return True  # sender's own site pages (about, contact, products)
    return False


def _label_before(line: str, begin: int, start: int) -> str | None:
    """Words between the previous link on the line (``begin``) and this one (``start``)."""
    prefix = line[begin:start].rstrip(" \t:-–—=>(<[")
    prefix = re.sub(r"\s+", " ", prefix).strip(" ,;.)]>")
    if not prefix or len(re.sub(r"\W", "", prefix)) < 2:
        return None
    if prefix.lower() in ("and", "or", "&", "و"):
        return None
    return prefix[-80:].lstrip(" ,;.")


def _candidates_from_text(text: str) -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    for line in (text or "").splitlines():
        spans: list[tuple[int, int, str]] = []
        for rx in (_URL_RE, _BARE_SHARE_RE):
            for match in rx.finditer(line):
                if any(s <= match.start() < e for s, e, _ in spans):
                    continue
                spans.append((match.start(), match.end(), match.group(0)))
        spans.sort()
        prev_end = 0
        for start, end, raw in spans:
            out.append((raw, _label_before(line, prev_end, start)))
            prev_end = end
    return out


def _candidates_from_html(html: str) -> list[tuple[str, str | None]]:
    from bs4 import BeautifulSoup

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")
    out: list[tuple[str, str | None]] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href.lower().startswith(("http://", "https://", "www.")):
            continue
        label = a.get_text(" ", strip=True)
        if not label:
            img = a.find("img")
            label = (img.get("alt") or "").strip() if img else ""
        if label and _URL_RE.fullmatch(label.strip()):
            label = ""
        out.append((href, label or None))
    return out


def _dedupe_key(url: str, kind: str) -> str:
    if kind in ("google_drive_file", "google_drive_folder", "google_docs"):
        fid = drive_id_from_url(url)
        if fid:
            return f"{kind}:{fid}"
    parts = urlsplit(url)
    host = _host(url)
    path = parts.path.rstrip("/")
    query = parts.query
    if kind == "dropbox":
        query = "&".join(sorted(p for p in query.split("&") if p and not p.startswith("dl=")))
    return f"{host}{path}?{query}#{parts.fragment}"


def extract_links(
    text: str | None,
    html: str | None = None,
    *,
    sender_email: str | None = None,
    sender_domain: str | None = None,
) -> list[dict]:
    """``[{url, kind, label}]`` for every useful link in a message body (first seen first)."""
    if sender_domain is None and sender_email and "@" in sender_email:
        sender_domain = sender_email.rsplit("@", 1)[1].lower()
    candidates: list[tuple[str, str | None]] = []
    if html:
        candidates += _candidates_from_html(html)
    candidates += _candidates_from_text(text or "")
    if html and not text:
        from .base import html_to_text

        candidates += _candidates_from_text(html_to_text(html))

    results: list[dict] = []
    index: dict[str, int] = {}
    for raw, label in candidates:
        if not raw or raw.lower().startswith(("mailto:", "tel:", "cid:", "javascript:", "data:")):
            continue
        url = normalize_url(raw)
        kind = classify_link(url)
        if is_junk_link(url, kind, sender_domain=sender_domain):
            continue
        key = _dedupe_key(url, kind)
        if key in index:
            existing = results[index[key]]
            if not existing.get("label") and label:
                existing["label"] = label
            continue
        index[key] = len(results)
        results.append({"url": url, "kind": kind, "label": label})
    return results
