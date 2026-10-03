"""Exa search and Firecrawl v2 search/page reading. No crawl or paid upgrade fallback."""
from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from .search import PageText, SearchError, SearchResult, _Http, _clip, clean_text, parse_published


class ExaSearch(_Http):
    name = "exa"

    def __init__(self, api_key: str | None, **kwargs):
        if not api_key:
            raise ValueError("Exa needs an API key")
        super().__init__(**kwargs)
        self.api_key = api_key

    def search(self, query, *, max_results=10, recency_days=None, country=None, news=False):
        body = {"query": query, "numResults": _clip(max_results, 1, 10), "type": "fast",
                "contents": {"highlights": True}}
        if news:
            body["category"] = "news"
        if recency_days:
            body["startPublishedDate"] = (datetime.now(timezone.utc) - timedelta(days=recency_days)).isoformat()
        data = self.json("POST", "https://api.exa.ai/search", json=body, headers={"x-api-key": self.api_key})
        return [SearchResult(title=clean_text(row.get("title")), url=row["url"],
                             snippet=clean_text(" ".join(row.get("highlights") or []) or row.get("text")),
                             published=parse_published(row.get("publishedDate")), source=self.name)
                for row in (data.get("results") or [])[:max_results] if row.get("url")]


def public_page_url(url: str) -> None:
    """Only public website addresses belong in a hosted page reader."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme not in ("https", "http") or not host or parts.username or parts.password:
        raise SearchError("Page reading needs a public http(s) website URL without credentials.")
    if "." not in host or host.endswith((".localhost", ".local", ".internal", ".lan")):
        raise SearchError("Local network addresses cannot be sent to the page service.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return
    if not address.is_global:
        raise SearchError("Private network addresses cannot be sent to the page service.")


class FirecrawlSearch(_Http):
    name = "firecrawl"

    def __init__(self, api_key: str | None, **kwargs):
        if not api_key:
            raise ValueError("Firecrawl needs an API key")
        super().__init__(**kwargs)
        self.api_key = api_key

    def _post(self, path, body):
        data = self.json("POST", "https://api.firecrawl.dev/v2/" + path, json=body,
                         headers={"Authorization": f"Bearer {self.api_key}"})
        if data.get("success") is not True:
            raise SearchError("Firecrawl could not complete the request. Check your account and retry.")
        return data.get("data") or {}

    def search(self, query, *, max_results=10, recency_days=None, country=None, news=False):
        source = "news" if news else "web"
        body = {"query": query, "limit": _clip(max_results, 1, 10), "sources": [source]}
        if country:
            body["country"] = country.upper()
        if recency_days:
            body["tbs"] = f"qdr:d{int(recency_days)}"
        # Search only; pages are scraped individually, bounded by the research standard.
        data = self._post("search", body)
        return [SearchResult(title=clean_text(row.get("title")), url=row["url"],
                             snippet=clean_text(row.get("description") or row.get("snippet")),
                             published=parse_published(row.get("date") or row.get("publishedDate")), source=self.name)
                for row in (data.get(source) or [])[:max_results] if row.get("url")]

    def fetch_page(self, url: str, **kwargs) -> PageText:
        public_page_url(url)
        data = self._post("scrape", {"url": url, "formats": ["markdown"], "onlyMainContent": True})
        meta = data.get("metadata") or {}
        status = meta.get("statusCode", 200)
        text = data.get("markdown") or ""
        return PageText(url=url, final_url=meta.get("sourceURL") or url, title=clean_text(meta.get("title")),
                        text=text, description=clean_text(meta.get("description")),
                        published=parse_published(meta.get("publishedTime") or meta.get("article:published_time")),
                        status_code=status, content_type="text/markdown", fetched_at=datetime.now(timezone.utc).isoformat(),
                        error=f"Page HTTP {status}" if status >= 400 else (None if text else "No readable page content"))
