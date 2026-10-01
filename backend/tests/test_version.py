"""A running server identifies its original checkout, even if the checkout later changes."""
import subprocess

import pytest
from fastapi.testclient import TestClient

from ess import version
from ess.main import create_app


def test_health_identity_is_public_and_captured_at_app_creation(monkeypatch):
    monkeypatch.setenv("ESS_ACCESS_TOKEN", "private-test-token")
    monkeypatch.setattr("ess.main.get_build_commit", lambda: "a" * 40)
    app = create_app()
    monkeypatch.setattr("ess.main.get_build_commit", lambda: "b" * 40)
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["version"] == app.version == version.VERSION
    assert data["build_commit"] == "a" * 40
    assert set(data) == {"ok", "time", "version", "build_commit"}


def test_unversioned_install_does_not_read_parent_checkout(tmp_path, monkeypatch):
    def unexpected_git(*args, **kwargs):
        pytest.fail("An unversioned install must not inspect an enclosing repository")
    monkeypatch.setattr(version.subprocess, "run", unexpected_git)
    assert version.get_build_commit(tmp_path) == "unknown"


@pytest.mark.parametrize("output", ["a" * 40, "b" * 64, "C:/private/checkout", "", "bad-hash"])
def test_only_actual_hash_shape_is_exposed(tmp_path, monkeypatch, output):
    (tmp_path / ".git").touch()
    monkeypatch.setattr(version.subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 0, output, ""))
    expected = output if len(output) in (40, 64) else "unknown"
    assert version.get_build_commit(tmp_path) == expected


def test_missing_git_reports_unknown(tmp_path, monkeypatch):
    (tmp_path / ".git").touch()
    def missing_git(*args, **kwargs):
        raise FileNotFoundError("git")
    monkeypatch.setattr(version.subprocess, "run", missing_git)
    assert version.get_build_commit(tmp_path) == "unknown"
