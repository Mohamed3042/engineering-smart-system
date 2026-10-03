"""Web search providers and page fetching for customer research and monitoring.

Providers share one small protocol: ``search(query, *, max_results=10, recency_days=None,
country=None, news=False) -> list[SearchResult]``. Keyed APIs (Brave, Tavily, SerpApi), a
best-effort keyless DuckDuckGo HTML scraper, the AI provider's native web search (when the engine
exposes one) and a null provider are available through :func:`get_search_provider`.

:func:`fetch_page_text` downloads a page with httpx and keeps the readable text (navigation,
footers, scripts, cookie banners dropped), the title, description and the publication date found
in the page metadata - everything research needs to verify quotes against the source.
"""
from __future__ import annotations

import hashlib
import html as html_lib
import io
import json
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Protocol, runtime_checkable
from urllib.parse import parse_qs, parse_qsl, unquote, urlencode, urlsplit, urlunsplit

import httpx

log = logging.getLogger(__name__)

USER_AGENT = "Mozilla/5.0 (compatible; EngineeringSmartSystem/0.1; +local research assistant)"
DEFAULT_TIMEOUT = 20.0


class SearchError(RuntimeError):
    """A search provider call failed (network, quota, blocked, bad key...)."""


class SearchUnavailable(SearchError):
    """A saved job can resume when credentials or quota become available."""


class NotSupported(SearchError):
    """The provider cannot do this (e.g. an AI engine without native web search)."""


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str = ""
    published: str | None = None  # ISO date when the provider knows it
    source: str = ""  # provider name
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@runtime_checkable
class SearchProvider(Protocol):
    name: str

    def search(self, query: str, *, max_results: int = 10, recency_days: int | None = None,
               country: str | None = None, news: bool = False) -> list[SearchResult]: ...


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_REL_RE = re.compile(r"(?i)^\s*(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago\s*$")
_TRACKING_PARAMS = frozenset({"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
                              "gclid", "fbclid", "mc_cid", "mc_eid", "igshid", "ref_src", "cmpid", "ocid", "spm",
                              "_ga", "yclid", "msclkid"})


def clean_text(value: Any) -> str:
    text = html_lib.unescape(_TAG_RE.sub("", str(value or "")))
    return re.sub(r"\s+", " ", text).strip()


def parse_published(value: Any, now: datetime | None = None) -> str | None:
    """Provider dates ("2026-09-01T10:00:00", "Sep 1, 2026", "3 days ago", RFC 2822) -> ISO date."""
    if value in (None, ""):
        return None
    now = now or datetime.now(timezone.utc)
    if isinstance(value, datetime):
        return value.date().isoformat()
    text = str(value).strip()
    m = _REL_RE.match(text)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        delta = {"second": timedelta(seconds=n), "minute": timedelta(minutes=n), "hour": timedelta(hours=n),
                 "day": timedelta(days=n), "week": timedelta(weeks=n), "month": timedelta(days=30 * n),
                 "year": timedelta(days=365 * n)}[unit]
        return (now - delta).date().isoformat()
    if text.lower() in ("today", "just now"):
        return now.date().isoformat()
    if text.lower() == "yesterday":
        return (now - timedelta(days=1)).date().isoformat()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        return parsedate_to_datetime(text).date().isoformat()
    except Exception:
        pass
    try:
        from dateutil import parser

        return parser.parse(text, fuzzy=True).date().isoformat()
    except Exception:
        return None


def normalize_url(url: str) -> str:
    """Canonical form for de-duplication: https, no ``www.``, no tracking parameters, fragment or
    trailing slash; remaining query parameters sorted."""
    raw = (url or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = "https://" + raw
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw.lower()
    host = (parts.hostname or "").lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    port = f":{parts.port}" if parts.port and parts.port not in (80, 443) else ""
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if len(path) > 1:
        path = path.rstrip("/")
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                             if k.lower() not in _TRACKING_PARAMS and not k.lower().startswith("utm_")))
    return urlunsplit(("https", host + port, path, query, ""))


