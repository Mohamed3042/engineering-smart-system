"""ess.customers.research: customer profiling with achievable evidence standards (offline fake provider)."""
from __future__ import annotations

import re
import sys
import types
from datetime import datetime, timezone

import pytest

from ess.customers.research import EVIDENCE_STANDARDS, SECTIONS, project_key, research_customer
from ess.customers.search import PageText, SearchResult, normalize_url, page_from_html
from ess.knowledge.text import quote_in_text

NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)
CUSTOMER = {"name": "Gulf Horizon Contracting Co.", "domain": "gulfhorizon.example", "country": "KW",
            "city": "Kuwait City", "kind": "main_contractor"}

OFFICIAL = """<html><head><title>Gulf Horizon Contracting Co. | Building Kuwait since 1998</title>
<meta name="description" content="Gulf Horizon Contracting Co. is a general contractor in Kuwait."></head>
<body><nav><a>Home</a> <a>About</a></nav><div class="cookie-banner">We use cookies to improve your experience.</div>
<main><h1>About us</h1>
<p>Gulf Horizon Contracting Co. is a leading general contractor in Kuwait, established in 1998.</p>
<p>We specialise in high-rise towers, hospitals and infrastructure projects for public and private clients.</p>
<p>Our team of 1,200 employees is currently executing the Al Noor Tower project in Kuwait City.</p>
<p>Completed projects include the Salmiya Mall extension and the Fintas Clinic.</p>
<p>Mr. Khalid Al-Mutairi, Chairman, leads the company with a focus on safety and quality.</p>
</main><footer>&copy; 2026 Gulf Horizon. All rights reserved.</footer><script>var x = 1;</script></body></html>"""
NEWS = """<html><head><title>Gulf Horizon wins Jahra Hospital extension contract</title>
<meta property="article:published_time" content="2026-08-15T09:00:00Z"></head><body><article>
<h1>Gulf Horizon wins Jahra Hospital extension contract</h1>
<p>Kuwait-based Gulf Horizon Contracting has been awarded a KWD 45 million contract to build the Jahra Hospital extension.</p>
<p>Work is expected to start in the fourth quarter.</p></article></body></html>"""
OLD_NEWS = """<html><head><title>Gulf Horizon Contracting opens a new office in Ahmadi</title>
<meta property="article:published_time" content="2024-01-10T09:00:00Z"></head><body>
<p>Gulf Horizon Contracting opened a new site office in Ahmadi for its road works.</p></body></html>"""
DIRECTORY = """<html><head><title>Gulf Horizon Contracting Co. - Company profile - BizDirectory</title></head><body>
<p>Gulf Horizon Contracting Co. is a construction company based in Kuwait City with 1,000-5,000 employees.</p>
</body></html>"""
OTHER = """<html><head><title>Horizon Paints - Products</title></head><body>
<p>Horizon Paints offers decorative coatings for villas and offices across the region.</p></body></html>"""

PAGES = {
    "https://www.gulfhorizon.example/": OFFICIAL,
    "https://news.example.com/gulf-horizon-jahra": NEWS,
    "https://news.example.com/gulf-horizon-ahmadi": OLD_NEWS,
    "https://bizdirectory.example.org/gulf-horizon": DIRECTORY,
    "https://horizonpaints.example/": OTHER,
}
RESULTS = [
    SearchResult("Gulf Horizon Contracting Co.", "https://www.gulfhorizon.example/", "Leading general contractor."),
    SearchResult("Gulf Horizon Contracting Co. - Company profile", "https://bizdirectory.example.org/gulf-horizon",
                 "Construction company in Kuwait City."),
    SearchResult("Horizon Paints", "https://horizonpaints.example/", "Decorative coatings."),
    SearchResult("MPW projects update", "https://blocked.example.com/mpw-update",
                 "Gulf Horizon Contracting Co. is executing the Al Noor Tower project for the Ministry of Public Works."),
]
NEWS_RESULTS = [
    SearchResult("Gulf Horizon wins Jahra Hospital extension contract", "https://news.example.com/gulf-horizon-jahra",
                 "Gulf Horizon Contracting has been awarded a KWD 45 million contract.", published="2026-08-15"),
    SearchResult("Gulf Horizon Contracting opens a new office in Ahmadi", "https://news.example.com/gulf-horizon-ahmadi",
                 "New site office.", published="2024-01-10"),
]


