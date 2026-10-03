"""Hosted API contracts, key isolation and restartable research; no live credentials."""
import json
from types import SimpleNamespace as NS

import httpx
import pytest
from fastapi.testclient import TestClient

from ess.ai.engine import AIEngine
from ess.ai.hosted import HOSTED
from ess.ai.providers import list_remote_model_details
from ess.ai.testing import exam_record
from ess.customers.checkpoint import ResearchCheckpoint
from ess.customers.search import PageText, SearchResult, SearchUnavailable, get_search_provider


@pytest.mark.parametrize("provider", HOSTED)
def test_named_ai_uses_official_endpoint_and_bearer_key(provider):
    def handle(req):
        assert str(req.url) == HOSTED[provider]["base_url"] + "/models"
        assert req.headers["authorization"] == "Bearer test-provider-key"
        return httpx.Response(200, json={"data": [{"id": "openai/gpt-oss-120b", "context_window": 131072}]})
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        rows = list_remote_model_details(provider, "test-provider-key", client=client)
        assert rows[0]["context_tokens"] == 131072
        with pytest.raises(ValueError, match="separate"):
            list_remote_model_details(provider, "test-provider-key", "https://wrong.example/v1", client=client)


@pytest.mark.parametrize("provider", HOSTED)
def test_named_ai_chat_request_and_qualification(provider):
    model = "openai/gpt-oss-120b"
    eng = AIEngine(provider, model, api_key="test-key", exam=exam_record(provider, model))
    sent = []
    def create(**kwargs):
        sent.append(kwargs)
        return NS(choices=[NS(message=NS(content='{"answer":"ok"}', refusal=None), finish_reason="stop")],
                  model=model, usage=NS(prompt_tokens=10, completion_tokens=5))
    eng._adapter_for()._client = NS(chat=NS(completions=NS(create=create)))
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}
    assert eng.complete_json("Return JSON", "test", schema, task="classify_email") == {"answer": "ok"}
    assert eng.base_url == HOSTED[provider]["base_url"]
    assert HOSTED[provider]["max_tokens_param"] in sent[0]
    assert eng.max_retries == 0
    # A key does not make a model qualified.
    unqualified = AIEngine(provider, model, api_key="test-key", exam=None)
    assert unqualified.eligibility().status == "needs_evaluation"


def test_exa_request_and_source_dates():
    def handle(req):
        assert str(req.url) == "https://api.exa.ai/search"
        assert req.headers["x-api-key"] == "exa-test"
        body = json.loads(req.content)
        assert body["type"] == "fast" and body["category"] == "news"
        assert body["numResults"] == 3 and "startPublishedDate" in body
        return httpx.Response(200, json={"results": [{"url": "https://example.com/news", "title": "News",
               "highlights": ["A quoted source"], "publishedDate": "2026-10-01T00:00:00Z"}]})
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        p = get_search_provider({"provider": "exa", "api_key": "exa-test", "client": client})
        hit = p.search("public company", news=True, recency_days=30, max_results=3)[0]
        assert (hit.snippet, hit.published, hit.source) == ("A quoted source", "2026-10-01", "exa")


def test_firecrawl_v2_search_and_page():
    def handle(req):
        assert req.headers["authorization"] == "Bearer firecrawl-test"
        body = json.loads(req.content)
        if req.url.path == "/v2/search":
            assert body["sources"] == ["news"] and body["limit"] == 2
            assert "scrapeOptions" not in body
            return httpx.Response(200, json={"success": True, "data": {"news": [
                {"url": "https://example.com/news", "title": "News", "snippet": "A source", "date": "2026-10-01"}]}})
        assert req.url.path == "/v2/scrape"
        assert body == {"url": "https://example.com", "formats": ["markdown"], "onlyMainContent": True}
        return httpx.Response(200, json={"success": True, "data": {"markdown": "Public page text",
                              "metadata": {"title": "Example", "statusCode": 200, "sourceURL": "https://example.com/"}}})
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        p = get_search_provider({"provider": "firecrawl", "api_key": "firecrawl-test", "client": client})
        assert p.search("public company", news=True, max_results=2)[0].source == "firecrawl"
        assert p.fetch_page("https://example.com").full_text() == "Example\nPublic page text"
        for url in ("file:///company.pdf", "http://localhost", "http://127.0.0.1", "https://user:secret@example.com"):
            with pytest.raises(Exception):
                p.fetch_page(url)


@pytest.mark.parametrize("status", [401, 402, 403, 429])
@pytest.mark.parametrize("provider", ["tavily", "exa", "firecrawl"])
def test_quota_and_auth_are_resumable_and_do_not_echo_secrets(provider, status):
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, text="secret-body"))) as client:
        p = get_search_provider({"provider": provider, "api_key": "secret-key", "client": client})
        with pytest.raises(SearchUnavailable) as err:
            p.search("public test")
        assert "secret" not in str(err.value)