def url_hash(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode("utf-8")).hexdigest()


class _Http:
    """Lazily created httpx client (or an injected one, e.g. for tests)."""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT, client: httpx.Client | None = None) -> None:
        self.timeout = timeout
        self._client = client
        self._own = client is None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout, follow_redirects=True,
                                        headers={"User-Agent": USER_AGENT})
        return self._client

    def close(self) -> None:
        if self._own and self._client is not None:
            self._client.close()
            self._client = None

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            r = self.client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            raise SearchError(f"{type(self).__name__}: network request failed ({type(exc).__name__})") from exc
        if r.status_code in (401, 403):
            raise SearchUnavailable(f"{getattr(self, 'name', 'search')}: access denied (HTTP {r.status_code}) - check the API key")
        if r.status_code in (402, 429):
            raise SearchUnavailable(f"{getattr(self, 'name', 'search')}: quota or rate limit reached (HTTP {r.status_code}). Wait for reset or switch connection.")
        if r.status_code >= 400:
            raise SearchError(f"{getattr(self, 'name', 'search')}: HTTP {r.status_code}")
        return r

    def json(self, method: str, url: str, **kwargs: Any) -> Any:
        r = self.request(method, url, **kwargs)
        try:
            return r.json()
        except ValueError as exc:
            raise SearchError(f"{getattr(self, 'name', 'search')}: response is not JSON") from exc


def _clip(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(n)))


# --------------------------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------------------------


class BraveSearch(_Http):
    name = "brave"
    WEB = "https://api.search.brave.com/res/v1/web/search"
    NEWS = "https://api.search.brave.com/res/v1/news/search"

    def __init__(self, api_key: str | None, *, timeout: float = DEFAULT_TIMEOUT, client: httpx.Client | None = None,
                 country: str | None = None) -> None:
        if not api_key:
            raise ValueError("Brave Search needs an API key")
        super().__init__(timeout, client)
        self.api_key = api_key
        self.country = country

    @staticmethod
    def _freshness(days: int) -> str:
        if days <= 1:
            return "pd"
        if days <= 7:
            return "pw"
        if days <= 31:
            return "pm"
        if days <= 366:
            return "py"
        end = datetime.now(timezone.utc).date()
        return f"{(end - timedelta(days=days)).isoformat()}to{end.isoformat()}"

    def search(self, query: str, *, max_results: int = 10, recency_days: int | None = None,
               country: str | None = None, news: bool = False) -> list[SearchResult]:
        params: dict[str, Any] = {"q": query, "count": _clip(max_results, 1, 20)}
        if recency_days:
            params["freshness"] = self._freshness(recency_days)
        if country or self.country:
            params["country"] = (country or self.country or "").upper()
        data = self.json("GET", self.NEWS if news else self.WEB, params=params,
                         headers={"X-Subscription-Token": self.api_key, "Accept": "application/json"})
        items = (data.get("results") if news else (data.get("web") or {}).get("results")) or []
        if not news:
            items = items + ((data.get("news") or {}).get("results") or [])
        out = []
        for it in items[:max_results]:
            if not it.get("url"):
                continue
            out.append(SearchResult(title=clean_text(it.get("title")), url=it["url"],
                                    snippet=clean_text(it.get("description") or " ".join(it.get("extra_snippets") or [])),
                                    published=parse_published(it.get("page_age") or it.get("age")), source=self.name))
        return out


