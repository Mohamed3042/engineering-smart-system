"""Mailbox imports keep fictional source identities and distinct attachment bytes intact."""
import hashlib
import json

import pytest
from sqlmodel import select

from test_core_api import client  # isolated data directory and disabled scheduler


def _snapshot():
    return {
        "format": "ess-workspace-snapshot/1",
        "emails": [
            {"id": f"provenance-mail-{n}", "thread_id": "provenance-thread", "account": "sales@fictional.example",
             "from_name": "Fictional Estimator", "from_email": "estimator@fictional-customer.example",
             "to": ["sales@fictional.example"], "cc": ["reviewer@fictional.example"],
             "subject": "Fictional equipment repair request", "date": "2026-09-30T08:00:00Z",
             "body_text": f"Please review fictional source document {n}.", "project_ref": "P-PROVENANCE"}
            for n in (1, 2)
        ],
        "projects": [{
            "ref": "P-PROVENANCE", "name": "Fictional source review", "service_family": "other_work",
            "work_type": "service_repair", "request_kind": "direct_rfq",
            "email_ids": ["provenance-mail-1", "provenance-mail-2"],
            "enquiries": [{"ref": f"E-SOURCE-{n}", "email_ids": [f"provenance-mail-{n}"],
                           "thread_ids": ["provenance-thread"]} for n in (1, 2)],
            "files": [], "attachments": [],
        }],
    }


def _setup(client):
    response = client.post("/api/workspaces", json={"name": "Fictional Access", "primary_email": "sales@fictional.example"})
    assert response.status_code == 200
    return response.json()["id"]


def _import(client, snapshot):
    return client.post("/api/workspace/import", files={"file": ("fictional.json", json.dumps(snapshot), "application/json")})


def _project(client):
    return next(p for p in client.get("/api/projects").json()["items"] if p["ref"] == "P-PROVENANCE")


def _attachments():
    return [
        {"email_id": email_id, "attachment_id": attachment_id, "filename": "source.txt", "mime": "text/plain"}
        for email_id, attachment_id in [("provenance-mail-1", "first"), ("provenance-mail-1", "second"),
                                        ("provenance-mail-2", "first")]
    ]


def _downloaded_files(tmp_path):
    files, expected = [], {}
    for n, attachment in enumerate(_attachments(), 1):
        content = f"Fictional original document {n}.\n".encode()
        path = tmp_path / f"source-{n}.txt"
        path.write_bytes(content)
        files.append({**attachment, "name": attachment["filename"], "path": str(path),
                      "source": "email_attachment", "size": 999})
        expected[(attachment["email_id"], attachment["attachment_id"])] = content
    return files, expected


def test_import_endpoint_preserves_account_and_original_mail_metadata(client):
    _setup(client)
    snap = _snapshot()
    assert _import(client, snap).status_code == 200
    original = snap["emails"][0]
    saved = client.get("/api/emails/provenance-mail-1").json()["email"]
    for field in ("account", "from_name", "from_email", "to", "cc", "subject", "body_text", "thread_id"):
        assert saved[field] == original[field]
    assert saved["date"].startswith("2026-09-30T08:00:00")
    # A shallow follow-up that omits the account must retain both it and the deep-read body.
    shallow = {"format": snap["format"], "emails": [{"id": original["id"], "subject": original["subject"]}]}
    assert _import(client, shallow).status_code == 200
    saved = client.get("/api/emails/provenance-mail-1").json()["email"]
    assert saved["account"] == original["account"] and saved["body_text"] == original["body_text"]
    exported = client.get("/api/workspace/export").json()
    assert all(mail["account"] == "sales@fictional.example" for mail in exported["emails"])