class FakeProvider:
    name = "fake"

    def __init__(self, results=RESULTS, news=NEWS_RESULTS, pages=PAGES):
        self.results, self.news_results, self.pages = results, news, pages
        self.queries: list[tuple[str, dict]] = []

    def search(self, query, *, max_results=10, recency_days=None, country=None, news=False):
        self.queries.append((query, {"recency_days": recency_days, "news": news}))
        if news or "news" in query:
            return list(self.news_results)[:max_results]
        return list(self.results)[:max_results]

    def fetch_page(self, url):
        for key, html in self.pages.items():
            if normalize_url(key) == normalize_url(url):
                return page_from_html(html, url, now=NOW)
        return PageText(url=url, error="HTTP 403")


def page_text(url: str) -> str:
    for key, html in PAGES.items():
        if normalize_url(key) == normalize_url(url):
            return page_from_html(html, url).full_text()
    return ""


def claims(report, section):
    return report["sections"][section]["claims"]


def test_evidence_standards_are_documented():
    assert list(EVIDENCE_STANDARDS) == ["basic", "standard", "deep"]
    assert EVIDENCE_STANDARDS["basic"]["identity_sources"] == 1
    assert EVIDENCE_STANDARDS["standard"]["single_official_source_ok"] is True
    assert EVIDENCE_STANDARDS["deep"]["current_project_sources"] == 2
    assert EVIDENCE_STANDARDS["deep"]["news_window_days"] == 365
    with pytest.raises(ValueError):
        research_customer(CUSTOMER, FakeProvider(), standard="forensic")


def test_standard_met_with_one_official_source_and_verified_quotes():
    report = research_customer(CUSTOMER, FakeProvider(), standard="standard", now=NOW)
    assert report["met_standard"] is True
    assert report["identity"]["confirmed"] and report["identity"]["sources"][0]["kind"] == "official"
    assert set(report["sections"]) == set(SECTIONS)
    assert report["sections"]["overview"]["status"] == "found"
    assert report["sections"]["business_lines"]["status"] == "found"
    business = claims(report, "business_lines")[0]
    assert business["sources"][0]["kind"] == "official" and business["meets_standard"]  # one official source is enough
    # every published quote is verbatim in the page (or snippet) it cites
    for sec in report["sections"].values():
        for claim in sec["claims"]:
            assert claim["sources"], claim
            for src in claim["sources"]:
                if src["verification"] == "page":
                    assert src["quote"] in page_text(src["url"]) or quote_in_text(src["quote"], page_text(src["url"]))
                assert src["retrieved_at"] == "2026-10-01T00:00:00Z"
    texts = [c["text"] for sec in report["sections"].values() for c in sec["claims"]]
    assert not any("Horizon Paints" in t for t in texts)  # a similarly named company is ignored
    assert not any("cookies" in t or "All rights reserved" in t for t in texts)
    assert any(c.get("fact") == "size" for c in claims(report, "overview"))
    assert report["sections"]["projects_past"]["status"] == "found"
    assert any("Khalid Al-Mutairi" in c["text"] for c in claims(report, "people"))
    news = claims(report, "news")
    assert [c["text"] for c in news] == ["Gulf Horizon wins Jahra Hospital extension contract"]  # 2024 item excluded
    assert report["evidence_count"] >= 6 and report["summary"]
    assert report["ran_at"] == "2026-10-01T00:00:00Z"