class TavilySearch(_Http):
    name = "tavily"
    ENDPOINT = "https://api.tavily.com/search"

    def __init__(self, api_key: str | None, *, timeout: float = DEFAULT_TIMEOUT,
                 client: httpx.Client | None = None) -> None:
        if not api_key:
            raise ValueError("Tavily needs an API key")
        super().__init__(timeout, client)
        self.api_key = api_key

    def search(self, query: str, *, max_results: int = 10, recency_days: int | None = None,
               country: str | None = None, news: bool = False) -> list[SearchResult]:
        payload: dict[str, Any] = {"query": query, "max_results": _clip(max_results, 1, 20), "search_depth": "basic",
                                   "include_answer": False, "topic": "news" if news else "general"}
        if recency_days:
            payload["time_range"] = ("day" if recency_days <= 1 else "week" if recency_days <= 7
                                     else "month" if recency_days <= 31 else "year")
            if news:
                payload["days"] = int(recency_days)
        data = self.json("POST", self.ENDPOINT, json=payload, headers={"Authorization": f"Bearer {self.api_key}"})
        out = []
        for it in (data.get("results") or [])[:max_results]:
            if it.get("url"):
                out.append(SearchResult(title=clean_text(it.get("title")), url=it["url"],
                                        snippet=clean_text(it.get("content")),
                                        published=parse_published(it.get("published_date")), source=self.name,
                                        meta={"score": it.get("score")}))
        return out


class SerpApiSearch(_Http):
    name = "serpapi"
    ENDPOINT = "https://serpapi.com/search.json"

    def __init__(self, api_key: str | None, *, timeout: float = DEFAULT_TIMEOUT, client: httpx.Client | None = None,
                 country: str | None = None) -> None:
        if not api_key:
            raise ValueError("SerpApi needs an API key")
        super().__init__(timeout, client)
        self.api_key = api_key
        self.country = country

    def search(self, query: str, *, max_results: int = 10, recency_days: int | None = None,
               country: str | None = None, news: bool = False) -> list[SearchResult]:
        params: dict[str, Any] = {"engine": "google", "q": query, "api_key": self.api_key,
                                  "num": _clip(max_results, 1, 100)}
        if recency_days:
            params["tbs"] = "qdr:" + ("d" if recency_days <= 1 else "w" if recency_days <= 7
                                      else "m" if recency_days <= 31 else "y")
        if country or self.country:
            params["gl"] = (country or self.country or "").lower()
        if news:
            params["tbm"] = "nws"
        data = self.json("GET", self.ENDPOINT, params=params)
        if data.get("error"):
            raise SearchError(f"serpapi: {data['error']}")
        items = (data.get("news_results") if news else data.get("organic_results")) or []
        out = []
        for it in items[:max_results]:
            link = it.get("link")
            if link:
                out.append(SearchResult(title=clean_text(it.get("title")), url=link, snippet=clean_text(it.get("snippet")),
                                        published=parse_published(it.get("date")), source=self.name))
        return out


class DuckDuckGoHtml(_Http):
    """Keyless, best-effort scraping of DuckDuckGo's HTML endpoint (may be blocked or change)."""

    name = "duckduckgo"
    ENDPOINT = "https://html.duckduckgo.com/html/"

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT, client: httpx.Client | None = None,
                 region: str | None = None) -> None:
        super().__init__(timeout, client)
        self.region = region

    @staticmethod
    def _target(href: str) -> str:
        if not href:
            return ""
        if href.startswith("//"):
            href = "https:" + href
        parts = urlsplit(href)
        if "duckduckgo.com" in (parts.hostname or "") and parts.path.startswith("/l/"):
            target = parse_qs(parts.query).get("uddg", [""])[0]
            return unquote(target)
        return href

    def search(self, query: str, *, max_results: int = 10, recency_days: int | None = None,
               country: str | None = None, news: bool = False) -> list[SearchResult]:
        from bs4 import BeautifulSoup

        params: dict[str, Any] = {"q": query}
        if recency_days:
            params["df"] = "d" if recency_days <= 1 else "w" if recency_days <= 7 else "m" if recency_days <= 31 else "y"
        if self.region:
            params["kl"] = self.region
        r = self.request("GET", self.ENDPOINT, params=params, headers={"Accept": "text/html"})
        if r.status_code == 202 or "anomaly" in r.text[:5000].lower():
            raise SearchError("duckduckgo: request was blocked (anomaly page)")
        soup = BeautifulSoup(r.text, "lxml")
        out: list[SearchResult] = []
        for res in soup.select("div.result"):
            if "result--ad" in (res.get("class") or []):
                continue
            a = res.select_one("a.result__a")
            if a is None:
                continue
            url = self._target(a.get("href") or "")
            if not url.startswith("http"):
                continue
            snippet = res.select_one(".result__snippet")
            stamp = res.select_one(".result__timestamp")
            out.append(SearchResult(title=clean_text(a.get_text(" ")), url=url,
                                    snippet=clean_text(snippet.get_text(" ") if snippet else ""),
                                    published=parse_published(stamp.get_text(" ")) if stamp else None,
                                    source=self.name))
            if len(out) >= max_results:
                break
        return out