def test_same_named_downloads_preserve_each_identity_bytes_and_roundtrip(client, tmp_path):
    _setup(client)
    snap = _snapshot()
    snap["projects"][0]["files"], expected = _downloaded_files(tmp_path)
    snap["projects"][0]["attachments"] = _attachments()
    assert _import(client, snap).status_code == 200
    project_id = _project(client)["id"]
    before = client.get(f"/api/projects/{project_id}").json()
    files = before["files"]
    enquiries = {e["ref"]: e["id"] for e in before["enquiries"]}
    assert len(files) == 3 and len({f["path"] for f in files}) == 3
    for file in files:
        content = expected[(file["email_id"], file["attachment_id"])]
        assert file["name"] == "source.txt" and file["status"] == "ready"
        assert file["enquiry_id"] == enquiries[f"E-SOURCE-{file['email_id'][-1]}"]
        assert file["sha256"] == hashlib.sha256(content).hexdigest() and file["size"] == len(content)
        assert client.get(f"/api/files/{file['id']}/content").content == content
    assert len(client.get("/api/emails/provenance-mail-1").json()["files"]) == 2
    assert len(client.get("/api/emails/provenance-mail-2").json()["files"]) == 1
    assert _import(client, snap).status_code == 200
    exported = client.get("/api/workspace/export").json()
    assert {f["enquiry_ref"] for f in exported["projects"][0]["files"]} == {"E-SOURCE-1", "E-SOURCE-2"}
    assert _import(client, exported).status_code == 200
    after = client.get(f"/api/projects/{project_id}").json()["files"]
    assert {(f["id"], f["path"], f["sha256"]) for f in after} == {(f["id"], f["path"], f["sha256"]) for f in files}
    from ess.config import get_settings

    assert len(list((get_settings().files_dir / project_id).iterdir())) == 3


def test_download_fills_exact_metadata_placeholder_and_accepts_enquiry_id(client, tmp_path):
    _setup(client)
    snap = _snapshot()
    snap["projects"][0]["attachments"] = _attachments()
    assert _import(client, snap).status_code == 200
    detail = client.get(f"/api/projects/{_project(client)['id']}").json()
    before = {(f["email_id"], f["attachment_id"]): f["id"] for f in detail["files"]}
    assert all(f["status"] == "not_downloaded" and f["path"] is None for f in detail["files"])
    snap["projects"][0]["files"], expected = _downloaded_files(tmp_path)
    enquiries = {e["ref"]: e["id"] for e in detail["enquiries"]}
    for f in snap["projects"][0]["files"]:
        f["enquiry_id"] = enquiries[f"E-SOURCE-{f['email_id'][-1]}"]
    assert _import(client, snap).status_code == 200
    after = client.get(f"/api/projects/{_project(client)['id']}").json()["files"]
    assert {(f["email_id"], f["attachment_id"]): f["id"] for f in after} == before
    for f in after:
        assert f["status"] == "ready" and client.get(f"/api/files/{f['id']}/content").content == expected[(f["email_id"], f["attachment_id"])]


def test_legacy_metadata_is_adopted_within_message_without_touching_same_named_upload(client, tmp_path):
    workspace_id = _setup(client)
    snap = _snapshot()
    snap["projects"][0]["attachments"] = [{"email_id": "provenance-mail-1", "filename": "source.txt"}]
    assert _import(client, snap).status_code == 200
    project_id = _project(client)["id"]
    original = client.get(f"/api/projects/{project_id}").json()["files"][0]
    from ess.db import session_scope
    from ess.models import ProjectFile

    with session_scope() as session:
        unrelated = ProjectFile(workspace_id=workspace_id, project_id=project_id, name="source.txt", source="upload")
        session.add(unrelated)
        session.flush()
        unrelated_id = unrelated.id
    files, expected = _downloaded_files(tmp_path)
    snap["projects"][0]["files"] = files[:1]
    snap["projects"][0]["attachments"] = _attachments()[:1]
    assert _import(client, snap).status_code == 200
    result = client.get(f"/api/files/{original['id']}").json()
    assert result["attachment_id"] == "first" and result["status"] == "ready"
    assert client.get(f"/api/files/{result['id']}/content").content == expected[("provenance-mail-1", "first")]
    other = client.get(f"/api/files/{unrelated_id}").json()
    assert other["email_id"] is None and other["path"] is None and other["source"] == "upload"


