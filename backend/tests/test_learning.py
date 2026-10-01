"""Learning from corrections: category overrides, template rules and preferences, edit lessons, prompt memory."""
import copy
import importlib
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-learn-"))
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


def test_category_correction_becomes_a_rule(client):
    from ess.db import session_scope
    from ess.learning import learned_category, memory_context
    from ess.models import Email
    from ess.workspace import get_active_workspace

    r = client.patch("/api/emails/demo-v1", json={"category": "promotions"})
    assert r.status_code == 200
    with session_scope() as s:
        ws = get_active_workspace(s)
        new_mail = Email(id="x1", workspace_id=ws.id, thread_id="x1", from_email="partners@hoist-oem.example",
                         subject="Another OEM offer")
        learned = learned_category(s, ws, new_mail)
        assert learned and learned["category"] == "promotions"
        other_sender_same_domain = Email(id="x2", workspace_id=ws.id, thread_id="x2",
                                         from_email="sales@hoist-oem.example", subject="Offer")
        assert learned_category(s, ws, other_sender_same_domain)["category"] == "promotions"
        assert any("hoist-oem" in line for line in memory_context(
            s, ws, task="classify_email", sender_email=new_mail.from_email))
    lessons = client.get("/api/learning", params={"kind": "category_correction"}).json()
    assert lessons["summary"]["total"] >= 1


def test_bulk_category_change_teaches_like_a_single_one(client):
    r = client.post("/api/emails/bulk", json={"ids": ["demo-v1", "demo-b1"], "action": "set_category", "category": "other"})
    assert r.status_code == 200 and r.json()["updated"] == 2
    assert client.get("/api/emails/demo-v1").json()["email"]["category_source"] == "user"
    lessons = client.get("/api/learning", params={"kind": "category_correction"}).json()
    assert lessons["summary"]["total"] >= 2
    bad = client.post("/api/emails/bulk", json={"ids": ["demo-v1"], "action": "set_category", "category": "nope"})
    assert bad.status_code == 400


def test_prompt_memory_only_uses_applicable_company_and_service_lessons(client):
    from ess.db import session_scope
    from ess.learning import memory_context, record_lesson
    from ess.workspace import get_active_workspace

    with session_scope() as s:
        ws = get_active_workspace(s)
        record_lesson(s, ws, "review_note", scope="customer", scope_key="customer-a", note="A-specific scope")
        record_lesson(s, ws, "review_note", scope="customer", scope_key="customer-b", note="B-specific scope")
        record_lesson(s, ws, "review_note", scope="service_family", scope_key="bmu", note="BMU lesson")
        record_lesson(s, ws, "review_note", scope="service_family", scope_key="hoist", note="Hoist lesson")
        record_lesson(s, ws, "review_note", note="Workspace lesson")
        s.flush()
        memory = " ".join(memory_context(s, ws, task="draft_quotation", customer_id="customer-a", service_family="bmu"))
        assert "A-specific" in memory and "BMU lesson" in memory and "Workspace lesson" in memory
        assert "B-specific" not in memory and "Hoist lesson" not in memory
        assert "specific" not in " ".join(memory_context(s, ws, task="draft_quotation"))


@pytest.mark.parametrize("service_family,work_type,expected", [
    ("bmu", "annual_maintenance", "maintenance-choice"),
    ("bmu", "equipment_rental", "rental-choice"),
    ("hoist", "equipment_rental", "hoist-choice"),
    ("bmu", None, None),
    (None, "equipment_rental", None),
])
def test_template_prompt_memory_requires_exact_work_type(client, service_family, work_type, expected):
    from ess.db import session_scope
    from ess.learning import memory_context, record_lesson
    from ess.workspace import get_active_workspace

    with session_scope() as s:
        ws = get_active_workspace(s)
        for scope_key, choice in (("bmu|annual_maintenance", "maintenance-choice"),
                                  ("bmu|equipment_rental", "rental-choice"),
                                  ("hoist|equipment_rental", "hoist-choice"),
                                  ("bmu", "unqualified-choice")):
            record_lesson(s, ws, "template_choice", scope="service_family", scope_key=scope_key,
                          after={"template_key": choice})
        record_lesson(s, ws, "review_note", scope="service_family", scope_key="bmu",
                      note="Family-wide BMU note")
        record_lesson(s, ws, "review_note", note="Workspace-wide note")
        s.flush()
        memory = " ".join(memory_context(s, ws, task="draft_quotation", service_family=service_family,
                                         work_type=work_type))
        for choice in ("maintenance-choice", "rental-choice", "hoist-choice", "unqualified-choice"):
            assert (choice in memory) == (choice == expected)
        assert ("Family-wide BMU note" in memory) == (service_family == "bmu")
        assert "Workspace-wide note" in memory