class AiWebSearch:
    """The AI provider's own web search, when the engine exposes ``web_search(query, ...)``."""

    name = "ai"

    def __init__(self, engine: Any) -> None:
        self.engine = engine

    def supported(self) -> bool:
        return callable(getattr(self.engine, "web_search", None))

    def search(self, query: str, *, max_results: int = 10, recency_days: int | None = None,
               country: str | None = None, news: bool = False) -> list[SearchResult]:
        fn = getattr(self.engine, "web_search", None)
        if not callable(fn):
            raise NotSupported("the selected AI engine has no native web search")
        try:
            raw = fn(query, max_results=max_results, recency_days=recency_days)
        except TypeError:
            raw = fn(query, max_results=max_results)
        out = []
        for it in raw or []:
            get = it.get if isinstance(it, Mapping) else (lambda k, d=None, _it=it: getattr(_it, k, d))
            url = get("url") or get("link")
            if url:
                out.append(SearchResult(title=clean_text(get("title")), url=str(url),
                                        snippet=clean_text(get("snippet") or get("description") or get("content")),
                                        published=parse_published(get("published") or get("date")), source=self.name))
        return out[:max_results]


class NullSearch:
    """No web search configured: research falls back to our own evidence."""

    name = "none"

    def search(self, query: str, *, max_results: int = 10, recency_days: int | None = None,
               country: str | None = None, news: bool = False) -> list[SearchResult]:
        return []


def get_search_provider(config: Mapping[str, Any] | None = None, **overrides: Any) -> SearchProvider:
    """``{"provider": "brave"|"tavily"|"serpapi"|"duckduckgo"|"ai"|"none"|"auto", "api_key": ..., "engine":
    ..., "timeout": 20, "country": "KW"}`` -> provider. ``auto`` picks the first keyed provider in the config
    (``brave_api_key``, ``tavily_api_key``, ``serpapi_api_key``), then the engine's native search, then
    DuckDuckGo. Unknown keys in the config are ignored."""
    cfg = {**(config or {}), **overrides}
    name = str(cfg.get("provider") or cfg.get("kind") or cfg.get("name") or "auto").strip().lower()
    name = name.replace("-", "_").replace(" ", "_")
    key = cfg.get("api_key") or cfg.get(f"{name}_api_key") or cfg.get("key") or cfg.get("token")
    common = {"timeout": float(cfg.get("timeout") or DEFAULT_TIMEOUT), "client": cfg.get("client")}
    if name in ("brave", "brave_search"):
        return BraveSearch(key, country=cfg.get("country"), **common)
    if name in ("exa", "firecrawl"):
        from .hosted_search import ExaSearch, FirecrawlSearch

        return (ExaSearch if name == "exa" else FirecrawlSearch)(key, **common)
    if name == "tavily":
        return TavilySearch(key, **common)
    if name in ("serpapi", "serp_api", "serp", "google"):
        return SerpApiSearch(key, country=cfg.get("country") or cfg.get("gl"), **common)
    if name in ("duckduckgo", "ddg", "duckduckgo_html", "duck_duck_go"):
        return DuckDuckGoHtml(region=cfg.get("region"), **common)
    if name in ("ai", "native", "engine", "ai_native", "provider_native"):
        return AiWebSearch(cfg.get("engine"))
    if name in ("none", "off", "disabled", "null"):
        return NullSearch()
    if name == "auto":
        for prov in ("brave", "tavily", "serpapi"):
            if cfg.get(f"{prov}_api_key"):
                return get_search_provider({**cfg, "provider": prov, "api_key": cfg[f"{prov}_api_key"]})
        engine = cfg.get("engine")
        if engine is not None and callable(getattr(engine, "web_search", None)):
            return AiWebSearch(engine)
        return DuckDuckGoHtml(**common)
    raise ValueError(f"unknown search provider {name!r}")


