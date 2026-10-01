"""ess.customers.search: providers (mocked with respx), factory, page fetching and URL helpers."""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest
import respx

from ess.customers.search import (
    AiWebSearch,
    BraveSearch,
    DuckDuckGoHtml,
    NotSupported,
    NullSearch,
    SearchError,
    SerpApiSearch,
    TavilySearch,
    fetch_page_text,
    get_search_provider,
    normalize_url,
    page_from_html,
    parse_published,
    url_hash,
)


def _pdf(text: str) -> bytes:
    content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)


@respx.mock
def test_brave_search_parses_results_and_sends_key():
    route = respx.route(method="GET", host="api.search.brave.com", path="/res/v1/web/search").mock(
        return_value=httpx.Response(200, json={"web": {"results": [
            {"title": "Gulf <strong>Horizon</strong>", "url": "https://gulfhorizon.example/",
             "description": "Leading <strong>contractor</strong> in Kuwait", "page_age": "2026-08-01T00:00:00"},
            {"title": "No url"}]}}))
    res = BraveSearch("brave-key").search("Gulf Horizon", max_results=5, recency_days=365)
    req = route.calls.last.request
    assert req.headers["X-Subscription-Token"] == "brave-key"
    assert req.url.params["freshness"] == "py" and req.url.params["count"] == "5"
    assert [(r.title, r.url, r.snippet, r.published, r.source) for r in res] == [
        ("Gulf Horizon", "https://gulfhorizon.example/", "Leading contractor in Kuwait", "2026-08-01", "brave")]


@respx.mock
def test_tavily_and_serpapi():
    tav = respx.route(method="POST", host="api.tavily.com", path="/search").mock(return_value=httpx.Response(
        200, json={"results": [{"title": "T1", "url": "https://a.example/1", "content": "c1",
                                "published_date": "Mon, 01 Sep 2026 10:00:00 GMT"}]}))
    res = TavilySearch("tv-key").search("q", news=True, recency_days=30)
    body = tav.calls.last.request.content.decode()
    assert '"topic":"news"' in body.replace(" ", "") and tav.calls.last.request.headers["Authorization"] == "Bearer tv-key"
    assert res[0].published == "2026-09-01" and res[0].snippet == "c1"
    serp = respx.route(method="GET", host="serpapi.com", path="/search.json").mock(return_value=httpx.Response(
        200, json={"organic_results": [{"title": "S1", "link": "https://b.example/", "snippet": "s", "date": "Sep 2, 2026"}]}))
    res = SerpApiSearch("sp-key", country="KW").search("q", recency_days=7)
    params = serp.calls.last.request.url.params
    assert params["tbs"] == "qdr:w" and params["gl"] == "kw" and params["api_key"] == "sp-key"
    assert res[0].url == "https://b.example/" and res[0].published == "2026-09-02"


@respx.mock
def test_duckduckgo_html_decodes_redirect_links_and_skips_ads():
    html = """<html><body>
    <div class="result result--ad"><a class="result__a" href="https://ads.example/">Ad</a></div>
    <div class="result results_links"><h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.gulfhorizon.example%2Fabout&amp;rut=x">Gulf
      <b>Horizon</b> - About</a></h2>
      <a class="result__snippet">Gulf Horizon Contracting Co. is a leading contractor.</a></div>
    </body></html>"""
    respx.route(method="GET", host="html.duckduckgo.com").mock(return_value=httpx.Response(200, text=html))
    res = DuckDuckGoHtml().search("gulf horizon", recency_days=365)
    assert [(r.url, r.title) for r in res] == [("https://www.gulfhorizon.example/about", "Gulf Horizon - About")]
    assert res[0].snippet.startswith("Gulf Horizon Contracting")


@respx.mock
def test_provider_errors():
    respx.route(host="api.search.brave.com").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(SearchError, match="API key"):
        BraveSearch("bad").search("x")
    respx.route(host="html.duckduckgo.com").mock(side_effect=httpx.ConnectError("blocked"))
    with pytest.raises(SearchError):
        DuckDuckGoHtml().search("x")
    with pytest.raises(ValueError):
        BraveSearch(None)


def test_ai_web_search_and_null_provider():
    with pytest.raises(NotSupported):
        AiWebSearch(object()).search("x")

    class Engine:
        def web_search(self, query, max_results=10):
            return [{"title": "A", "url": "https://a.example", "snippet": "s", "date": "2026-09-01"}, {"title": "no url"}]

    res = AiWebSearch(Engine()).search("x")
    assert [(r.url, r.published, r.source) for r in res] == [("https://a.example", "2026-09-01", "ai")]
    assert NullSearch().search("anything") == []


