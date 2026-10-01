"""ess.customers.monitor: new public updates about a customer, deduplicated by URL hash."""
from __future__ import annotations

from datetime import datetime, timezone

from ess.customers.monitor import check_updates, classify_update
from ess.customers.search import SearchResult, url_hash

NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)
SINCE = datetime(2026, 8, 1, tzinfo=timezone.utc)
CUSTOMER = {"name": "Gulf Horizon Contracting Co.", "domain": "gulfhorizon.example", "country": "KW"}
OURS = [{"key": "bmu", "label": "Building Maintenance Units", "synonyms": ["BMU", "building maintenance unit"]}]

AWARD = SearchResult("Gulf Horizon awarded Jahra Hospital facade and BMU works",
                     "https://www.news.example/gulf-horizon-jahra?utm_source=feed",
                     "The contract includes a building maintenance unit for the new wing.", published="2026-09-20")
RESULTS = [
    AWARD,
    SearchResult("Gulf Horizon awarded Jahra Hospital works (copy)", "https://news.example/gulf-horizon-jahra/",
                 "Same story, other URL form.", published="2026-09-20"),
    SearchResult("MPW tender 2026/55: Gulf Horizon Contracting among bidders", "https://tenders.example/mpw-2026-55",
                 "Bidders for the Jahra road tender include Gulf Horizon Contracting.", published="2026-09-05"),
    SearchResult("Gulf Horizon Contracting appoints new CEO", "https://press.example/gh-ceo",
                 "Gulf Horizon Contracting Co. appoints a new chief executive.", published="2026-08-12"),
    SearchResult("Gulf Horizon Contracting opens Ahmadi office", "https://press.example/gh-office",
                 "Old story.", published="2026-01-01"),
    SearchResult("Horizon Paints launches a new range", "https://paints.example/new", "Decorative coatings.",
                 published="2026-09-01"),
    SearchResult("Gulf Horizon Contracting sponsors a charity run", "https://press.example/gh-run",
                 "Community news.", published="2026-09-03"),
    SearchResult("Gulf Horizon Contracting at the Big 5 exhibition", "https://press.example/gh-big5",
                 "Exhibition news.", published="2026-09-04"),
    SearchResult("Careers", "https://gulfhorizon.example/careers", "Join our team.", published=None),
]


class Provider:
    name = "fake"

    def __init__(self):
        self.calls = []

    def search(self, query, *, max_results=10, recency_days=None, country=None, news=False):
        self.calls.append((query, recency_days, news))
        return list(RESULTS)


def test_check_updates_dedupes_filters_and_scores():
    provider = Provider()
    seen = {"https://press.example/gh-run", url_hash("https://press.example/gh-big5")}
    updates = check_updates(CUSTOMER, provider, SINCE, seen, our_services=OURS, now=NOW)
    urls = [u["url"] for u in updates]
    assert len(urls) == len(set(u["url_hash"] for u in updates)) == 4
    assert "https://news.example/gulf-horizon-jahra/" not in urls  # same story, other URL form
    assert not any("gh-run" in u or "gh-big5" in u for u in urls)  # seen raw URL / seen hash
    assert not any("gh-office" in u or "paints" in u for u in urls)  # too old / not about this customer
    by_url = {u["url"]: u for u in updates}
    award = by_url[AWARD.url]
    assert award["kind"] == "contract_award" and award["url_hash"] == url_hash(AWARD.url)
    assert award["matched_terms"] and award["relevance"] == max(u["relevance"] for u in updates)
    assert by_url["https://tenders.example/mpw-2026-55"]["kind"] == "tender"
    assert by_url["https://press.example/gh-ceo"]["kind"] == "people"
    assert by_url["https://gulfhorizon.example/careers"]["kind"] == "news"  # official site, no date
    assert updates[0]["url"] == AWARD.url
    assert all(0 < u["relevance"] <= 1 for u in updates)
    assert all(r == 61 for _q, r, _n in provider.calls)  # searches limited to the window since the last check


def test_relevance_rises_with_our_service_terms():
    plain = check_updates(CUSTOMER, Provider(), SINCE, set(), our_terms=["scaffolding"], now=NOW)
    ours = check_updates(CUSTOMER, Provider(), SINCE, set(), our_services=OURS, now=NOW)
    rel = lambda items: next(u["relevance"] for u in items if u["url"] == AWARD.url)  # noqa: E731
    assert rel(ours) > rel(plain)


def test_api_call_shape_and_edge_cases():
    """ess.api.customers.check_customer_updates passes an aware datetime and a set of URLs."""
    updates = check_updates({"name": "Gulf Horizon Contracting Co.", "domain": "gulfhorizon.example",
                             "country": "KW"}, Provider(), SINCE, {AWARD.url})
    assert AWARD.url not in [u["url"] for u in updates]
    assert {"kind", "title", "summary", "url", "source", "relevance", "published_at"} <= set(updates[0])
    assert check_updates(CUSTOMER, None, SINCE, set()) == []
    assert check_updates({"name": ""}, Provider(), SINCE, set()) == []


def test_classify_update():
    assert classify_update("Firm wins contract for new tower") == "contract_award"
    assert classify_update("Invitation to tender for school works") == "tender"
    assert classify_update("Company appoints new managing director") == "people"
    assert classify_update("Groundbreaking for phase 2 of the project") == "project"
    assert classify_update("Company sponsors charity run") == "news"