# --------------------------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------------------------


@dataclass
class PageText:
    url: str
    final_url: str = ""
    title: str = ""
    text: str = ""
    description: str = ""
    published: str | None = None
    site_name: str = ""
    status_code: int | None = None
    content_type: str = ""
    fetched_at: str = ""
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and bool(self.text or self.title)

    def full_text(self) -> str:
        """Title, description and body: the text quotes are verified against."""
        return "\n".join(p for p in (self.title, self.description, self.text) if p)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_BLOCK_TAGS = ("p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "table", "section",
               "article", "main", "blockquote", "pre", "dd", "dt", "dl", "figcaption", "address", "td", "th", "hr")
_DROP_TAGS = ("script", "style", "noscript", "template", "svg", "iframe", "form", "button", "nav", "footer", "aside",
              "select", "input", "canvas", "object", "embed")
_JUNK_TOKENS = ("cookie", "consent", "newsletter", "subscribe", "menu", "navbar", "breadcrumb", "share", "social",
                "footer", "sidebar", "advert", "ads", "popup", "modal", "banner", "skip-link", "related")
_JUNK_ROLES = ("navigation", "banner", "contentinfo", "search", "complementary", "dialog", "menu")
_META_PUBLISHED = ("article:published_time", "og:published_time", "datepublished", "pubdate", "publishdate",
                   "publish_date", "publication_date", "date", "dc.date", "dc.date.issued", "dcterms.created",
                   "dcterms.issued", "sailthru.date", "parsely-pub-date", "article.published", "release_date")


