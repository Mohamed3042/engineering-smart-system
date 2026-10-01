"""Mailbox scan with a fake mail source: classification, tender grouping, enquiries, change detection."""
import importlib
import tempfile
from datetime import datetime, timezone

import pytest


class FakeMessage(dict):
    def model_dump(self):
        return dict(self)


def msg(id_, thread, sender, name, subject, day, body, direction="inbound", attachments=None):
    return FakeMessage(id=id_, thread_id=thread, account="sales@acme.example", direction=direction, from_name=name,
                       from_email=sender, to=["sales@acme.example"], cc=[], subject=subject,
                       date=datetime(2026, 9, day, 9, 0, tzinfo=timezone.utc), snippet=body[:100], body_text=body,
                       body_html=None, labels=["INBOX"], attachments=attachments or [], list_unsubscribe=None,
                       list_unsubscribe_post=None, view_url=None)


THREADS = {
    "t1": [msg("m1", "t1", "est@alpha-contracting.example", "Ali", "RFQ: Window cleaning system works - Harbour Mall @ Plot 12",
               1, "Dear Sir, please quote the window cleaning system works (monorail and davit) for TENDER NO. RFP-2149999.\n"
                  "Date of Closing : 13th Sep' 2026 (ie 13/09/2026)\nRegards, Ali, Tender Officer",
               attachments=[{"attachment_id": "a1", "filename": "BOQ-Div11.pdf", "mime": "application/pdf", "size": 1000}])],
    "t2": [msg("m2", "t2", "tender@beta-builders.example", "Sara", "Inquiry_Harbour Mall Plot 12_Request For Quotation",
               3, "Dear Sir/Madam, we invite you to quote the façade cleaning works (window cleaning, monorail) for "
                  "RFP-2149999. Documents: https://we.tl/t-ABC123 Regards, Sara")],
    "t3": [msg("m3", "t1", "est@alpha-contracting.example", "Ali", "FW: RFQ: Window cleaning system works - Harbour Mall @ Plot 12",
               20, "Dear Sir,\nPlease be informing you that the above tender closing date has been extended to 18/10/2026.\nBest Regards")],
    "t4": [msg("m4", "t4", "deals@shop.example", "Shop", "Big autumn sale - 70% off", 5,
               "Huge discounts this week only. Unsubscribe here.")],
}


class FakeSource:
    def search(self, query, after=None, before=None, max_results=500):
        return ["t1", "t2", "t3", "t4"]

    def get_thread(self, thread_id):
        return THREADS[thread_id]

    def test(self):
        return {"ok": True, "account": "sales@acme.example"}


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-scan-"))
    from ess import config, db

    config.get_settings.cache_clear()
    db.reset_engine()
    db.init_db()
    import ess.pipeline.scan as scan

    importlib.reload(scan)
    monkeypatch.setattr(scan, "mail_source_for", lambda s, ws, conn=None: FakeSource())
    monkeypatch.setattr(scan, "_auto_fetch", lambda job_id: None)
    yield scan
    db.reset_engine()
    config.get_settings.cache_clear()


def test_scan_groups_enquiries_and_detects_extension(env):
    from sqlmodel import select

    from ess.db import session_scope
    from ess.models import Email, Enquiry, Project, ProjectFile, ProjectLink, ScanJob
    from ess.workspace import create_workspace

    with session_scope() as s:
        ws = create_workspace(s, {"name": "Acme", "primary_email": "sales@acme.example"})
        job = ScanJob(workspace_id=ws.id, scope={"date_from": "2026-08-01"})
        s.add(job)
        job_id = job.id
    counts = env.run_scan(job_id)
    assert counts["threads"] == 4
    with session_scope() as s:
        promo = s.get(Email, "m4")
        assert promo.category == "promotions" and promo.project_id is None
        projects = s.exec(select(Project)).all()
        assert len(projects) == 1, [p.name for p in projects]
        p = projects[0]
        assert p.service_family == "wce" and p.tender_no == "2149999"
        enquiries = s.exec(select(Enquiry).where(Enquiry.project_id == p.id)).all()
        assert len(enquiries) == 2
        alpha = next(e for e in enquiries if "alpha" in e.ref)
        assert alpha.due_date.isoformat() == "2026-10-18"
        assert alpha.due_date_history and alpha.due_date_history[0]["value"] == "2026-09-13"
        kinds = [c["kind"] for c in p.changes]
        assert "deadline_changed" in kinds
        assert p.next_action["kind"] == "review_change"
        files = s.exec(select(ProjectFile).where(ProjectFile.project_id == p.id)).all()
        assert [f.name for f in files] == ["BOQ-Div11.pdf"]
        links = s.exec(select(ProjectLink).where(ProjectLink.project_id == p.id)).all()
        assert any(l.kind == "wetransfer" and l.status == "approved" for l in links)