@pytest.mark.parametrize("invalid", ["foreign_email", "foreign_enquiry", "other_project_enquiry", "missing_email",
                                     "orphan_attachment", "missing_enquiry", "disagreeing_enquiry"])
def test_invalid_source_identity_is_rejected_without_saving_bytes(client, tmp_path, invalid):
    workspace_id = _setup(client)
    snap = _snapshot()
    assert _import(client, snap).status_code == 200
    from ess.db import session_scope
    from ess.models import Email, Enquiry, Project, Workspace

    with session_scope() as session:
        foreign = Workspace(name="Other Fictional Workspace")
        session.add(foreign)
        foreign_project = Project(workspace_id=foreign.id, ref="P-FOREIGN", name="Other fictional request")
        local_project = Project(workspace_id=workspace_id, ref="P-OTHER", name="Another fictional request")
        session.add(foreign_project)
        session.add(local_project)
        session.add(Email(id="foreign-source-mail", workspace_id=foreign.id, thread_id="foreign-thread", body_text="Private fictional source"))
        foreign_enquiry = Enquiry(workspace_id=foreign.id, project_id=foreign_project.id, ref="E-FOREIGN")
        local_enquiry = Enquiry(workspace_id=workspace_id, project_id=local_project.id, ref="E-OTHER")
        session.add(foreign_enquiry)
        session.add(local_enquiry)
        session.flush()
        foreign_enquiry_id, local_enquiry_id = foreign_enquiry.id, local_enquiry.id
    files, _ = _downloaded_files(tmp_path)
    bad_file = files[0]
    if invalid == "foreign_email":
        bad_file["email_id"] = "foreign-source-mail"
    elif invalid == "foreign_enquiry":
        bad_file["enquiry_id"] = foreign_enquiry_id
    elif invalid == "other_project_enquiry":
        bad_file["enquiry_id"] = local_enquiry_id
    elif invalid == "missing_email":
        bad_file["email_id"] = "missing-source-mail"
    elif invalid == "missing_enquiry":
        bad_file["enquiry_id"] = "missing-enquiry"
    elif invalid == "disagreeing_enquiry":
        detail = client.get(f"/api/projects/{_project(client)['id']}").json()
        bad_file["enquiry_id"] = next(e["id"] for e in detail["enquiries"] if e["ref"] == "E-SOURCE-2")
    else:
        bad_file.pop("email_id")
    snap["projects"][0]["files"] = [bad_file]
    snap["emails"][0]["body_text"] = "This rejected update must roll back."
    response = _import(client, snap)
    assert response.status_code == 400 and response.json()["detail"]["code"] == "bad_snapshot"
    saved = client.get("/api/emails/provenance-mail-1").json()["email"]
    assert saved["body_text"] == _snapshot()["emails"][0]["body_text"]
    from ess.config import get_settings

    assert not list(get_settings().files_dir.rglob("*.txt"))


def test_cross_workspace_message_collision_does_not_overwrite_source(client):
    _setup(client)
    from ess.db import session_scope
    from ess.models import Email, Project, Workspace

    with session_scope() as session:
        foreign = Workspace(name="Other Fictional Workspace")
        session.add(foreign)
        session.add(Email(id="provenance-mail-1", workspace_id=foreign.id, thread_id="foreign-thread",
                          account="mail@other-fictional.example", body_text="Original foreign fictional message"))
    response = _import(client, _snapshot())
    assert response.status_code == 400
    with session_scope() as session:
        mail = session.get(Email, "provenance-mail-1")
        assert mail.workspace_id == foreign.id and mail.body_text == "Original foreign fictional message"
        assert mail.account == "mail@other-fictional.example"
        assert not session.exec(select(Project)).all()