def _published_from_soup(soup: Any) -> str | None:
    for tag in soup.find_all("meta"):
        key = (tag.get("property") or tag.get("name") or tag.get("itemprop") or "").strip().lower()
        if key in _META_PUBLISHED and tag.get("content"):
            p = parse_published(tag["content"])
            if p:
                return p
    for script in soup.find_all("script", attrs={"type": re.compile("ld\\+json", re.I)}):
        try:
            data = json.loads(script.string or script.get_text() or "")
        except (ValueError, TypeError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                if node.get("datePublished"):
                    p = parse_published(node["datePublished"])
                    if p:
                        return p
                stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
    el = soup.find(attrs={"itemprop": "datePublished"})
    if el is not None:
        p = parse_published(el.get("content") or el.get("datetime") or el.get_text(" "))
        if p:
            return p
    t = soup.find("time")
    if t is not None:
        return parse_published(t.get("datetime") or t.get_text(" "))
    return None


def _is_junk(tag: Any) -> bool:
    if getattr(tag, "attrs", None) is None:
        return False
    role = str(tag.get("role") or "").lower()
    if role in _JUNK_ROLES:
        return True
    tokens = " ".join([*(tag.get("class") or []), str(tag.get("id") or "")]).lower()
    words = set(re.split(r"[\s_\-]+", tokens))
    return any(j in words for j in _JUNK_TOKENS) or "cookie" in tokens


def page_from_html(markup: str, url: str = "", *, status_code: int | None = None,
                   now: datetime | None = None) -> PageText:
    """Readable text of an HTML page (no fetching) - also used by tests and fake providers."""
    from bs4 import BeautifulSoup, NavigableString

    soup = BeautifulSoup(markup or "", "lxml")

    def meta(*names: str) -> str:
        for n in names:
            tag = soup.find("meta", attrs={"property": n}) or soup.find("meta", attrs={"name": n})
            if tag and tag.get("content"):
                return clean_text(tag["content"])
        return ""

    title = meta("og:title") or clean_text(soup.title.get_text(" ") if soup.title else "")
    if not title:
        h1 = soup.find("h1")
        title = clean_text(h1.get_text(" ")) if h1 else ""
    description = meta("description", "og:description", "twitter:description")
    site_name = meta("og:site_name", "application-name")
    published = _published_from_soup(soup)
    for tag in soup(list(_DROP_TAGS)):
        tag.decompose()
    for tag in soup.find_all(True):
        if tag.parent is not None and tag.name not in ("html", "body") and _is_junk(tag):
            tag.decompose()
    for tag in soup.find_all(list(_BLOCK_TAGS)):
        tag.insert_before(NavigableString("\n"))
        tag.insert_after(NavigableString("\n"))
    root = soup.find("article") or soup.find("main") or soup.find(attrs={"role": "main"})
    body = soup.body or soup
    if root is None or len(root.get_text(" ", strip=True)) < 200:
        root = body
    for header in root.find_all("header"):
        if header.find("nav") is not None or len(header.get_text(" ", strip=True)) < 120:
            header.decompose()
    raw = root.get_text()
    lines = []
    for line in raw.splitlines():
        line = re.sub(r"[ \t ​]+", " ", line).strip()
        if line and (not lines or lines[-1] != line):
            lines.append(line)
    stamp = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds").replace("+00:00", "Z")
    return PageText(url=url, final_url=url, title=title, text="\n".join(lines), description=description,
                    published=published, site_name=site_name, status_code=status_code, content_type="text/html",
                    fetched_at=stamp)


def fetch_page_text(url: str, *, client: httpx.Client | None = None, timeout: float = DEFAULT_TIMEOUT,
                    max_bytes: int = 3_000_000, now: datetime | None = None) -> PageText:
    """Download ``url`` and return its readable text. Never raises: failures set ``error``."""
    stamp = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds").replace("+00:00", "Z")
    own = client is None
    http = client or httpx.Client(timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT})
    try:
        try:
            r = http.get(url, headers={"User-Agent": USER_AGENT,
                                       "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5"})
        except httpx.HTTPError as exc:
            return PageText(url=url, fetched_at=stamp, error=f"{type(exc).__name__}: {exc}")
        final = str(r.url)
        ctype = r.headers.get("content-type", "").lower()
        if r.status_code >= 400:
            return PageText(url=url, final_url=final, status_code=r.status_code, content_type=ctype,
                            fetched_at=stamp, error=f"HTTP {r.status_code}")
        content = r.content[:max_bytes]
        if "pdf" in ctype or final.lower().split("?")[0].endswith(".pdf"):
            try:
                from pypdf import PdfReader

                reader = PdfReader(io.BytesIO(content))
                text = "\n".join((p.extract_text() or "") for p in reader.pages[:60])
            except Exception as exc:
                return PageText(url=url, final_url=final, status_code=r.status_code, content_type=ctype,
                                fetched_at=stamp, error=f"PDF unreadable: {exc}")
            return PageText(url=url, final_url=final, text=text.strip(), status_code=r.status_code,
                            content_type=ctype, fetched_at=stamp)
        if "html" in ctype or "xml" in ctype or not ctype or content.lstrip()[:1] == b"<":
            markup = content.decode(r.encoding or "utf-8", errors="replace")
            page = page_from_html(markup, url, status_code=r.status_code, now=now)
            page.final_url = final
            page.content_type = ctype or "text/html"
            return page
        if ctype.startswith("text/"):
            return PageText(url=url, final_url=final, text=content.decode(r.encoding or "utf-8", errors="replace"),
                            status_code=r.status_code, content_type=ctype, fetched_at=stamp)
        return PageText(url=url, final_url=final, status_code=r.status_code, content_type=ctype, fetched_at=stamp,
                        error=f"unsupported content type {ctype}")
    finally:
        if own:
            http.close()