def test_ai_drafting_receives_only_its_work_type_template_lessons(client, monkeypatch):
    from types import SimpleNamespace

    from ess.ai import tasks
    from ess.db import session_scope
    from ess.learning import record_lesson
    from ess.pipeline import drafting
    from ess.workspace import get_active_workspace

    with session_scope() as s:
        ws = get_active_workspace(s)
        record_lesson(s, ws, "template_choice", scope="service_family", scope_key="bmu|equipment_rental",
                      after={"template_key": "equipment_rental"})
        record_lesson(s, ws, "template_choice", scope="service_family", scope_key="bmu|annual_maintenance",
                      after={"template_key": "annual_maintenance"})
        record_lesson(s, ws, "review_note", scope="service_family", scope_key="bmu", note="Keep roof-load evidence")

    prompted = []

    def draft_from_fixture(engine, project, template_key, knowledge):
        prompted.extend(knowledge["lessons"])
        return {}

    monkeypatch.setattr(drafting, "engine_for", lambda *args: SimpleNamespace(engine=None))
    monkeypatch.setattr(tasks, "draft_quotation", draft_from_fixture)
    harbor = next(p for p in client.get("/api/projects").json()["items"] if p["name"] == "Harbor Offices")
    response = client.post("/api/quotations", json={"project_id": harbor["id"]})
    assert response.status_code == 200
    assert response.json()["created_by"] == "ai"
    memory = " ".join(prompted)
    assert "annual_maintenance" in memory
    assert "equipment_rental" not in memory
    assert "Keep roof-load evidence" in memory


def test_latest_correction_wins_and_unrelated_sender_lessons_are_not_prompted(client):
    from ess.db import session_scope
    from ess.learning import learned_category, memory_context, record_lesson
    from ess.models import Email
    from ess.workspace import get_active_workspace

    with session_scope() as s:
        ws = get_active_workspace(s)
        for _ in range(4):
            record_lesson(s, ws, "category_correction", scope="sender", scope_key="sales@alpha.example", after="bills")
            s.flush()
        record_lesson(s, ws, "category_correction", scope="sender", scope_key="sales@alpha.example", after="bmu")
        record_lesson(s, ws, "category_correction", scope="sender", scope_key="sales@beta.example", after="promotions")
        s.flush()
        mail = Email(workspace_id=ws.id, thread_id="new-alpha", from_email="sales@alpha.example", subject="RFQ")
        assert learned_category(s, ws, mail)["category"] == "bmu"
        memory = " ".join(memory_context(s, ws, task="classify_email", sender_email=mail.from_email))
        assert "alpha.example" in memory and "beta.example" not in memory
        assert "'bmu'" in memory and "'bills'" not in memory


def test_template_rule_and_learned_preference(client):
    pytest.importorskip("ess.quotation.templates")
    projects = {p["name"]: p for p in client.get("/api/projects").json()["items"]}
    harbor = projects["Harbor Offices"]
    marina = projects["Marina Tower A"]

    # A person tells the AI: projects like Harbor Offices use the service & repair template.
    rule = client.post(f"/api/projects/{harbor['id']}/template-preference",
                       json={"template_key": "service_repair", "scope": "project_type"}).json()
    assert rule["match"] == {"service_family": "bmu", "work_type": "annual_maintenance"}
    q = client.post("/api/quotations", json={"project_id": harbor["id"]}).json()
    assert q["template_key"] == "service_repair" and q["template_reason"].startswith("Rule")

    # Without a rule, repeated manual template switches become a learned preference.
    for _ in range(2):
        q2 = client.post("/api/quotations", json={"project_id": marina["id"]}).json()
        assert client.put(f"/api/quotations/{q2['id']}", json={"template_key": "supply_installation"}).status_code == 200
    q3 = client.post("/api/quotations", json={"project_id": marina["id"]}).json()
    assert q3["template_key"] == "supply_installation"
    assert q3["template_reason"].startswith("Learned")


def test_draft_edits_and_review_notes_are_remembered(client):
    pytest.importorskip("ess.quotation.templates")
    from ess.db import session_scope
    from ess.learning import memory_context
    from ess.workspace import get_active_workspace

    projects = {p["name"]: p for p in client.get("/api/projects").json()["items"]}
    marina = projects["Marina Tower A"]
    q = client.post("/api/quotations", json={"project_id": marina["id"]}).json()
    items = q["data"]["items"] + [{"no": 9, "description": "Third-party load test certificate", "qty": 1, "unit": "lot",
                                   "unit_price": None, "total": None}]
    client.put(f"/api/quotations/{q['id']}", json={"data": {"items": items, "exclusions": ["Civil works"]}})
    client.post(f"/api/projects/{marina['id']}/review/request-changes", json={"note": "Always state roof load per wheel"})
    with session_scope() as s:
        ws = get_active_workspace(s)
        memory = memory_context(s, ws, task="draft_quotation", service_family="bmu")
    text = " ".join(memory)
    assert "Third-party load test certificate" in text
    assert "roof load per wheel" in text


def test_business_learning_runs_on_mail_and_folder(client, tmp_path):
    from ess.api.knowledge import run_discovery
    from ess.db import session_scope
    from ess.models import AppState, KnowledgeItem
    from ess.workspace import get_active_workspace

    folder = tmp_path / "company"
    folder.mkdir()
    (folder / "AA-26-0101 quotation BMU.txt").write_text(
        "Ref: AA/26/0101\nQuotation for supply and installation of a Building Maintenance Unit (BMU) "
        "with telescopic jib and cradle, designed to EN 1808. Annual maintenance contract offered separately.")
    with session_scope() as s:
        ws_id = get_active_workspace(s).id
    result = run_discovery(ws_id, {"folders": [str(folder)]})
    assert result["saved"] > 0
    with session_scope() as s:
        kinds = {k.kind for k in s.query(KnowledgeItem).filter(KnowledgeItem.workspace_id == ws_id).all()}
        progress = s.get(AppState, f"learning:{ws_id}").value
    assert "service_family" in kinds or "term" in kinds
    assert progress["status"] == "done" and progress["steps"]["documents"]["status"] == "done"
