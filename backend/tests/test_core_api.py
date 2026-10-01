"""End-to-end API tests for the core: workspace, import, inbox visibility, projects, review and send gates."""
import copy
import importlib
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-core-"))
    monkeypatch.setenv("ESS_SCHEDULER", "0")
    from ess import config, db

    config.get_settings.cache_clear()
    db.reset_engine()
    import ess.main as main

    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c
    db.reset_engine()
    config.get_settings.cache_clear()


def _demo(client):
    from ess.demo import DEMO_SNAPSHOT, DEMO_WORKSPACE

    r = client.post("/api/workspaces", json={**DEMO_WORKSPACE, "owner_name": "Jordan Ellis"})
    assert r.status_code == 200
    from ess.db import session_scope
    from ess.pipeline.importer import import_snapshot
    from ess.workspace import get_active_workspace

    with session_scope() as s:
        result = import_snapshot(s, get_active_workspace(s), copy.deepcopy(DEMO_SNAPSHOT))
    return result


def test_workspace_defaults(client):
    assert client.get("/api/session").json()["workspace"] is None
    r = client.post("/api/workspaces", json={"name": "Acme", "primary_email": "sales@acme.example", "country": "KW"})
    ws = r.json()
    assert ws["currency"] == "KWD" and ws["own_domains"] == ["acme.example"]
    cats = client.get("/api/categories").json()
    assert {"bmu", "wce", "promotions", "bills"} <= {c["key"] for c in cats}
    assert any(not c["visible"] for c in cats if c["key"] == "promotions")
    autos = client.get("/api/automations").json()
    intake = next(a for a in autos if a["key"] == "enquiry_intake")
    assert intake["steps"][-1]["requires_approval"] is True


def test_import_verifies_evidence_and_strips_prices(client):
    from ess.demo import DEMO_SNAPSHOT, DEMO_WORKSPACE

    client.post("/api/workspaces", json=DEMO_WORKSPACE)
    snap = copy.deepcopy(DEMO_SNAPSHOT)
    marina = snap["projects"][0]
    marina["scope_items"][0]["unit_price"] = 99999
    marina["requirements"].append({"field": "invented", "label": "Invented", "value": "x",
                                   "evidence": {"quote": "this sentence is not in any email", "source_type": "email",
                                                "source_id": "demo-m1"}})
    from ess.db import session_scope
    from ess.pipeline.importer import import_snapshot
    from ess.workspace import get_active_workspace

    with session_scope() as s:
        result = import_snapshot(s, get_active_workspace(s), snap)
    assert result["counts"]["projects"] == 4
    assert result["evidence"]["checked"] - result["evidence"]["verified"] == 1
    projects = client.get("/api/projects").json()["items"]
    pid = next(p["id"] for p in projects if p["name"] == "Marina Tower A")
    detail = client.get(f"/api/projects/{pid}").json()
    proj = detail["project"]
    assert proj["scope_items"][0]["unit_price"] is None
    flags = {r["field"]: r["evidence"]["verified"] for r in proj["requirements"]}
    assert flags["building_height"] is True and flags["invented"] is False
    assert len(detail["enquiries"]) == 1 and detail["enquiries"][0]["due_date"] == "2026-11-12"


def test_inbox_visibility_and_correction(client):
    _demo(client)
    default = client.get("/api/emails").json()
    assert all(e["category"] != "promotions" for e in default["items"])
    promos = client.get("/api/emails", params={"group": "promotions"}).json()
    assert promos["total"] == 1
    email_id = promos["items"][0]["id"]
    r = client.patch(f"/api/emails/{email_id}", json={"category": "other"})
    assert r.json()["category_source"] == "user"
    summary = client.get("/api/inbox/summary").json()
    assert summary["groups"]["work"]["total"] >= 6
    r = client.post("/api/emails/demo-b1/unsubscribe", json={})
    assert r.json()["needs_confirmation"] is True


