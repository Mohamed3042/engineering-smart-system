"""Refiling preserves source documents and keeps thread/enquiry ownership consistent."""
from datetime import timedelta

import pytest
from sqlmodel import select

from test_review_fixes import client, _projects, _ws_id  # shared isolated fictional workspace fixture


def test_refiling_moves_link_owned_documents_without_replacing_the_source(client):
    from ess.db import session_scope
    from ess.models import Email, Enquiry, ProjectFile, ProjectLink
    from ess.pipeline.files import store_bytes

    target = _projects(client)["Harbor Offices"]["id"]
    source = client.get("/api/emails/demo-m1").json()["email"]
    content = b"%PDF-1.4\nfictional original source bytes\n"
    with session_scope() as session:
        link = ProjectLink(workspace_id=_ws_id(), project_id=source["project_id"], email_id="demo-m1",
                           url="https://drive.google.com/fictional-refiling-source", kind="google_drive",
                           status="downloaded", files_count=1)
        session.add(link)
        session.flush()
        path, digest = store_bytes(source["project_id"], "same-name.pdf", content)
        document = ProjectFile(workspace_id=_ws_id(), project_id=source["project_id"],
                               enquiry_id=source["enquiry_id"], link_id=link.id, email_id=None,
                               name="same-name.pdf", source="google_drive", status="ready", path=path,
                               sha256=digest, mime="application/pdf", extraction_status="extracted",
                               extraction={"text_path": "original/text.txt", "meta": {"pages": 2}})
        session.add(document)
        session.add(ProjectFile(workspace_id=_ws_id(), project_id=target, name="same-name.pdf", source="upload"))
        session.flush()
        link_id, file_id = link.id, document.id
        extraction = dict(document.extraction)

    for _ in range(2):
        result = client.post("/api/emails/demo-m1/link", json={"project_id": target})
        assert result.status_code == 200, result.text
        enquiry_id = result.json()["email"]["enquiry_id"]
        with session_scope() as session:
            moved = session.get(ProjectFile, file_id)
            assert session.get(ProjectLink, link_id).project_id == target
            assert (moved.project_id, moved.enquiry_id, moved.email_id) == (target, enquiry_id, None)
            assert (moved.path, moved.sha256, moved.extraction, moved.status) == (path, digest, extraction, "ready")
            assert session.get(Enquiry, enquiry_id).project_id == target
    assert client.get(f"/api/files/{file_id}/content").content == content


@pytest.mark.parametrize("selected_outbound", [False, True])
def test_outbound_thread_messages_follow_the_destination_enquiry(client, selected_outbound):
    from ess.db import session_scope
    from ess.models import Email, Enquiry, ProjectFile

    target = _projects(client)["Harbor Offices"]["id"]
    with session_scope() as session:
        inbound = session.get(Email, "demo-m1")
        source_project, source_enquiry = inbound.project_id, inbound.enquiry_id
        outbound = Email(id="refile-outgoing", workspace_id=inbound.workspace_id, thread_id=inbound.thread_id,
                         direction="outbound", from_email="sales@fictional.example", to=[inbound.from_email],
                         subject="Re: fictional request", project_id=source_project, enquiry_id=source_enquiry,
                         date=inbound.date - timedelta(days=1))
        session.add(outbound)
        old = session.get(Enquiry, source_enquiry)
        old.email_ids = [*old.email_ids, outbound.id]
        session.add(old)
        file = ProjectFile(workspace_id=inbound.workspace_id, project_id=source_project,
                           enquiry_id=source_enquiry, email_id=outbound.id, name="our-response.txt",
                           source="email_attachment", status="ready", path="source/response.txt", sha256="preserve")
        session.add(file)
        session.flush()
        file_id = file.id

    selected = "refile-outgoing" if selected_outbound else "demo-m1"
    response = client.post(f"/api/emails/{selected}/link", json={"project_id": target})
    assert response.status_code == 200, response.text
    assert response.json()["enquiry"]["project_id"] == target
    with session_scope() as session:
        inbound, outgoing = session.get(Email, "demo-m1"), session.get(Email, "refile-outgoing")
        destination = session.get(Enquiry, outgoing.enquiry_id)
        assert outgoing.project_id == target and outgoing.enquiry_id == inbound.enquiry_id
        assert outgoing.id in destination.email_ids and outgoing.thread_id in destination.thread_ids
        assert outgoing.id not in session.get(Enquiry, source_enquiry).email_ids
        moved_file = session.get(ProjectFile, file_id)
        assert (moved_file.project_id, moved_file.enquiry_id) == (target, destination.id)
        assert (moved_file.path, moved_file.sha256) == ("source/response.txt", "preserve")