def test_snippet_sources_and_project_corroboration():
    report = research_customer(CUSTOMER, FakeProvider(), standard="standard", now=NOW)
    current = claims(report, "projects_current")
    al_noor = next(c for c in current if "Al Noor Tower" in c["text"])
    kinds = {s["verification"] for s in al_noor["sources"]}
    assert kinds == {"page", "snippet"} and al_noor["independent_sources"] == 2  # blocked page -> snippet quote
    jahra = next(c for c in current if "Jahra Hospital" in c["text"])
    assert jahra["meets_standard"] is False and jahra["needs"]  # single non-official source -> partial, not hidden
    assert any(g["kind"] == "below_standard" and "Jahra" in g["claim"] for g in report["gaps"])
    assert any(g["kind"] == "source_error" and "blocked.example.com" in g["message"] for g in report["gaps"])


def test_deep_standard_news_window_and_two_sources_for_projects():
    provider = FakeProvider()
    report = research_customer(CUSTOMER, provider, standard="deep", now=NOW)
    assert report["news_searched"] and report["met_standard"]
    assert any(opts["recency_days"] == 365 for _q, opts in provider.queries)
    current = {c["text"]: c for c in claims(report, "projects_current")}
    al_noor = next(c for t, c in current.items() if "Al Noor" in t)
    assert al_noor["meets_standard"]  # official site + independent snippet
    assert report["sections"]["projects_current"]["status"] == "found"
    assert not next(c for t, c in current.items() if "Jahra" in t)["meets_standard"]


def test_deep_reports_missing_news_search_as_gap():
    class NoNews(FakeProvider):
        def search(self, query, **kw):
            if kw.get("news"):
                raise RuntimeError("news API down")
            return super().search(query, **kw)

    report = research_customer(CUSTOMER, NoNews(), standard="deep", now=NOW)
    assert report["met_standard"] is False
    assert report["gaps"][0]["kind"] == "news_not_searched"


def test_basic_with_own_emails_only():
    own = [{"text": "RFQ - BMU for Al Noor Tower\nDear Sir,\nKindly quote one BMU for the Al Noor Tower.\n\n"
                    "Best regards,\nFaisal Al-Rashid\nEstimation Engineer\nGulf Horizon Contracting Co. W.L.L.\n"
                    "Tel: +965 2222 1111", "source": "email e1", "date": "2026-08-10T09:00:00+00:00"},
           {"text": "Reminder - RFQ BMU\nAny update on our enquiry?\nRegards, Faisal", "source": "email e2",
            "date": "2026-08-20T09:00:00+00:00"}]
    report = research_customer(CUSTOMER, None, standard="basic", own_evidence=own, now=NOW)
    assert report["met_standard"] is True
    assert report["identity"]["sources"][0]["kind"] == "own_email"
    assert report["sections"]["relationship_with_us"]["status"] == "found"
    rel = claims(report, "relationship_with_us")[0]
    assert rel["text"].startswith("2 e-mail(s) with us between 2026-08-10 and 2026-08-20")
    people = claims(report, "people")
    assert people[0]["text"] == "Faisal Al-Rashid - Estimation Engineer"
    assert people[0]["sources"][0]["quote"] == "Faisal Al-Rashid\nEstimation Engineer"
    assert report["sections"]["projects_current"]["status"] == "found"  # what they asked us to price
    assert report["sections"]["news"]["status"] == "not_found"
    assert any(g["kind"] == "no_search_provider" for g in report["gaps"])


def test_unconfirmed_identity_is_the_only_failure():
    empty = FakeProvider(results=[], news=[], pages={})
    report = research_customer({"name": "Nobody Trading", "domain": "nobody.example"}, empty, now=NOW)
    assert report["met_standard"] is False
    assert report["gaps"][0]["kind"] == "identity_unconfirmed"
    assert all(sec["status"] == "not_found" for sec in report["sections"].values())


def test_api_call_shape():
    """Exactly how ess.api.customers.run_research calls it."""
    own = [{"text": "RFQ for Al Noor Tower BMU. Regards, Gulf Horizon Contracting Co.", "source": "email e9",
            "date": "2026-09-01T10:00:00"}]
    report = research_customer({"name": "Gulf Horizon Contracting Co.", "domain": "gulfhorizon.example",
                                "country": "KW", "city": "", "kind": "main_contractor"}, FakeProvider(),
                               engine=None, standard="standard", own_evidence=own)
    assert isinstance(report["sections"], dict) and isinstance(report["gaps"], list)
    assert isinstance(report["met_standard"], bool) and isinstance(report["evidence_count"], int)
    assert isinstance(report["summary"], str) and report["summary"]


