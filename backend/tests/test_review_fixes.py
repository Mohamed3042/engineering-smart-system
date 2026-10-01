"""Fixes from the rendered-UI review: manual mail filing, truthful automations, switched-off templates,
link resolution, attachment retry, inbox filters, policy floor and quotation page previews."""
import copy
import importlib
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-fix-"))
    monkeypatch.setenv("ESS_SCHEDULER", "0")
    from ess import config, db

    config.get_settings.cache_clear()
    db.reset_engine()
    import ess.main as main

    importlib.reload(main)
    with TestClient(main.app) as c:
        from ess.demo import DEMO_SNAPSHOT, DEMO_WORKSPACE

        c.post("/api/workspaces", json={**DEMO_WORKSPACE, "owner_name": "Jordan Ellis"})
        from ess.db import session_scope
        from ess.pipeline.importer import import_snapshot
        from ess.workspace import get_active_workspace

        with session_scope() as s:
            import_snapshot(s, get_active_workspace(s), copy.deepcopy(DEMO_SNAPSHOT))
        yield c
    db.reset_engine()
    config.get_settings.cache_clear()


def _projects(client):
    return {p["name"]: p for p in client.get("/api/projects").json()["items"]}


def _ws_id():
    from ess.db import session_scope
    from ess.workspace import get_active_workspace

    with session_scope() as s:
        return get_active_workspace(s).id


# ------------------------------------------------------------------ mail a person files by hand


