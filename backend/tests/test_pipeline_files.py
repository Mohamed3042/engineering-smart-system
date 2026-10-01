"""Project inputs end to end: upload a tender ZIP, read every document inside, analyse without AI, render the page."""
import copy
import importlib
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from ess_input_fixtures import make_boq_xlsx, make_tender_pdf, zip_bytes  # noqa: E402


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-files-"))
    monkeypatch.setenv("ESS_SCHEDULER", "0")
    from ess import config, db, jobs

    config.get_settings.cache_clear()
    db.reset_engine()
    # run background jobs inline so the test sees their result
    monkeypatch.setattr(jobs, "submit", lambda key, fn, *a, **kw: jobs._call(fn, *a, **kw) is None or True)
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


def test_zip_upload_is_unpacked_read_and_analysed(client, tmp_path):
    projects = {p["name"]: p for p in client.get("/api/projects").json()["items"]}
    pid = projects["Crescent School"]["id"]
    pdf = make_tender_pdf(tmp_path / "tender.pdf").read_bytes()
    boq = make_boq_xlsx(tmp_path / "boq.xlsx").read_bytes()
    bundle = zip_bytes({"Tender/Drawings-and-specs.pdf": pdf, "Tender/BOQ-Div11.xlsx": boq})
    r = client.post(f"/api/projects/{pid}/files", files={"file": ("tender-set.zip", bundle, "application/zip")})
    assert r.status_code == 200

    detail = client.get(f"/api/projects/{pid}").json()
    names = {f["name"]: f for f in detail["files"]}
    assert {"tender-set.zip", "Drawings-and-specs.pdf", "BOQ-Div11.xlsx"} <= set(names), names.keys()
    boq_file = names["BOQ-Div11.xlsx"]
    assert boq_file["status"] == "ready" and boq_file["extraction"]["boq_items"] > 0
    assert boq_file["extraction"]["boq_relevant"], "Div-11 BMU rows should be flagged"
    pdf_file = names["Drawings-and-specs.pdf"]
    assert pdf_file["pages"] >= 1

    png = client.get(f"/api/files/{pdf_file['id']}/pages/1.png")
    assert png.status_code == 200 and png.content[:8] == b"\x89PNG\r\n\x1a\n"

    result = client.post(f"/api/projects/{pid}/analyze", params={"wait": True}).json()
    assert result["status"] == "done" and result["stats"]["engine"] == "rules"
    after = client.get(f"/api/projects/{pid}").json()
    assert after["project"]["stage"] == "engineer_review"
    assert after["review"]["checklist"]