def test_dashboard_changes_and_review_gate(client):
    _demo(client)
    dash = client.get("/api/dashboard").json()
    names = {r["name"]: r for r in dash["buckets"]["needs_attention"]}
    assert "Marina Tower A" in names
    marina = names["Marina Tower A"]
    assert marina["next_action"]["kind"] == "review_change"
    pid = marina["id"]
    client.post(f"/api/projects/{pid}/changes/0/acknowledge", json={"note": "noted"})
    detail = client.get(f"/api/projects/{pid}").json()
    assert detail["project"]["next_action"]["kind"] != "review_change"
    review = client.get(f"/api/projects/{pid}/review").json()
    assert review["checklist"]
    r = client.post(f"/api/projects/{pid}/review/approve", json={})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "checklist_open"
    checked = [{**i, "status": "checked"} for i in review["checklist"]]
    client.put(f"/api/projects/{pid}/review", json={"checklist": checked, "note": "Loads confirmed"})
    r = client.post(f"/api/projects/{pid}/review/approve", json={})
    assert r.status_code == 200 and r.json()["decision"] == "approved"


def test_quotation_price_and_send_gates(client):
    pytest.importorskip("ess.quotation.templates")
    _demo(client)
    projects = client.get("/api/projects").json()["items"]
    pid = next(p["id"] for p in projects if p["name"] == "Harbor Offices")
    q = client.post("/api/quotations", json={"project_id": pid}).json()
    assert q["status"] == "draft" and q["template_key"] == "annual_maintenance"
    assert all(i["unit_price"] is None for i in q["data"]["items"])
    r = client.post(f"/api/quotations/{q['id']}/approve", json={})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "review_required"
    review = client.get(f"/api/projects/{pid}/review").json()
    client.put(f"/api/projects/{pid}/review", json={"checklist": [{**i, "status": "checked"} for i in review["checklist"]]})
    assert client.post(f"/api/projects/{pid}/review/approve", json={}).status_code == 200
    r = client.post(f"/api/quotations/{q['id']}/approve", json={})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "prices_missing"
    items = [{**i, "unit_price": 100} for i in q["data"]["items"]]
    edited = client.put(f"/api/quotations/{q['id']}", json={"data": {"items": items}}).json()
    assert edited["missing_prices"] == []
    r = client.post(f"/api/quotations/{q['id']}/send", json={"to": ["x@example.com"]})
    assert r.status_code == 400  # confirmation required
    r = client.post(f"/api/quotations/{q['id']}/send", json={"to": ["x@example.com"], "confirm": True})
    assert r.status_code == 409  # not approved yet


def test_requested_terms_wait_for_a_person_and_block_approval(client):
    pytest.importorskip("ess.quotation.templates")
    _demo(client)
    from ess.db import session_scope
    from ess.models import Email, Project

    projects = {p["name"]: p for p in client.get("/api/projects").json()["items"]}
    pid = projects["Harbor Offices"]["id"]
    with session_scope() as s:  # the customer asks for a longer offer validity in the same thread
        p = s.get(Project, pid)
        s.add(Email(id="terms-1", workspace_id=p.workspace_id, thread_id="demo-t4", project_id=pid,
                    subject="RE: BMU maintenance quote", body_text="Kindly note the validity of the offer: 120 days."))
    q = client.post("/api/quotations", json={"project_id": pid}).json()
    assert {t["key"]: t["text"] for t in q["data"]["terms"]}["validity"] == "One month."  # detected, not agreed
    change = next(c for c in q["data"]["term_changes"] if c["key"] == "validity")
    assert change["status"] == "pending" and change["to"] == "120 days." and change["enquiry_id"]
    review = client.get(f"/api/projects/{pid}/review").json()
    client.put(f"/api/projects/{pid}/review", json={"checklist": [{**i, "status": "checked"} for i in review["checklist"]]})
    client.post(f"/api/projects/{pid}/review/approve", json={})
    client.put(f"/api/quotations/{q['id']}", json={"data": {"items": [{**i, "unit_price": 10} for i in q["data"]["items"]]}})
    assert [b["code"] for b in client.get(f"/api/quotations/{q['id']}").json()["approval_blockers"]] == ["terms_pending"]
    r = client.post(f"/api/quotations/{q['id']}/approve", json={})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "terms_pending"
    url = f"/api/quotations/{q['id']}/term-changes/validity/decide"
    assert client.post(url, json={"decision": "retain"}).json()["detail"]["code"] == "reason_required"
    assert client.post(f"/api/quotations/{q['id']}/submit").json()["status"] == "needs_review"
    decided = client.post(url, json={"decision": "accept"}).json()
    assert {t["key"]: t["text"] for t in decided["data"]["terms"]}["validity"] == "120 days."
    assert decided["status"] == "draft"  # the term changed while waiting for approval: ask again
    rec = next(c for c in decided["data"]["term_changes"] if c["key"] == "validity")
    assert rec["status"] == "accepted" and rec["decided_by"] and rec["revision"].endswith("v1")
    assert client.get(f"/api/quotations/{q['id']}").json()["approval_blockers"] == []
    assert client.post(f"/api/quotations/{q['id']}/approve", json={}).status_code == 200
    r = client.post(url, json={"decision": "retain", "reason": "late change"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "frozen"  # revise: fresh approval + send


def test_unknown_quantity_stays_unknown_and_blocks_approval(client):
    pytest.importorskip("ess.quotation.templates")
    _demo(client)
    pid = next(p["id"] for p in client.get("/api/projects").json()["items"] if p["name"] == "Crescent School")
    q = client.post("/api/quotations", json={"project_id": pid}).json()
    assert [i["qty"] for i in q["data"]["items"]] == [None]  # the tender states no quantity: not 0, not 1
    client.put(f"/api/quotations/{q['id']}", json={"data": {"items": [{**i, "unit_price": 900} for i in q["data"]["items"]]}})
    codes = [b["code"] for b in client.get(f"/api/quotations/{q['id']}").json()["approval_blockers"]]
    assert "quantities_missing" in codes and "prices_missing" not in codes


def test_mcp_requires_declared_eligible_engine(client):
    _demo(client)
    headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}

    def call(name, args):
        r = client.post("/mcp/", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                         "params": {"name": name, "arguments": args}})
        return r.json()["result"]

    res = call("submit_classification", {"email_id": "demo-m1", "category": "bmu", "confidence": 0.9, "reason": "x",
                                         "evidence": [{"quote": "Building Maintenance Unit (BMU)"}]})
    assert res.get("isError") is True and "declare_engine" in res["content"][0]["text"]