def test_opportunities_section_from_match_services():
    opps = [{"service_key": "wce", "label": "Window Cleaning Equipment", "score": 0.6,
             "reason": "Buildings with a BMU need davits.",
             "evidence": [{"kind": "adjacency", "basis": {"quote": "RFQ - BMU for Al Noor Tower", "source": "email"}}]}]
    report = research_customer(CUSTOMER, None, standard="basic", own_evidence=["Gulf Horizon Contracting Co. RFQ"],
                               opportunities=opps, now=NOW)
    opp = claims(report, "opportunities")[0]
    assert opp["derived"] and opp["text"].startswith("Window Cleaning Equipment")
    assert opp["sources"][0]["quote"] == "RFQ - BMU for Al Noor Tower"


def test_ai_claims_are_verified_quote_by_quote(monkeypatch):
    def fake_research(engine, customer, search_results):
        assert any(r["url"].startswith("https://gulfhorizon.example") for r in search_results)
        return {"sections": [{"key": "profile", "title": "Profile", "claims": [
            {"text": "A Kuwaiti general contractor founded in 1998.", "url": "https://www.gulfhorizon.example/",
             "quote": "Gulf Horizon Contracting Co. is a leading general contractor in Kuwait, established in 1998.",
             "verified": True},
            {"text": "Gulf Horizon builds nuclear plants.", "url": "https://www.gulfhorizon.example/",
             "quote": "We build nuclear power plants worldwide.", "verified": False}]}],
            "gaps": ["Revenue is not published."]}

    fake = types.ModuleType("ess.ai.tasks")
    fake.research_customer = fake_research
    monkeypatch.setitem(sys.modules, "ess.ai.tasks", fake)
    report = research_customer(CUSTOMER, FakeProvider(), engine=object(), standard="standard", now=NOW)
    assert report["engine_used"]
    texts = [c["text"] for c in claims(report, "overview")]
    assert "A Kuwaiti general contractor founded in 1998." in texts
    assert not any("nuclear" in t for sec in report["sections"].values() for t in [c["text"] for c in sec["claims"]])
    kinds = {g["kind"] for g in report["gaps"]}
    assert {"unverified_claim_dropped", "ai_gap"} <= kinds
    assert report["sections"]["projects_current"]["status"] == "found"  # sections the AI left empty: rules fill them


def test_real_research_task_with_fake_engine():
    tasks = pytest.importorskip("ess.ai.tasks")
    if not hasattr(tasks, "research_customer"):
        pytest.skip("ess.ai.tasks.research_customer not available")

    class Engine:
        def complete_json(self, system, user, schema, **kwargs):
            key = re.search(r"- (r-\d+): https://gulfhorizon\.example", user).group(1)
            return {"sections": [{"key": "services", "title": "Services", "claims": [
                {"text": "Builds towers, hospitals and infrastructure.", "confidence": 0.8,
                 "evidence": {"quote": "We specialise in high-rise towers, hospitals and infrastructure projects",
                              "source": key}}]}], "gaps": []}

    report = research_customer(CUSTOMER, FakeProvider(), engine=Engine(), standard="standard", now=NOW)
    assert report["engine_used"], report["errors"]
    lines = claims(report, "business_lines")
    assert lines[0]["text"] == "Builds towers, hospitals and infrastructure." and lines[0]["origin"] == "ai"
    assert lines[0]["sources"][0]["kind"] == "official"


def test_project_key():
    assert project_key("Our team is currently executing the Al Noor Tower project in Kuwait City.") == "al noor tower"
    assert project_key("RFQ - BMU for Al Noor Tower (Tender No. 14)") == "al noor tower"
    assert project_key("awarded a contract to build the Jahra Hospital extension") == "jahra hospital"
    assert project_key("no project named here") is None
