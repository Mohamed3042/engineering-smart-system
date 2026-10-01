"""Download the files behind a customer's link (Drive, WeTransfer, Dropbox, OneDrive, ...).

    result = await download_link(url, kind, dest_dir)
    result.status   # ok | expired | needs_login | blocked | failed | unsupported
    result.files    # [{path, name, size, sha256, mime, source_url, rel_path}]

Strategies per ``kind`` (see :data:`ess.sources.links.LINK_KINDS`):

* ``google_drive_file``  httpx ``uc?export=download&id=`` incl. the large-file confirm form,
  the old ``confirm=`` token / cookie and ``resourcekey``.
* ``google_drive_folder`` Playwright on ``embeddedfolderview?id=<id>#list``; each file through
  the Drive-file strategy, Google Docs exported, sub-folders to depth 3; "Download all" zip
  as a fallback.
* ``google_docs``  export to PDF (documents, slides, drawings) / XLSX (sheets).
* ``wetransfer``  Playwright: accept cookie/terms dialogs, detect expired/deleted, click
  Download and capture the download; falls back to the public ``/api/v4/transfers/<id>/download``
  flow when the transfer id + security hash are known.
* ``dropbox``  ``dl=1``; ``onedrive``/``sharepoint``  ``download=1`` (+ OneDrive shares API),
  then Playwright; sign-in walls -> ``needs_login``.
* ``direct_file``  httpx streaming with Content-Disposition names.
* ``other``/``box``/``mediafire``  Playwright: screenshot + saved HTML as evidence, then obvious
  file links / Download buttons. ``mega`` -> ``unsupported`` (client-side encryption).

Safety: executables/scripts are refused (extension and magic bytes), ``max_bytes`` is enforced
while streaming, file names are sanitised, navigation and downloads stay inside
``allowed_hosts`` when given, every file gets a sha256, and no credentials are ever typed.

``endpoints`` maps real hosts to other base URLs (``{"drive.google.com": "http://127.0.0.1:8123"}``)
so tests and mirrors can stand in for the real services.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit

import httpx
from pydantic import BaseModel, Field

from ..sources.links import classify_link, drive_id_from_url, drive_resource_key, unwrap_url
from .safety import (
    LOGIN_HOSTS,
    blocked_reason,
    filename_from_content_disposition,
    host_matches,
    name_from_url,
    sanitize_filename,
    sniff_executable,
    sniff_mime,
    unique_path,
    with_extension,
)

__all__ = ["DownloadResult", "DownloadedFile", "download_link", "USER_AGENT"]

Status = Literal["ok", "expired", "needs_login", "blocked", "failed", "unsupported"]
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)
_MAX_FOLDER_DEPTH = 3
_MAX_FOLDER_FILES = 300
_MAX_PAGE_LINKS = 12
CLICK_WAIT_S = 30  # how long a clicked Download control may take to start the file
_FILE_EXT_RE = re.compile(
    r"\.(pdf|dwg|dxf|dwf|rvt|ifc|zip|rar|7z|xlsx?|xlsm|csv|docx?|pptx?|jpe?g|png|tiff?|heic|msg|eml|skp|nwd|step|stp)$",
    re.I,
)
_EXPIRED_RE = re.compile(
    r"(transfer|link|file|files|folder|item|upload)s?\s+(has\s+|have\s+)?(expired|been deleted|was deleted|been removed"
    r"|is no longer available|are no longer available|no longer exists?)"
    r"|this transfer (has )?expired|transfer expired|expired transfer|link (has )?expired|this link is no longer"
    r"|file you have requested does not exist|the item you requested does not exist|this item was deleted"
    r"|the file you('re| are) looking for (has been|was) (deleted|removed)|التحويل منتهي|انتهت صلاحية",
    re.I,
)
_LOGIN_TEXT_RE = re.compile(
    r"(sign in|log in|login|signin) to (continue|view|access|download|open)|you need access|request access"
    r"|you need permission|password[- ]protected|enter (the )?password|access denied|you don't have access"
    r"|you do not have (access|permission)",
    re.I,
)
_ACCEPT_RE = re.compile(
    r"^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|i accept|i agree|agree|agree and continue|accept and continue"
    r"|ok|okay|got it|i understand|yes,? i agree|continue)\s*[.!]?\s*$",
    re.I,
)
_DOWNLOAD_RE = re.compile(r"^\s*(download( all| files?| anyway)?|تنزيل|تحميل)\s*$", re.I)
_LINK_DOWNLOAD_JS = """
() => {
  const out = [];
  const exts = /\\.(pdf|dwg|dxf|dwf|rvt|ifc|zip|rar|7z|xlsx?|xlsm|csv|docx?|pptx?|jpe?g|png|tiff?|heic|msg|eml|skp|nwd|step|stp)(\\?|#|$)/i;
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href || '';
    if (!/^https?:/i.test(href)) continue;
    const text = (a.textContent || '').trim().slice(0, 120);
    const fileLike = exts.test(href) || a.hasAttribute('download') || /download/i.test(a.id || '');
    if (fileLike) out.push({href, text, download: a.getAttribute('download')});
  }
  return out;
}
"""
_DRIVE_ENTRIES_JS = """
() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href || '';
    let m, type = null, id = null;
    if ((m = href.match(/\\/folders\\/([A-Za-z0-9_-]{10,})/))) { type = 'folder'; id = m[1]; }
    else if ((m = href.match(/\\/file\\/d\\/([A-Za-z0-9_-]{10,})/))) { type = 'file'; id = m[1]; }
    else if ((m = href.match(/\\/(document|spreadsheets|presentation|drawings)\\/d\\/([A-Za-z0-9_-]{10,})/))) { type = 'docs'; id = m[2]; }
    else if ((m = href.match(/[?&]id=([A-Za-z0-9_-]{10,})/))) { type = 'file'; id = m[1]; }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = a.closest('.flip-entry');
    const titleEl = entry ? entry.querySelector('.flip-entry-title') : null;
    const title = ((titleEl ? titleEl.textContent : a.textContent) || '').trim();
    const rk = (href.match(/[?&]resourcekey=([^&#]+)/) || [])[1] || null;
    out.push({type, id, title, href, rk});
  }
  return out;
}
"""


# --------------------------------------------------------------------------- result models
class _DictAccess:
    """Allow ``result["status"]`` / ``file.get("path")`` next to attribute access."""

    def __getitem__(self, key: str) -> Any:
        try:
            return getattr(self, key)
        except AttributeError as exc:
            raise KeyError(key) from exc

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)


class DownloadedFile(_DictAccess, BaseModel):
    path: str
    name: str
    size: int
    sha256: str
    mime: str
    source_url: str | None = None
    rel_path: str | None = None  # inside dest_dir, e.g. "Structural/S-101.pdf" for folders


class DownloadResult(_DictAccess, BaseModel):
    status: Status
    url: str
    kind: str
    files: list[DownloadedFile] = Field(default_factory=list)
    error: str | None = None
    log: list[str] = Field(default_factory=list)
    screenshots: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)  # saved HTML pages
    final_url: str | None = None
    skipped: list[dict] = Field(default_factory=list)  # [{name, reason, url}] refused files

    @property
    def ok(self) -> bool:
        return self.status == "ok"


class _Stop(Exception):
    """Terminal outcome raised from deep inside a strategy."""

    def __init__(self, status: Status, error: str):
        super().__init__(error)
        self.status = status
        self.error = error


@dataclass
class _Fetched:
    kind: Literal["file", "page"]
    url: str
    status: int
    file: DownloadedFile | None = None
    text: str = ""
    content_type: str = ""


# --------------------------------------------------------------------------- run context
@dataclass
class _Run:
    url: str
    kind: str
    dest: Path
    max_bytes: int
    allowed: list[str] | None
    headless: bool
    endpoints: dict[str, str]
    deadline: float
    external_browser: Any = None
    started: float = field(default_factory=time.monotonic)
    log: list[str] = field(default_factory=list)
    files: list[DownloadedFile] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    screenshots: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    final_url: str | None = None
    total_bytes: int = 0
    login_wall: str | None = None
    blocked_nav: str | None = None
    _client: httpx.AsyncClient | None = None
    _pw: Any = None
    _browser: Any = None
    _context: Any = None
    _page: Any = None

    # ---- logging / time
    def note(self, message: str) -> None:
        self.log.append(f"{time.monotonic() - self.started:6.1f}s {message}")

    def remaining(self) -> float:
        return max(1.0, self.deadline - time.monotonic())

    # ---- hosts
    @property
    def endpoint_hosts(self) -> set[str]:
        return {(urlsplit(b).hostname or "").lower() for b in self.endpoints.values()}

    def physical(self, url: str) -> str:
        """Apply ``endpoints`` host overrides to a logical URL."""
        if not self.endpoints:
            return url
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        base = self.endpoints.get(host) or self.endpoints.get(host[4:] if host.startswith("www.") else "www." + host)
        if not base:
            return url
        b = urlsplit(base)
        return urlunsplit((b.scheme, b.netloc, b.path.rstrip("/") + parts.path, parts.query, parts.fragment))

    def check_url(self, url: str) -> None:
        """Raise for sign-in pages and hosts outside the allow-list."""
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        if _is_login_url(url):
            self.login_wall = url
            raise _Stop("needs_login", f"the link redirects to a sign-in page ({host}); it is not shared publicly")
        if self.allowed is not None and host not in self.endpoint_hosts and not host_matches(host, self.allowed):
            raise _Stop("blocked", f"host {host} is outside the approved hosts for this download")

    # ---- http
    def http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"},
                timeout=httpx.Timeout(30.0, read=60.0),
                follow_redirects=False,
            )
        return self._client

    # ---- browser
    async def context(self) -> Any:
        if self._context is None:
            browser = self.external_browser
            if browser is None:
                from playwright.async_api import async_playwright

                from ..chromium import launch_chromium

                self.note("starting Chromium")
                self._pw = await async_playwright().start()
                browser = self._browser = await launch_chromium(self._pw, headless=self.headless)
            self._context = await browser.new_context(
                accept_downloads=True,
                user_agent=USER_AGENT,
                locale="en-US",
                viewport={"width": 1366, "height": 900},
            )
            await self._context.route("**/*", self._guard)
        return self._context

    async def _guard(self, route: Any) -> None:
        request = route.request
        try:
            is_main_nav = request.is_navigation_request() and request.frame.parent_frame is None
        except Exception:
            is_main_nav = False
        if is_main_nav:
            url = request.url
            if _is_login_url(url):
                self.login_wall = url
                self.note(f"stopped at sign-in page {urlsplit(url).hostname}")
                await route.abort("blockedbyclient")
                return
            host = (urlsplit(url).hostname or "").lower()
            if self.allowed is not None and host not in self.endpoint_hosts and not host_matches(host, self.allowed):
                self.blocked_nav = url
                self.note(f"blocked navigation to {host}")
                await route.abort("blockedbyclient")
                return
        await route.continue_()

    async def page(self) -> Any:
        if self._page is None or self._page.is_closed():
            ctx = await self.context()
            self._page = await ctx.new_page()
            self._page.set_default_timeout(min(30_000, self.remaining() * 1000))
        return self._page

    async def goto(self, url: str) -> Any:
        self.login_wall = self.blocked_nav = None  # flags describe the current navigation only
        self.check_url(url)
        page = await self.page()
        physical = self.physical(url)
        self.note(f"open {_short(url)}")
        try:
            await page.goto(physical, wait_until="domcontentloaded", timeout=min(45_000, self.remaining() * 1000))
        except Exception as exc:
            self._raise_nav_flags()
            raise _Stop("failed", f"could not open {_short(url)}: {str(exc).splitlines()[0]}") from exc
        try:
            await page.wait_for_load_state("networkidle", timeout=min(6_000, self.remaining() * 1000))
        except Exception:
            pass
        self._raise_nav_flags()
        self.final_url = page.url
        return page

    def _raise_nav_flags(self) -> None:
        if self.login_wall:
            raise _Stop("needs_login", f"the link leads to a sign-in page ({urlsplit(self.login_wall).hostname}); "
                                       "it is not shared publicly")
        if self.blocked_nav:
            raise _Stop("blocked", f"the page tried to leave the approved hosts ({urlsplit(self.blocked_nav).hostname})")

    async def close(self) -> None:
        for closer in (
            (self._context.close if self._context is not None else None),
            (self._browser.close if self._browser is not None else None),
            (self._pw.stop if self._pw is not None else None),
            (self._client.aclose if self._client is not None else None),
        ):
            if closer is None:
                continue
            try:
                await closer()
            except Exception:
                pass


def _short(url: str, limit: int = 120) -> str:
    return url if len(url) <= limit else url[: limit - 1] + "…"


def _is_login_url(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host_matches(host, LOGIN_HOSTS):
        return True
    path = parts.path.lower()
    if re.search(r"/(servicelogin|signin|sign-in|login|oauth2/authorize|saml2)(/|$|\?)", path):
        return True
    return False


def _human(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def _html_state(text: str, status: int = 200) -> Status | None:
    """expired / needs_login from a service's HTML page (None when unclear)."""
    if status in (404, 410) or _EXPIRED_RE.search(text or ""):
        return "expired"
    low = (text or "").lower()
    if status in (401, 403) or _LOGIN_TEXT_RE.search(text or "") or re.search(r"<input[^>]+type=[\"']?password", low):
        return "needs_login"
    return None


# --------------------------------------------------------------------------- HTTP plumbing
async def _fetch(
    run: _Run,
    url: str,
    *,
    method: str = "GET",
    name_hint: str | None = None,
    subdir: str = "",
    headers: dict[str, str] | None = None,
) -> _Fetched:
    """GET ``url`` following redirects hop by hop (host checks on each). Files are streamed to
    disk; HTML pages are returned as text for the strategy to interpret."""
    client = run.http()
    logical = url
    for _hop in range(12):
        run.check_url(logical)
        request = client.build_request(method, run.physical(logical), headers=headers)
        response = await client.send(request, stream=True)
        try:
            if response.is_redirect and response.headers.get("location"):
                nxt = urljoin(logical, response.headers["location"])
                run.note(f"{response.status_code} -> {_short(nxt)}")
                logical = nxt
                if response.status_code in (301, 302, 303):
                    method = "GET"
                continue
            run.final_url = logical
            ctype = response.headers.get("content-type", "").lower()
            disposition = response.headers.get("content-disposition", "")
            is_page = ctype.startswith(("text/html", "application/xhtml")) and "attachment" not in disposition.lower()
            if response.status_code >= 400 or is_page:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body += chunk
                    if len(body) > 3_000_000:
                        break
                try:
                    text = bytes(body).decode(response.encoding or "utf-8", errors="replace")
                except LookupError:  # unknown charset label
                    text = bytes(body).decode("utf-8", errors="replace")
                run.note(f"{response.status_code} page {_short(logical)} ({ctype.split(';')[0] or 'no type'})")
                return _Fetched("page", logical, response.status_code, text=text, content_type=ctype)
            saved = await _save_stream(run, response, logical, name_hint, subdir)
            return _Fetched("file", logical, response.status_code, file=saved, content_type=ctype)
        finally:
            await response.aclose()
    raise _Stop("failed", "too many redirects")


async def _save_stream(run: _Run, response: httpx.Response, url: str, name_hint: str | None, subdir: str) -> DownloadedFile | None:
    ctype = response.headers.get("content-type", "")
    name = (
        filename_from_content_disposition(response.headers.get("content-disposition"))
        or name_hint
        or name_from_url(url)
        or "download"
    )
    name = sanitize_filename(name)
    reason = blocked_reason(name)
    if reason:
        run.skipped.append({"name": name, "reason": reason, "url": url})
        run.note(f"refused {name}: {reason}")
        return None
    length = int(response.headers.get("content-length") or 0)
    if length and run.total_bytes + length > run.max_bytes:
        raise _Stop("failed", f"{name} is {_human(length)}, above the {_human(run.max_bytes)} download limit")
    target_dir = (run.dest / subdir) if subdir else run.dest
    target_dir.mkdir(parents=True, exist_ok=True)
    tmp = target_dir / f".{uuid.uuid4().hex}.part"
    digest = hashlib.sha256()
    size = 0
    head = b""
    try:
        with open(tmp, "wb") as fh:
            async for chunk in response.aiter_bytes(1 << 16):
                if not chunk:
                    continue
                if len(head) < 64:
                    head = (head + chunk)[:64]
                    exe = sniff_executable(head)
                    if exe:
                        run.skipped.append({"name": name, "reason": f"content is a {exe}; refused", "url": url})
                        run.note(f"refused {name}: content is a {exe}")
                        return None
                size += len(chunk)
                if run.total_bytes + size > run.max_bytes:
                    raise _Stop("failed", f"{name} exceeds the {_human(run.max_bytes)} download limit")
                digest.update(chunk)
                fh.write(chunk)
        if size == 0:
            run.skipped.append({"name": name, "reason": "empty file", "url": url})
            run.note(f"{name} was empty")
            return None
        name = with_extension(name, ctype, head)
        final = unique_path(target_dir, name)
        os.replace(tmp, final)
    finally:
        if tmp.exists():
            tmp.unlink()
    run.total_bytes += size
    saved = DownloadedFile(
        path=str(final),
        name=final.name,
        size=size,
        sha256=digest.hexdigest(),
        mime=sniff_mime(head, final.name, ctype),
        source_url=url,
        rel_path=final.relative_to(run.dest).as_posix(),
    )
    run.files.append(saved)
    run.note(f"saved {saved.rel_path} ({_human(size)})")
    return saved


async def _save_download(run: _Run, download: Any, subdir: str = "") -> DownloadedFile | None:
    """Persist a Playwright download with the same checks as streamed files."""
    name = sanitize_filename(download.suggested_filename or name_from_url(download.url) or "download")
    reason = blocked_reason(name)
    if reason:
        await download.cancel()
        run.skipped.append({"name": name, "reason": reason, "url": download.url})
        run.note(f"refused {name}: {reason}")
        return None
    try:
        run.check_url(download.url)
    except _Stop:
        await download.cancel()
        raise
    tmp_path = await download.path()
    if tmp_path is None:
        raise _Stop("failed", f"browser download failed: {await download.failure()}")
    size = os.path.getsize(tmp_path)
    if run.total_bytes + size > run.max_bytes:
        await download.delete()
        raise _Stop("failed", f"{name} is {_human(size)}, above the {_human(run.max_bytes)} download limit")
    with open(tmp_path, "rb") as fh:
        head = fh.read(64)
    exe = sniff_executable(head)
    if exe:
        await download.delete()
        run.skipped.append({"name": name, "reason": f"content is a {exe}; refused", "url": download.url})
        return None
    target_dir = (run.dest / subdir) if subdir else run.dest
    target_dir.mkdir(parents=True, exist_ok=True)
    final = unique_path(target_dir, with_extension(name, None, head))
    await download.save_as(str(final))
    digest = hashlib.sha256()
    with open(final, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    run.total_bytes += size
    saved = DownloadedFile(
        path=str(final),
        name=final.name,
        size=size,
        sha256=digest.hexdigest(),
        mime=sniff_mime(head, final.name),
        source_url=download.url,
        rel_path=final.relative_to(run.dest).as_posix(),
    )
    run.files.append(saved)
    run.note(f"saved {saved.rel_path} ({_human(size)}) from the browser")
    return saved


# --------------------------------------------------------------------------- browser helpers
async def _evidence(run: _Run, label: str) -> None:
    """Screenshot + HTML of the current page into ``dest_dir/_evidence``."""
    page = run._page
    if page is None or page.is_closed():
        return
    folder = run.dest / "_evidence"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    png = folder / f"{stamp}-{label}.png"
    try:
        await page.screenshot(path=str(png), full_page=True, timeout=15_000)
        run.screenshots.append(str(png))
    except Exception as exc:
        run.note(f"screenshot failed: {exc}")
    try:
        html_path = folder / f"{stamp}-{label}.html"
        html_path.write_text(await page.content(), encoding="utf-8")
        run.evidence.append(str(html_path))
    except Exception:
        pass


async def _dismiss_overlays(run: _Run, page: Any, rounds: int = 3) -> None:
    """Accept cookie / terms dialogs (only buttons, never forms with inputs)."""
    for _ in range(rounds):
        clicked = False
        for selector in ("#onetrust-accept-btn-handler", "button#accept", "[data-testid='accept-cookies']"):
            loc = page.locator(selector)
            try:
                if await loc.count() and await loc.first.is_visible():
                    await loc.first.click(timeout=3_000)
                    run.note(f"accepted dialog ({selector})")
                    clicked = True
            except Exception:
                pass
        for role in ("button", "link"):
            loc = page.get_by_role(role, name=_ACCEPT_RE)
            try:
                count = await loc.count()
            except Exception:
                count = 0
            for i in range(min(count, 4)):
                el = loc.nth(i)
                try:
                    if await el.is_visible():
                        label = (await el.inner_text(timeout=1_000)).strip()[:40]
                        await el.click(timeout=3_000)
                        run.note(f"clicked '{label}'")
                        clicked = True
                except Exception:
                    continue
        if not clicked:
            return
        await page.wait_for_timeout(400)


async def _page_state(page: Any) -> Status | None:
    if _is_login_url(page.url):
        return "needs_login"
    try:
        text = (await page.inner_text("body", timeout=5_000))[:30_000]
    except Exception:
        text = ""
    if _EXPIRED_RE.search(text):
        return "expired"
    try:
        pw = page.locator("input[type=password]")
        if await pw.count() and await pw.first.is_visible():
            return "needs_login"
    except Exception:
        pass
    if _LOGIN_TEXT_RE.search(text) and len(text) < 4_000:
        return "needs_login"
    return None


async def _click_download(run: _Run, page: Any, subdir: str = "", extra_selectors: tuple[str, ...] = ()) -> bool:
    """Click the most obvious Download control and keep the file it produces."""
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    candidates = [page.locator(sel) for sel in extra_selectors]
    candidates += [
        page.get_by_role("button", name=_DOWNLOAD_RE),
        page.get_by_role("link", name=_DOWNLOAD_RE),
        page.locator("[data-testid*='download' i]"),
        page.locator("button:has-text('Download')"),
        page.locator("a:has-text('Download')"),
    ]
    tried = 0
    for loc in candidates:
        try:
            count = await loc.count()
        except Exception:
            continue
        for i in range(min(count, 3)):
            el = loc.nth(i)
            try:
                if not await el.is_visible() or not await el.is_enabled():
                    continue
            except Exception:
                continue
            tried += 1
            if tried > 4:
                return False
            try:
                async with page.expect_download(timeout=min(CLICK_WAIT_S * 1000, run.remaining() * 1000)) as info:
                    await el.click(timeout=5_000)
                download = await info.value
            except PlaywrightTimeout:
                run.note("clicked a Download control but no file started")
                await _dismiss_overlays(run, page, rounds=1)
                continue
            except _Stop:
                raise
            except Exception as exc:
                run.note(f"download click failed: {str(exc).splitlines()[0]}")
                continue
            run._raise_nav_flags()
            saved = await _save_download(run, download, subdir)
            return saved is not None or bool(run.skipped)
    return False


# --------------------------------------------------------------------------- strategies
async def _gdrive_page_outcome(run: _Run, fetched: _Fetched) -> str | None:
    """Next URL to try from a Drive HTML page, or raise the terminal status."""
    text = fetched.text
    low = text.lower()
    if "too many users have viewed or downloaded this file" in low or "download quota" in low:
        raise _Stop("failed", "Google Drive download quota exceeded for this file; try later or ask for a new link")
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(text, "lxml")
    form = soup.find("form", id="download-form") or soup.find(
        "form", action=re.compile(r"(download|/uc)", re.I)
    )
    if form is not None and form.get("action"):
        params = {inp.get("name"): inp.get("value", "") for inp in form.find_all("input") if inp.get("name")}
        action = urljoin(fetched.url, form["action"])
        run.note("Drive large-file confirmation page: confirming")
        return action + ("&" if "?" in action else "?") + urlencode(params)
    link = soup.find("a", id="uc-download-link") or soup.find("a", href=re.compile(r"confirm="))
    if link is not None and link.get("href"):
        return urljoin(fetched.url, link["href"])
    token = re.search(r"confirm=([0-9A-Za-z_-]+)", text)
    if token:
        fid = drive_id_from_url(fetched.url)
        if fid:
            return f"https://drive.google.com/uc?export=download&confirm={token.group(1)}&id={fid}"
    for cookie in run.http().cookies.jar:
        if cookie.name.startswith("download_warning"):
            fid = drive_id_from_url(fetched.url)
            if fid:
                return f"https://drive.google.com/uc?export=download&confirm={cookie.value}&id={fid}"
    state = _html_state(text, fetched.status)
    if state:
        raise _Stop(state, "Google Drive: " + ("the file was deleted or the link is wrong" if state == "expired"
                                                 else "the file is not shared publicly (sign-in required)"))
    raise _Stop("failed", f"Google Drive returned a page instead of the file (HTTP {fetched.status})")


async def _gdrive_file(run: _Run, file_id: str, resource_key: str | None = None, *, name_hint: str | None = None,
                       subdir: str = "") -> DownloadedFile | None:
    params = {"export": "download", "id": file_id}
    if resource_key:
        params["resourcekey"] = resource_key
    url = "https://drive.google.com/uc?" + urlencode(params)
    for _attempt in range(4):
        fetched = await _fetch(run, url, name_hint=name_hint, subdir=subdir)
        if fetched.kind == "file":
            return fetched.file
        if fetched.status in (404, 410):
            raise _Stop("expired", "Google Drive: the file was deleted or the link is wrong")
        url = await _gdrive_page_outcome(run, fetched)
    raise _Stop("failed", "Google Drive kept asking for confirmation")


async def _strategy_gdrive_file(run: _Run) -> None:
    file_id = drive_id_from_url(run.url)
    if not file_id:
        raise _Stop("failed", "no Google Drive file id in the link")
    await _gdrive_file(run, file_id, drive_resource_key(run.url))


def _docs_export_url(url: str) -> tuple[str, str] | None:
    match = re.search(r"/(document|spreadsheets|presentation|drawings)/d/(?:e/)?([A-Za-z0-9_-]{10,})", url)
    if not match:
        return None
    doc_type, doc_id = match.groups()
    if doc_type == "spreadsheets":
        return f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=xlsx", ".xlsx"
    if doc_type == "presentation":
        return f"https://docs.google.com/presentation/d/{doc_id}/export/pdf", ".pdf"
    if doc_type == "drawings":
        return f"https://docs.google.com/drawings/d/{doc_id}/export/pdf", ".pdf"
    return f"https://docs.google.com/document/d/{doc_id}/export?format=pdf", ".pdf"


async def _gdocs_export(run: _Run, url: str, *, name_hint: str | None = None, subdir: str = "") -> DownloadedFile | None:
    target = _docs_export_url(url)
    if target is None:
        raise _Stop("failed", "unrecognised Google Docs link")
    export_url, ext = target
    rk = drive_resource_key(url)
    if rk:
        export_url += ("&" if "?" in export_url else "?") + "resourcekey=" + rk
    hint = (sanitize_filename(name_hint) + ext) if name_hint and not name_hint.lower().endswith(ext) else name_hint
    fetched = await _fetch(run, export_url, name_hint=hint, subdir=subdir)
    if fetched.kind == "file":
        return fetched.file
    state = _html_state(fetched.text, fetched.status) or "failed"
    raise _Stop(state, "Google Docs: " + {"expired": "the document was deleted",
                                          "needs_login": "the document is not shared publicly"}.get(state, "export failed"))


async def _strategy_gdocs(run: _Run) -> None:
    await _gdocs_export(run, run.url)


async def _drive_folder(run: _Run, folder_id: str, resource_key: str | None, rel: str, depth: int, seen: set[str]) -> int:
    if folder_id in seen or depth > _MAX_FOLDER_DEPTH:
        return 0
    seen.add(folder_id)
    view = f"https://drive.google.com/embeddedfolderview?id={folder_id}"
    if resource_key:
        view += f"&resourcekey={resource_key}"
    page = await run.goto(view + "#list")
    entries = await page.evaluate(_DRIVE_ENTRIES_JS)
    entries = [e for e in entries if e.get("id") and e["id"] != folder_id]
    if not entries:
        state = await _page_state(page)
        if state:
            await _evidence(run, "drive-folder")
            raise _Stop(state, "Google Drive folder: " + ("deleted or wrong link" if state == "expired" else "not shared publicly"))
        run.note(f"folder {rel or '/'} is empty or not listable")
        return 0
    run.note(f"folder {rel or '/'}: {len(entries)} entries")
    count = 0
    for entry in entries:
        if len(run.files) >= _MAX_FOLDER_FILES:
            run.errors.append(f"stopped after {_MAX_FOLDER_FILES} files")
            break
        title = (entry.get("title") or "").strip()
        try:
            if entry["type"] == "folder":
                if depth + 1 > _MAX_FOLDER_DEPTH:
                    run.errors.append(f"sub-folder '{title}' is deeper than {_MAX_FOLDER_DEPTH} levels; skipped")
                    continue
                sub = f"{rel}/{sanitize_filename(title, 'folder')}" if rel else sanitize_filename(title, "folder")
                count += await _drive_folder(run, entry["id"], entry.get("rk"), sub, depth + 1, seen)
            elif entry["type"] == "docs":
                if await _gdocs_export(run, entry["href"], name_hint=title or None, subdir=rel):
                    count += 1
            else:
                if await _gdrive_file(run, entry["id"], entry.get("rk"), name_hint=title or None, subdir=rel):
                    count += 1
        except _Stop as stop:
            if stop.status == "blocked" and "approved hosts" in stop.error:
                raise
            run.errors.append(f"{title or entry['id']}: {stop.error}")
            run.note(f"skipped {title or entry['id']}: {stop.error}")
    return count


async def _drive_download_all(run: _Run, folder_id: str, resource_key: str | None) -> bool:
    url = f"https://drive.google.com/drive/folders/{folder_id}"
    if resource_key:
        url += f"?resourcekey={resource_key}"
    page = await run.goto(url)
    await _dismiss_overlays(run, page)
    run.note("trying Drive 'Download all'")
    return await _click_download(
        run, page, extra_selectors=("[aria-label='Download all']", "[aria-label*='Download' i]", "text=Download all")
    )


async def _strategy_gdrive_folder(run: _Run) -> None:
    folder_id = drive_id_from_url(run.url)
    if not folder_id:
        raise _Stop("failed", "no Google Drive folder id in the link")
    resource_key = drive_resource_key(run.url)
    await _drive_folder(run, folder_id, resource_key, "", 0, set())
    if not run.files and not run.skipped:
        if not await _drive_download_all(run, folder_id, resource_key):
            await _evidence(run, "drive-folder")
            raise _Stop("failed", "the Drive folder listed no downloadable files")


def _wetransfer_ids(url: str) -> tuple[str, str | None, str] | None:
    match = re.search(r"/downloads/([0-9a-f]{6,})(?:/([0-9a-f]{6,}))?/([0-9a-f]{4,})", url, re.I)
    if not match:
        return None
    transfer_id, middle, last = match.groups()
    return transfer_id, middle, last


async def _resolve_short_link(run: _Run, url: str) -> str:
    client = run.http()
    current = url
    for _ in range(8):
        run.check_url(current)
        response = await client.get(run.physical(current))
        if response.is_redirect and response.headers.get("location"):
            current = urljoin(current, response.headers["location"])
            continue
        break
    run.note(f"short link -> {_short(current)}")
    return current


async def _wetransfer_api(run: _Run, page: Any, ids: tuple[str, str | None, str]) -> str | None:
    transfer_id, recipient_id, security_hash = ids
    payload: dict[str, Any] = {"intent": "entire_transfer", "security_hash": security_hash}
    if recipient_id:
        payload["recipient_id"] = recipient_id
    headers = {"x-requested-with": "XMLHttpRequest", "content-type": "application/json"}
    try:
        token = await page.eval_on_selector("meta[name='csrf-token']", "el => el.content")
        if token:
            headers["x-csrf-token"] = token
    except Exception:
        pass
    origin = urlsplit(page.url)
    api_logical = f"https://wetransfer.com/api/v4/transfers/{transfer_id}/download"
    api_url = run.physical(api_logical)
    if api_url == api_logical and origin.hostname and origin.hostname.endswith("wetransfer.com"):
        api_url = f"{origin.scheme}://{origin.netloc}/api/v4/transfers/{transfer_id}/download"
    run.note("WeTransfer API: requesting direct link")
    response = await page.request.post(api_url, data=payload, headers=headers, timeout=30_000)
    try:
        data = await response.json()
    except Exception:
        data = {}
    data = data if isinstance(data, dict) else {}
    problem = " ".join(str(data.get(k) or "") for k in ("error", "message", "state", "status")).lower()
    if response.status in (404, 410) or "expired" in problem or "deleted" in problem:
        raise _Stop("expired", "WeTransfer: the transfer expired or was deleted")
    direct = data.get("direct_link") or data.get("directLink")
    if not direct:
        run.note(f"WeTransfer API gave no direct link (HTTP {response.status})")
    return direct


async def _strategy_wetransfer(run: _Run) -> None:
    url = run.url
    if (urlsplit(url).hostname or "").lower() == "we.tl":
        url = await _resolve_short_link(run, url)
    ids = _wetransfer_ids(url)
    page = await run.goto(url)
    await _dismiss_overlays(run, page)
    state = await _page_state(page)
    if state:
        await _evidence(run, "wetransfer")
        raise _Stop(state, "WeTransfer: the transfer expired or was deleted" if state == "expired"
                    else "WeTransfer: the transfer is password-protected or needs sign-in")
    if ids is None:
        ids = _wetransfer_ids(page.url) or _wetransfer_ids(await page.content())
    if await _click_download(run, page):
        return
    if ids:
        direct = await _wetransfer_api(run, page, ids)
        if direct:
            fetched = await _fetch(run, direct)
            if fetched.kind == "file":
                return
    state = await _page_state(page)
    await _evidence(run, "wetransfer")
    if state:
        raise _Stop(state, "WeTransfer: " + ("the transfer expired or was deleted" if state == "expired" else "sign-in required"))
    raise _Stop("failed", "could not start the WeTransfer download (page layout not recognised)")


def _set_query(url: str, **values: str) -> str:
    parts = urlsplit(url)
    query = {k: v for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
    for key, value in values.items():
        query[key] = [value]
    flat = [(k, v) for k, vals in query.items() for v in vals]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(flat), parts.fragment))


async def _http_then_page(run: _Run, candidates: list[str], service: str) -> None:
    """Try direct HTTP downloads first; interpret pages; finish with the browser strategy."""
    login: _Stop | None = None
    for candidate in candidates:
        try:
            fetched = await _fetch(run, candidate)
        except _Stop as stop:
            if stop.status == "needs_login":
                login = stop
                continue
            raise
        if fetched.kind == "file":
            if fetched.file is not None or run.skipped:
                return
            continue
        state = _html_state(fetched.text, fetched.status)
        if state == "expired":
            raise _Stop("expired", f"{service}: the shared item was deleted or the link expired")
        if state == "needs_login":
            login = _Stop("needs_login", f"{service}: the link needs sign-in or a password")
    if login is not None:
        raise login  # never type credentials: report it instead of opening a browser
    await _strategy_page(run)


async def _strategy_dropbox(run: _Run) -> None:
    url = run.url
    host = (urlsplit(url).hostname or "").lower()
    direct = url if "dropboxusercontent.com" in host else _set_query(url, dl="1")
    await _http_then_page(run, [direct], "Dropbox")


async def _strategy_onedrive(run: _Run) -> None:
    url = run.url
    host = (urlsplit(url).hostname or "").lower()
    candidates = [_set_query(url, download="1")]
    if host in ("1drv.ms", "onedrive.live.com"):
        encoded = base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")
        candidates.append(f"https://api.onedrive.com/v1.0/shares/u!{encoded}/root/content")
    await _http_then_page(run, candidates, "OneDrive" if run.kind == "onedrive" else "SharePoint")


async def _strategy_direct(run: _Run) -> None:
    fetched = await _fetch(run, run.url)
    if fetched.kind == "file":
        return
    state = _html_state(fetched.text, fetched.status)
    if state:
        raise _Stop(state, "the link " + ("is gone (HTTP %d)" % fetched.status if state == "expired" else "needs sign-in"))
    if fetched.status >= 400:
        raise _Stop("failed", f"HTTP {fetched.status} from {urlsplit(fetched.url).hostname}")
    run.note("the link returned a web page, not a file: opening it in the browser")
    await _strategy_page(run)


async def _copy_cookies(run: _Run) -> None:
    try:
        cookies = await (await run.context()).cookies()
    except Exception:
        return
    jar = run.http().cookies
    for c in cookies:
        try:
            jar.set(c["name"], c["value"], domain=c.get("domain", "").lstrip("."), path=c.get("path", "/"))
        except Exception:
            continue


async def _strategy_page(run: _Run) -> None:
    page = await run.goto(run.url)
    await _dismiss_overlays(run, page)
    await _evidence(run, "page")
    state = await _page_state(page)
    if state:
        raise _Stop(state, "the page says the files expired or were deleted" if state == "expired"
                    else "the page needs sign-in or a password")
    links = await page.evaluate(_LINK_DOWNLOAD_JS)
    if links:
        await _copy_cookies(run)
    tried: set[str] = set()
    for link in links:
        href = unwrap_url(link["href"])
        if href in tried or len(tried) >= _MAX_PAGE_LINKS:
            continue
        tried.add(href)
        try:
            await _fetch(run, href, name_hint=link.get("download") or None)
        except _Stop as stop:
            run.errors.append(f"{_short(href, 80)}: {stop.error}")
            run.note(f"link failed: {stop.error}")
    if run.files:
        return
    if await _click_download(run, page, extra_selectors=("#downloadButton", "a.input.popsok")):
        return
    raise _Stop("unsupported", "no downloadable file found on the page; a screenshot and the HTML were saved as evidence")


async def _strategy_generic(run: _Run) -> None:
    """Unknown pages: a plain GET first (many links are files after all), the browser for HTML."""
    fetched = await _fetch(run, run.url)
    if fetched.kind == "file":
        return
    if fetched.status in (404, 410):
        raise _Stop("expired", f"the page is gone (HTTP {fetched.status})")
    # 401/403 can be bot protection that a real browser passes: let the browser decide
    await _strategy_page(run)


async def _strategy_mega(run: _Run) -> None:
    raise _Stop("unsupported", "MEGA links are decrypted in the browser and cannot be fetched automatically; "
                               "open the link and save the files manually")


_STRATEGIES = {
    "google_drive_file": _strategy_gdrive_file,
    "google_drive_folder": _strategy_gdrive_folder,
    "google_docs": _strategy_gdocs,
    "wetransfer": _strategy_wetransfer,
    "dropbox": _strategy_dropbox,
    "onedrive": _strategy_onedrive,
    "sharepoint": _strategy_onedrive,
    "direct_file": _strategy_direct,
    "mega": _strategy_mega,
    "box": _strategy_generic,
    "mediafire": _strategy_generic,
    "other": _strategy_generic,
}


# --------------------------------------------------------------------------- public API
async def download_link(
    url: str,
    kind: str | None,
    dest_dir: str | os.PathLike[str],
    *,
    timeout_s: float = 180,
    max_bytes: int = 2_000_000_000,
    allowed_hosts: list[str] | tuple[str, ...] | None = None,
    headless: bool = True,
    endpoints: dict[str, str] | None = None,
    browser: Any = None,
) -> DownloadResult:
    """Fetch every file behind ``url`` into ``dest_dir``. Never raises for download problems:
    the outcome is in ``status``/``error``/``log``. Pass ``browser`` to reuse a Playwright
    browser across many links."""
    url = unwrap_url((url or "").strip())
    kind = kind or classify_link(url)
    dest = Path(dest_dir).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    run = _Run(
        url=url,
        kind=kind,
        dest=dest,
        max_bytes=int(max_bytes),
        allowed=list(allowed_hosts) if allowed_hosts is not None else None,
        headless=headless,
        endpoints={k.lower(): v for k, v in (endpoints or {}).items()},
        deadline=time.monotonic() + float(timeout_s),
        external_browser=browser,
    )
    status: Status = "ok"
    error: str | None = None
    strategy = _STRATEGIES.get(kind, _strategy_generic)
    run.note(f"{kind}: {_short(url)}")
    try:
        if not url.lower().startswith(("http://", "https://")):
            raise _Stop("unsupported", "only http(s) links can be downloaded")
        run.check_url(url)
        await asyncio.wait_for(strategy(run), timeout=float(timeout_s))
    except _Stop as stop:
        status, error = stop.status, stop.error
    except asyncio.TimeoutError:
        status, error = "failed", f"timed out after {timeout_s:.0f}s"
    except Exception as exc:  # never let one bad link crash the pipeline
        status, error = "failed", f"{type(exc).__name__}: {str(exc).splitlines()[0] if str(exc) else ''}"
    finally:
        await run.close()

    if run.files:
        if status != "ok":
            run.errors.insert(0, f"{status}: {error}")
        status = "ok"
        error = "; ".join(run.errors) or None
    elif status == "ok":
        if run.skipped:
            status = "blocked"
            error = "; ".join(f"{s['name']}: {s['reason']}" for s in run.skipped)
        else:
            status = "failed"
            error = "; ".join(run.errors) or "no file was downloaded"
    run.note(f"done: {status}" + (f" ({error})" if error else ""))
    return DownloadResult(
        status=status,
        url=url,
        kind=kind,
        files=run.files,
        error=error,
        log=run.log,
        screenshots=run.screenshots,
        evidence=run.evidence,
        final_url=run.final_url,
        skipped=run.skipped,
    )