def test_get_search_provider_factory():
    assert isinstance(get_search_provider({"provider": "duckduckgo", "api_key": None, "base_url": "x"}), DuckDuckGoHtml)
    assert get_search_provider({"provider": "brave", "api_key": "k"}).name == "brave"
    assert isinstance(get_search_provider({"provider": "Tavily", "api_key": "k"}), TavilySearch)
    assert isinstance(get_search_provider({"provider": "serpapi", "api_key": "k"}), SerpApiSearch)
    assert isinstance(get_search_provider({"provider": "none"}), NullSearch)
    assert isinstance(get_search_provider({"tavily_api_key": "k"}), TavilySearch)  # auto
    assert isinstance(get_search_provider({}), DuckDuckGoHtml)
    assert isinstance(get_search_provider({"provider": "ai", "engine": object()}), AiWebSearch)
    with pytest.raises(ValueError):
        get_search_provider({"provider": "brave"})  # no key
    with pytest.raises(ValueError):
        get_search_provider({"provider": "altavista"})


ARTICLE = """<!doctype html><html><head><title>Ignored title</title>
<meta property="og:title" content="Gulf Horizon wins Jahra Hospital contract">
<meta name="description" content="Kuwait contractor wins hospital deal.">
<meta property="article:published_time" content="2026-08-15T09:00:00Z">
<script type="application/ld+json">{"@type": "NewsArticle", "datePublished": "2026-08-14"}</script>
</head><body>
<header><nav><a href="/">Home</a> <a href="/news">News</a></nav></header>
<div class="cookie-banner">We use cookies. Accept all cookies?</div>
<article><h1>Gulf Horizon wins Jahra Hospital contract</h1>
<p>Gulf Horizon Contracting has been <b>awarded</b> a contract to build the Jahra Hospital extension.</p>
<p>Work is expected to start in the fourth quarter.</p></article>
<aside>Related stories</aside><footer>Copyright 2026 News Co.</footer><script>track()</script>
</body></html>"""


def test_page_from_html_keeps_readable_text_and_metadata():
    page = page_from_html(ARTICLE, "https://news.example/a")
    assert page.title == "Gulf Horizon wins Jahra Hospital contract"
    assert page.description == "Kuwait contractor wins hospital deal."
    assert page.published == "2026-08-15"
    assert "Gulf Horizon Contracting has been awarded a contract to build the Jahra Hospital extension." in page.text
    for junk in ("Home", "cookies", "Related stories", "Copyright", "track()"):
        assert junk not in page.text
    assert page.ok and "Kuwait contractor" in page.full_text()


@respx.mock
def test_fetch_page_text_html_pdf_and_errors():
    respx.get("https://news.example/a").mock(return_value=httpx.Response(
        200, text=ARTICLE, headers={"content-type": "text/html; charset=utf-8"}))
    respx.get("https://files.example/profile.pdf").mock(return_value=httpx.Response(
        200, content=_pdf("Company profile Gulf Horizon"), headers={"content-type": "application/pdf"}))
    respx.get("https://news.example/missing").mock(return_value=httpx.Response(404, text="nope"))
    respx.get("https://down.example/").mock(side_effect=httpx.ConnectTimeout("timeout"))
    page = fetch_page_text("https://news.example/a", now=datetime(2026, 10, 1, tzinfo=timezone.utc))
    assert page.ok and page.published == "2026-08-15" and page.fetched_at == "2026-10-01T00:00:00Z"
    assert "Company profile Gulf Horizon" in fetch_page_text("https://files.example/profile.pdf").text
    missing = fetch_page_text("https://news.example/missing")
    assert not missing.ok and missing.error == "HTTP 404"
    down = fetch_page_text("https://down.example/")
    assert not down.ok and "ConnectTimeout" in down.error


def test_url_helpers_and_dates():
    a = "https://www.News.example/story/?utm_source=x&b=2&a=1#top"
    b = "http://news.example/story?a=1&b=2"
    assert normalize_url(a) == normalize_url(b) == "https://news.example/story?a=1&b=2"
    assert url_hash(a) == url_hash(b)
    now = datetime(2026, 10, 1, tzinfo=timezone.utc)
    assert parse_published("3 days ago", now) == "2026-09-28"
    assert parse_published("yesterday", now) == "2026-09-30"
    assert parse_published("Sep 1, 2026") == "2026-09-01"
    assert parse_published("not a date at all") is None