def test_new_revision_reopens_review_and_blocks_quotation(client):
    pytest.importorskip("ess.quotation.templates")
    _demo(client)
    from ess.db import session_scope
    from ess.models import Project, Quotation, Review
    from ess.pipeline.state import refresh_project_state, reopen_for_revision

    projects = {p["name"]: p for p in client.get("/api/projects").json()["items"]}
    pid = projects["Harbor Offices"]["id"]
    q = client.post("/api/quotations", json={"project_id": pid}).json()
    review = client.get(f"/api/projects/{pid}/review").json()
    client.put(f"/api/projects/{pid}/review", json={"checklist": [{**i, "status": "checked"} for i in review["checklist"]]})
    assert client.post(f"/api/projects/{pid}/review/approve", json={}).status_code == 200

    with session_scope() as s:  # a technical revision arrives by mail
        p = s.get(Project, pid)
        change = {"kind": "technical_revision", "title": "Revision R02: 36 months", "date": "2026-10-01T09:00:00Z"}
        p.changes = [*(p.changes or []), change]
        assert reopen_for_revision(s, p, change) is not None
        s.flush()
        refresh_project_state(s, p)
    detail = client.get(f"/api/projects/{pid}").json()
    assert detail["review"]["decision"] is None and detail["review"]["supersedes_id"]
    assert detail["project"]["stage"] == "engineer_review"
    items = [{**i, "unit_price": 50} for i in q["data"]["items"]]
    client.put(f"/api/quotations/{q['id']}", json={"data": {"items": items}})
    r = client.post(f"/api/quotations/{q['id']}/approve", json={})
    assert r.status_code == 409 and r.json()["detail"]["code"] in ("impact_review", "review_required")
    with session_scope() as s:
        reviews = s.query(Review).filter(Review.project_id == pid).all()
        assert sum(1 for r_ in reviews if r_.decision == "approved") == 1  # old sign-off kept in history
        assert s.get(Quotation, q["id"]).impact_review["required"] is True


def test_customer_response_is_separate_from_sent(client):
    _demo(client)
    enq = client.get("/api/enquiries").json()[0]
    r = client.patch(f"/api/enquiries/{enq['id']}", json={"customer_response": "clarification", "note": "asked about loads"})
    assert r.json()["customer_response"] == "clarification" and r.json()["status"] == "open"
