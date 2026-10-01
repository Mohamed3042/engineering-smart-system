"""Automation runner: steps run in order, the engineer-review step pauses the run, a person resumes it."""
import tempfile

import pytest


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-auto-"))
    from ess import config, db

    config.get_settings.cache_clear()
    db.reset_engine()
    db.init_db()
    yield
    db.reset_engine()
    config.get_settings.cache_clear()


def test_run_pauses_at_human_gate_and_resumes(env, monkeypatch):
    from sqlmodel import select

    from ess.automations import runner
    from ess.db import session_scope
    from ess.models import Automation, AutomationRun
    from ess.workspace import create_workspace

    calls = []
    monkeypatch.setitem(runner.STEPS, "classify", lambda ctx, cfg: calls.append("classify") or "ok")
    monkeypatch.setitem(runner.STEPS, "link_project", lambda ctx, cfg: calls.append("link") or "ok")
    monkeypatch.setitem(runner.STEPS, "request_review", lambda ctx, cfg: calls.append("review") or "review requested")
    monkeypatch.setattr(runner.jobs, "submit", lambda key, fn, *a, **kw: fn(*a, **kw) or True)

    with session_scope() as s:
        ws = create_workspace(s, {"name": "Acme", "primary_email": "sales@acme.example"})
        auto = Automation(workspace_id=ws.id, key="t", name="Test", steps=[
            {"key": "a", "label": "Classify", "type": "classify"},
            {"key": "b", "label": "Link", "type": "link_project"},
            {"key": "c", "label": "Review", "type": "request_review", "requires_approval": True},
        ])
        s.add(auto)
        auto_id = auto.id

    run_id = runner.start_run(auto_id)
    with session_scope() as s:
        run = s.get(AutomationRun, run_id)
        assert run.status == "waiting_approval"
        assert [st["status"] for st in run.steps] == ["done", "done", "waiting_approval"]
    assert calls == ["classify", "link"]

    runner.resume_run(run_id, "Engineer")
    with session_scope() as s:
        run = s.get(AutomationRun, run_id)
        assert run.status == "succeeded"
        assert run.steps[2]["approved_by"] == "Engineer"
    assert calls == ["classify", "link", "review"]


def test_failed_step_stops_the_run(env, monkeypatch):
    from ess.automations import runner
    from ess.db import session_scope
    from ess.models import Automation, AutomationRun
    from ess.workspace import create_workspace

    def boom(ctx, cfg):
        raise RuntimeError("mailbox not connected")

    monkeypatch.setitem(runner.STEPS, "classify", boom)
    monkeypatch.setattr(runner.jobs, "submit", lambda key, fn, *a, **kw: fn(*a, **kw) or True)
    with session_scope() as s:
        ws = create_workspace(s, {"name": "Acme", "primary_email": "sales@acme.example"})
        auto = Automation(workspace_id=ws.id, key="t", name="Test", steps=[
            {"key": "a", "label": "Classify", "type": "classify"},
            {"key": "b", "label": "Notify", "type": "notify"},
        ])
        s.add(auto)
        auto_id = auto.id
    run_id = runner.start_run(auto_id)
    with session_scope() as s:
        run = s.get(AutomationRun, run_id)
        assert run.status == "failed"
        assert run.steps[0]["status"] == "failed" and "mailbox" in run.steps[0]["message"]
        assert run.steps[1]["status"] == "pending"