def test_checkpoint_survives_provider_change_and_does_not_repeat_success(tmp_path):
    calls = []
    class Limited:
        name = "tavily"
        def search(self, q, **kwargs):
            calls.append(q)
            if q != "first":
                raise SearchUnavailable("quota reached")
            return [SearchResult("First", "https://example.com", source=self.name)]
        def fetch_page(self, url):
            return PageText(url=url, text="saved evidence")
    path = tmp_path / "checkpoint.json"
    original = ResearchCheckpoint(path, {"customer": "Example"}, Limited())
    original.search("first", max_results=2)
    original.fetch_page("https://example.com")
    for query in ("second", "third"):
        with pytest.raises(SearchUnavailable):
            original.search(query)
    assert calls == ["first", "second"]
    assert path.stat().st_mode & 0o777 == 0o600
    class Replacement:
        name = "exa"
        def search(self, q, **kwargs):
            assert q == "second"
            return [SearchResult("Second", "https://example.com/2", source=self.name)]
        def fetch_page(self, url):
            raise AssertionError("A successfully read page should not be charged twice")
    resumed = ResearchCheckpoint(path, {"customer": "Example"}, Replacement())
    assert resumed.search("first", max_results=2)[0].source == "tavily"
    assert resumed.fetch_page("https://example.com").text == "saved evidence"
    assert resumed.search("second")[0].source == "exa"
    assert resumed.paused_reason is None
    changed = ResearchCheckpoint(path, {"customer": "Different"}, Replacement())
    assert changed.data["searches"] == {}


@pytest.fixture
def client(tmp_path, monkeypatch):
    from ess import config, db
    from ess.main import create_app
    monkeypatch.setenv("ESS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ESS_SCHEDULER", "0")
    config.get_settings.cache_clear()
    db.reset_engine()
    with TestClient(create_app()) as c:
        c.post("/api/workspaces", json={"name": "Example", "primary_email": "sales@example.com"})
        yield c
    db.reset_engine()
    config.get_settings.cache_clear()


def test_connections_are_isolated_and_spare_does_not_disable_active(client):
    a = client.post("/api/connections", json={"kind": "ai", "method": "api", "provider": "groq",
                                             "secrets": {"api_key": "first-private-key"}}).json()
    b = client.post("/api/connections", json={"kind": "ai", "method": "api", "provider": "mistral", "is_active": False,
                                             "secrets": {"api_key": "second-private-key"}}).json()
    assert a["is_active"] and not b["is_active"]
    client.patch(f"/api/connections/{b['id']}", json={"is_active": True})
    rows = client.get("/api/connections").json()
    assert [r["provider"] for r in rows if r["is_active"]] == ["mistral"]
    assert "first-private-key" not in json.dumps(rows) and "second-private-key" not in json.dumps(rows)
    from ess.secrets import get_secret
    assert get_secret(f"{a['id']}:api_key") == "first-private-key"
    reader = client.post("/api/connections", json={"kind": "reader", "method": "api", "provider": "firecrawl"})
    assert reader.status_code == 200


def test_remote_model_capabilities_survive_refresh_and_re_evaluation(client, monkeypatch):
    from ess.ai import providers
    from ess.api.ai import upsert_model_state
    from ess.db import session_scope
    from ess.workspace import get_active_workspace
    monkeypatch.setattr(providers, "list_remote_model_details", lambda *a: [
        {"id": "openai/gpt-oss-120b", "context_tokens": 131072, "structured_output": True, "vision": False}])
    conn = client.post("/api/connections", json={"kind": "ai", "method": "api", "provider": "groq"}).json()
    assert client.post(f"/api/connections/{conn['id']}/test").json()["ok"]
    with session_scope() as s:
        state = upsert_model_state(s, get_active_workspace(s), "groq", "openai/gpt-oss-120b")
        assert state.capabilities["context_tokens"] == 131072 and state.capabilities["vision"] is False
        assert state.status == "needs_evaluation" and not state.exam


def test_mistral_company_processing_waits_for_training_setting(client):
    from ess.db import session_scope
    from ess.pipeline.connect import NotConnected, engine_for
    from ess.workspace import get_active_workspace
    client.post("/api/connections", json={"kind": "ai", "method": "api", "provider": "mistral",
                                         "config": {"model": "mistral-large-2411"}})
    with session_scope() as s:
        with pytest.raises(NotConnected, match="training"):
            engine_for(s, get_active_workspace(s), "classify_email", required=True)
    assert client.get("/api/ai/status").json()["rules_only"]


def test_research_api_pauses_and_resumes_same_report_after_restart(client, monkeypatch):
    from ess import jobs
    from ess.api import customers
    from ess.db import session_scope
    from ess.models import Customer, ResearchReport
    from ess.workspace import get_active_workspace
    from ess.pipeline import connect
    calls = []
    class Search:
        name = "test"
        available = False
        def search(self, query, **kwargs):
            calls.append(query)
            if len(calls) > 1 and not self.available:
                raise SearchUnavailable("Quota exhausted")
            return []
    p = Search()
    monkeypatch.setattr(customers, "_search_provider", lambda *a: p)
    monkeypatch.setattr(customers, "_page_reader", lambda *a: None)
    monkeypatch.setattr(connect, "engine_for", lambda *a: None)
    with session_scope() as s:
        c = Customer(workspace_id=get_active_workspace(s).id, name="Example Public Company", ref="C-TEST")
        s.add(c)
        s.flush()
        cid = c.id
    response = client.post(f"/api/customers/{cid}/research", json={"standard": "standard"})
    assert response.status_code == 200, response.text
    rid = response.json()["id"]
    jobs.wait(f"research:{cid}", timeout=10)
    report = client.get(f"/api/customers/{cid}/research").json()[0]
    assert report["status"] == "paused" and not report["met_standard"]
    first = calls[0]
    # Simulate a process that stopped with a running row; startup offers explicit resume.
    with session_scope() as s:
        saved = s.get(ResearchReport, rid)
        saved.status = "running"
        s.add(saved)
    customers.recover_interrupted_research()
    p.available = True
    assert client.post(f"/api/customers/{cid}/research/{rid}/resume").status_code == 200
    jobs.wait(f"research:{cid}", timeout=10)
    report = client.get(f"/api/customers/{cid}/research").json()[0]
    assert report["id"] == rid and report["status"] == "done"
    assert calls.count(first) == 1