def test_outbound_only_thread_gets_a_destination_enquiry(client):
    from ess.db import session_scope
    from ess.models import Email, Enquiry

    target = _projects(client)["Harbor Offices"]["id"]
    with session_scope() as session:
        original = session.get(Email, "demo-m1")
        message = Email(id="refile-outgoing-only", workspace_id=original.workspace_id, thread_id="outgoing-only",
                        direction="outbound", from_email="sales@fictional.example", to=[original.from_email],
                        project_id=original.project_id, enquiry_id=original.enquiry_id)
        session.add(message)
        old = session.get(Enquiry, original.enquiry_id)
        old.email_ids = [*old.email_ids, message.id]
        old.thread_ids = [*old.thread_ids, message.thread_id]
        session.add(old)
    response = client.post("/api/emails/refile-outgoing-only/link", json={"project_id": target})
    assert response.status_code == 200, response.text
    assert response.json()["enquiry"]["project_id"] == target
    assert "refile-outgoing-only" in response.json()["enquiry"]["email_ids"]
    assert "outgoing-only" in response.json()["enquiry"]["thread_ids"]


def test_same_named_attachments_keep_distinct_source_identities(client):
    from ess.db import session_scope
    from ess.models import Email, ProjectFile

    target = _projects(client)["Harbor Offices"]["id"]
    with session_scope() as session:
        ws_id = _ws_id()
        session.add(ProjectFile(workspace_id=ws_id, project_id=target, email_id="previous-email",
                                attachment_id="previous-id", name="roof.pdf", source="email_attachment", status="ready"))
        session.add(Email(id="same-name-source", workspace_id=ws_id, thread_id="same-name-thread",
                          direction="inbound", from_email="sender@fictional.example", subject="Roof drawing",
                          attachments=[{"filename": "roof.pdf", "attachment_id": "new-revision-1"},
                                       {"filename": "roof.pdf", "attachment_id": "new-revision-2"}]))
    for _ in range(2):
        response = client.post("/api/emails/same-name-source/link", json={"project_id": target})
        assert response.status_code == 200, response.text
    with session_scope() as session:
        files = session.exec(select(ProjectFile).where(ProjectFile.email_id == "same-name-source")).all()
        assert {file.attachment_id for file in files} == {"new-revision-1", "new-revision-2"}
        assert len(files) == 2
        assert all(file.project_id == target and file.status == "not_downloaded" for file in files)


def test_legacy_attachment_adopts_source_id_without_losing_saved_data(client):
    from ess.db import session_scope
    from ess.models import Email, ProjectFile

    target = _projects(client)["Harbor Offices"]["id"]
    with session_scope() as session:
        ws_id = _ws_id()
        message = Email(id="legacy-attachment-source", workspace_id=ws_id, thread_id="legacy-thread",
                        from_email="sender@fictional.example", attachments=[{"filename": "legacy.pdf", "attachment_id": "provider-id"}])
        session.add(message)
        file = ProjectFile(workspace_id=ws_id, project_id=target, email_id=message.id, name="legacy.pdf",
                           source="email_attachment", status="ready", path="original/legacy.pdf", sha256="source-hash",
                           extraction_status="extracted", extraction={"meta": {"pages": 2}})
        session.add(file)
        session.flush()
        file_id = file.id
    response = client.post("/api/emails/legacy-attachment-source/link", json={"project_id": target})
    assert response.status_code == 200, response.text
    with session_scope() as session:
        files = session.exec(select(ProjectFile).where(ProjectFile.email_id == "legacy-attachment-source")).all()
        assert len(files) == 1 and files[0].id == file_id
        assert files[0].attachment_id == "provider-id"
        assert (files[0].path, files[0].sha256, files[0].extraction_status) == ("original/legacy.pdf", "source-hash", "extracted")


def test_refiling_never_moves_another_workspaces_thread_or_link_files(client):
    from ess.db import session_scope
    from ess.models import Email, ProjectFile, ProjectLink, Workspace

    target = _projects(client)["Harbor Offices"]["id"]
    source = client.get("/api/emails/demo-m1").json()["email"]
    with session_scope() as session:
        foreign = Workspace(name="Separate fictional company", company_name="Separate Company")
        session.add(foreign)
        session.flush()
        alien_message = Email(id="foreign-thread-peer", workspace_id=foreign.id, thread_id=source["thread_id"],
                              project_id="foreign-project", enquiry_id="foreign-enquiry")
        alien_file = ProjectFile(workspace_id=foreign.id, project_id="foreign-project", name="foreign.pdf",
                                 email_id="demo-m1", status="ready", path="foreign/source.pdf", sha256="foreign-hash")
        alien_link = ProjectLink(workspace_id=foreign.id, project_id="foreign-project", email_id="demo-m1",
                                 url="https://drive.google.com/foreign-fictional", kind="google_drive")
        session.add_all([alien_message, alien_file, alien_link])
        session.flush()
        file_id, link_id = alien_file.id, alien_link.id
    response = client.post("/api/emails/demo-m1/link", json={"project_id": target})
    assert response.status_code == 200, response.text
    with session_scope() as session:
        assert session.get(Email, "foreign-thread-peer").project_id == "foreign-project"
        assert session.get(ProjectFile, file_id).project_id == "foreign-project"
        assert session.get(ProjectLink, link_id).project_id == "foreign-project"
