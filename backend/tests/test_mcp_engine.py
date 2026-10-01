"""Engine via MCP: an external AI client must declare its model, pass the same exam, and obey the guards."""
import copy
import importlib
import json
import tempfile

import pytest
from fastapi.testclient import TestClient

HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-mcp-"))
    monkeypatch.setenv("ESS_SCHEDULER", "0")
    from ess import config, db

    config.get_settings.cache_clear()
    db.reset_engine()
    import ess.main as main

    importlib.reload(main)
    with TestClient(main.app) as c:
        from ess.demo import DEMO_SNAPSHOT, DEMO_WORKSPACE

        c.post("/api/workspaces", json=DEMO_WORKSPACE)
        from ess.db import session_scope
        from ess.pipeline.importer import import_snapshot
        from ess.workspace import get_active_workspace

        with session_scope() as s:
            import_snapshot(s, get_active_workspace(s), copy.deepcopy(DEMO_SNAPSHOT))
        yield c
    db.reset_engine()
    config.get_settings.cache_clear()


def call(client, name, args):
    r = client.post("/mcp/", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                    "params": {"name": name, "arguments": args}})
    result = r.json()["result"]
    text = result["content"][0]["text"] if result.get("content") else ""
    if result.get("isError"):
        return {"error": text}
    return result.get("structuredContent", {}).get("result", None) or json.loads(text)


def test_refused_model_cannot_work(client):
    decl = call(client, "declare_engine", {"provider": "openai", "model_id": "gpt-4o-mini", "client_name": "test"})
    assert decl["tasks"]["extract_request"]["status"] == "refused"
    out = call(client, "submit_qualification_answers", {"answers": {}})
    assert "error" in out and "refused" in out["error"]


def test_exam_unlocks_work_for_a_good_model(client):
    from ess.ai.exam_cases import EXAM_CASES

    decl = call(client, "declare_engine", {"provider": "anthropic", "model_id": "claude-opus-5-5", "client_name": "test"})
    assert decl["tasks"]["extract_request"]["status"] == "needs_evaluation"
    blocked = call(client, "submit_classification", {"email_id": "demo-m1", "category": "bmu", "confidence": 0.9,
                                                     "reason": "BMU RFQ", "evidence": [{"quote": "Building Maintenance Unit (BMU)"}]})
    assert "error" in blocked

    exam = call(client, "get_qualification_exam", {})
    ids = {c["case_id"] for c in exam}
    answers = {c.id: copy.deepcopy(c.golden) for c in EXAM_CASES if c.id in ids}
    scored = call(client, "submit_qualification_answers", {"answers": answers})
    assert scored["passed"] is True, scored
    assert scored["tasks"]["extract_request"]["status"] == "eligible"

    ok = call(client, "submit_classification", {"email_id": "demo-m1", "category": "bmu", "confidence": 0.9,
                                                "reason": "BMU RFQ", "evidence": [{"quote": "Building Maintenance Unit (BMU)"}]})
    assert ok.get("ok") is True
    fake = call(client, "submit_classification", {"email_id": "demo-m1", "category": "bmu", "confidence": 0.9,
                                                  "reason": "x", "evidence": [{"quote": "a sentence that is not in the mail"}]})
    assert "error" in fake and "verbatim" in fake["error"]


def test_sloppy_exam_fails(client):
    from ess.ai.exam_cases import EXAM_CASES

    call(client, "declare_engine", {"provider": "anthropic", "model_id": "claude-sonnet-5-5", "client_name": "test"})
    exam = call(client, "get_qualification_exam", {})
    ids = [c["case_id"] for c in exam]
    answers = {}
    for case in EXAM_CASES:
        if case.id in ids:
            golden = copy.deepcopy(case.golden)
            if isinstance(golden.get("items"), list):  # a model that prices items fails critically
                for item in golden["items"]:
                    item["unit_price"] = 1234
            answers[case.id] = golden
    answers.pop(ids[0], None)  # and skips a case
    scored = call(client, "submit_qualification_answers", {"answers": answers})
    assert scored["passed"] is False
    assert scored["tasks"]["draft_quotation"]["status"] != "eligible"