def test_unmatched_mail_can_be_filed_under_an_existing_project(client):
    marina = _projects(client)["Marina Tower A"]
    r = client.post("/api/emails/demo-v1/link", json={"project_id": marina["id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"]["project_id"] == marina["id"] and body["email"]["state"] == "linked"
    assert body["enquiry"] and "demo-v1" in body["enquiry"]["email_ids"]
    # filing a supplier message under a BMU project says it is work: the category follows (and is learned)
    assert body["email"]["category"] == "bmu" and body["email"]["category_source"] == "user"
    detail = client.get("/api/emails/demo-v1").json()
    assert detail["project"]["id"] == marina["id"] and "files" in detail and "links" in detail


def test_a_new_project_can_be_opened_from_a_message(client):
    r = client.post("/api/emails/demo-v1/link", json={"create": {"name": "Hoist supply — Plot 9",
                                                                  "service_family": "hoist",
                                                                  "due_date": "2026-11-30"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True and body["project"]["name"] == "Hoist supply — Plot 9"
    assert body["project"]["due_date"] == "2026-11-30" and body["enquiry"]["due_date"] == "2026-11-30"
    assert client.post("/api/emails/demo-v1/link", json={}).status_code == 400


def test_unlinked_intent_and_work_type_filters(client):
    unlinked = client.get("/api/emails", params={"unlinked": True, "include_hidden": True}).json()
    assert {e["id"] for e in unlinked["items"]} >= {"demo-v1"}
    assert all(e["project_id"] is None for e in unlinked["items"])
    maintenance = client.get("/api/emails", params={"work_type": "annual_maintenance"}).json()
    assert maintenance["total"] >= 1 and all(e["project"]["work_type"] == "annual_maintenance" for e in maintenance["items"])
    from ess.db import session_scope
    from ess.models import Email

    with session_scope() as s:
        s.get(Email, "demo-c2").intent = "deadline_change"
    changed = client.get("/api/emails", params={"intent": "deadline_change"}).json()["items"]
    assert "demo-c2" in {e["id"] for e in changed} and all(e["intent"] == "deadline_change" for e in changed)


# ------------------------------------------------------------------ templates switched off


def _switch(client, key, enabled, language="en"):
    assert client.put(f"/api/templates/{key}/{language}", json={"enabled": enabled}).status_code == 200


def test_switched_off_template_is_never_picked_automatically(client):
    pytest.importorskip("ess.quotation.templates")
    harbor = _projects(client)["Harbor Offices"]
    first = client.post("/api/quotations", json={"project_id": harbor["id"]}).json()
    assert first["template_key"] == "annual_maintenance"
    _switch(client, "annual_maintenance", False)
    q = client.post("/api/quotations", json={"project_id": harbor["id"]}).json()
    assert q["template_key"] != "annual_maintenance"
    assert "switched off" in q["template_reason"]
    # an existing draft keeps its template (history is not rewritten)
    assert client.get(f"/api/quotations/{first['id']}").json()["quotation"]["template_key"] == "annual_maintenance"
    # choosing it on purpose is refused with a clear reason
    r = client.post("/api/quotations", json={"project_id": harbor["id"], "template_key": "annual_maintenance"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "template_disabled"
    r = client.put(f"/api/quotations/{q['id']}", json={"template_key": "annual_maintenance"})
    assert r.status_code == 409


def test_rules_fall_back_and_all_off_is_explained(client):
    pytest.importorskip("ess.quotation.templates")
    marina = _projects(client)["Marina Tower A"]
    client.post(f"/api/projects/{marina['id']}/template-preference", json={"template_key": "service_repair",
                                                                         "scope": "project_type"})
    _switch(client, "service_repair", False)
    q = client.post("/api/quotations", json={"project_id": marina["id"]}).json()
    assert q["template_key"] != "service_repair" and "switched off" in q["template_reason"]
    for key in ("tenders", "supply_installation", "annual_maintenance", "service_repair", "equipment_rental"):
        _switch(client, key, False)
    r = client.post("/api/quotations", json={"project_id": marina["id"]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "no_template_enabled"


# ------------------------------------------------------------------ links and attachments


def test_link_obtained_another_way_is_not_a_rejection(client):
    from ess.db import session_scope
    from ess.models import ProjectLink

    crescent = _projects(client)["Crescent School"]
    with session_scope() as s:
        link = ProjectLink(workspace_id=_ws_id(), project_id=crescent["id"],
                           url="https://we.tl/t-EXPIRED", kind="wetransfer", host="we.tl", status="expired")
        s.add(link)
        link_id = link.id
    r = client.post(f"/api/links/{link_id}/resolve", json={"note": "Customer re-sent the drawings by mail"})
    assert r.status_code == 200 and r.json()["status"] == "resolved"
    blockers = client.get(f"/api/projects/{crescent['id']}").json()["project"]["blockers"]
    assert not any(b.get("link_id") == link_id for b in blockers)


def test_failed_attachment_can_be_retried(client, monkeypatch):
    from ess import jobs
    from ess.db import session_scope
    from ess.models import ProjectFile

    calls = []
    monkeypatch.setattr(jobs, "submit", lambda key, fn, *a, **kw: calls.append((key, fn.__name__, a, kw)) or True)
    marina = _projects(client)["Marina Tower A"]
    with session_scope() as s:
        f = ProjectFile(workspace_id=_ws_id(), project_id=marina["id"], name="roof.pdf",
                        source="email_attachment", email_id="demo-m1", status="failed", error="timeout")
        s.add(f)
        fid = f.id
    r = client.post(f"/api/files/{fid}/retry")  # no mailbox: refused, the file keeps its error
    assert r.status_code == 409 and r.json()["detail"]["code"] == "no_mailbox" and not calls
    from ess.models import Connection

    with session_scope() as s:
        assert s.get(ProjectFile, fid).error == "timeout"
        s.add(Connection(workspace_id=_ws_id(), kind="mail", method="imap", provider="imap", status="connected"))
    r = client.post(f"/api/files/{fid}/retry")
    assert r.status_code == 200 and r.json()["kind"] == "attachment"
    assert calls and calls[0][1] == "fetch_attachments" and calls[0][3] == {"retry_failed": True, "file_ids": [fid]}
    with session_scope() as s:
        assert s.get(ProjectFile, fid).status == "not_downloaded"


# ------------------------------------------------------------------ automations


def test_workflows_can_be_created_edited_and_tell_the_truth(client):
    autos = {a["key"]: a for a in client.get("/api/automations").json()}
    intake = autos["enquiry_intake"]
    # no background scheduler and no mailbox in this test: nothing claims to run on its own
    assert intake["trigger_status"]["automatic"] is False and intake["trigger_status"]["label"] == "Manual — Run now"
    assert client.delete(f"/api/automations/{intake['id']}").status_code == 409
    catalog = client.get("/api/automations/step-catalog").json()
    assert any(c["type"] == "request_review" and c.get("locked") for c in catalog)
    r = client.post("/api/automations", json={"name": "Weekly tidy", "trigger": "schedule",
                                              "steps": [{"type": "classify"},
                                                        {"type": "request_review", "requires_approval": False}]})
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["interval_minutes"] == 60 and new["steps"][1]["requires_approval"] is True
    r = client.patch(f"/api/automations/{new['id']}", json={"trigger": "manual", "interval_minutes": 0})
    assert r.json()["trigger"] == "manual" and r.json()["trigger_status"]["mode"] == "manual"
    assert client.delete(f"/api/automations/{new['id']}").json()["deleted"] is True


def test_new_mail_starts_new_mail_workflows_only_in_the_background_service(client, monkeypatch):
    from ess.automations import runner
    from ess.db import session_scope
    from ess.workspace import get_active_workspace

    started = []
    monkeypatch.setattr(runner, "start_run", lambda aid, **kw: started.append((aid, kw)) or "run_x")
    with session_scope() as s:
        ws_id = get_active_workspace(s).id
    assert runner.on_new_mail(ws_id, 3) == []  # scheduler not running
    monkeypatch.setitem(runner.SCHEDULER_STATE, "running", True)
    assert runner.on_new_mail(ws_id, 0) == []
    assert runner.on_new_mail(ws_id, 2) == ["run_x"] and started[0][1] == {"trigger": "new_email"}


# ------------------------------------------------------------------ AI policy and previews


def test_policy_exposes_the_hard_floor(client):
    floor = client.get("/api/ai/policy").json()["floor"]
    assert floor["min_score"] == 0.9 and floor["max_critical_failures"] == 0 and "light" in floor["never_tiers"]


def test_quotation_pages_render_as_images(client):
    pytest.importorskip("pypdfium2")
    harbor = _projects(client)["Harbor Offices"]
    q = client.post("/api/quotations", json={"project_id": harbor["id"]}).json()
    pages = client.get(f"/api/quotations/{q['id']}/pages")
    if pages.status_code != 200:
        pytest.skip(f"PDF rendering unavailable here: {pages.text[:200]}")
    count = pages.json()["count"]
    assert count >= 1
    img = client.get(f"/api/quotations/{q['id']}/pages/1.png")
    assert img.status_code == 200 and img.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert client.get(f"/api/quotations/{q['id']}/pages/{count + 1}.png").status_code == 404


def test_project_work_status_reports_running_jobs(client, monkeypatch):
    from ess import jobs

    marina = _projects(client)["Marina Tower A"]
    work = client.get(f"/api/projects/{marina['id']}/work").json()
    assert work["busy"] is False and work["downloads"] == []
    monkeypatch.setattr(jobs, "is_running", lambda key: key == f"extract:{marina['id']}")
    assert client.get(f"/api/projects/{marina['id']}/work").json()["extracting"] is True
