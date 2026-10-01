"""IMAP connector: RFC 822 parsing (Arabic encoded headers), threading, search, drafts, approved send."""
from __future__ import annotations

import email
import email.policy
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from fake_imap import FakeIMAP, FakeSMTP  # noqa: E402

from ess.sources.base import AuthError  # noqa: E402
from ess.sources.imap import (  # noqa: E402
    ImapSource,
    group_threads,
    imap_utf7_decode,
    imap_utf7_encode,
    parse_fetch_response,
    root_for_thread_id,
    thread_id_for_root,
)
from ess.sources.mime import get_attachment_payload, parse_rfc822  # noqa: E402

RAW_RFQ = (Path(__file__).resolve().parent / "fixtures" / "rfq_arabic.eml").read_bytes()


def _mail(msgid: str, subject: str, body: str, *, sender="A. Engineer <a.engineer@contractor.example>", to="sales@medmack.com",
          refs: str = "", reply_to: str = "", date="Thu, 27 Aug 2026 10:00:00 +0300") -> bytes:
    lines = [f"From: {sender}", f"To: {to}", f"Subject: {subject}", f"Date: {date}", f"Message-ID: {msgid}"]
    if refs:
        lines.append(f"References: {refs}")
    if reply_to:
        lines.append(f"In-Reply-To: {reply_to}")
    lines += ["MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body, ""]
    return "\r\n".join(lines).encode("utf-8")


OUR_REPLY = _mail("<ourreply@medmack.com>", "Re: RFQ BMU", "Received, offer to follow.", sender="Sales <sales@medmack.com>",
                  to="a.engineer@contractor.example", refs="<root-0001@mail.contractor.example> <rfq-0118@mail.contractor.example>",
                  reply_to="<rfq-0118@mail.contractor.example>")
FOLLOW_UP = _mail("<rfq-0119@mail.contractor.example>", "Re: RFQ BMU", "Closing date extended for the BMU package.",
                  refs="<root-0001@mail.contractor.example> <rfq-0118@mail.contractor.example> <ourreply@medmack.com>",
                  reply_to="<ourreply@medmack.com>", date="Mon, 21 Sep 2026 08:38:07 +0300")
NEWSLETTER = _mail("<news-1@offers.example.com>", "Weekly offers", "Scaffolding discounts", sender="offers@example.com",
                   date="Tue, 01 Sep 2026 06:00:00 +0000")


def make_generic(**kwargs) -> tuple[ImapSource, FakeIMAP, FakeSMTP]:
    fake = FakeIMAP(
        {
            "INBOX": [
                {"uid": 11, "raw": RAW_RFQ, "flags": ["\\Seen"], "internaldate": "26-Aug-2026 08:20:26 +0000"},
                {"uid": 12, "raw": FOLLOW_UP, "flags": [], "internaldate": "21-Sep-2026 05:38:07 +0000"},
                {"uid": 13, "raw": NEWSLETTER, "flags": [], "internaldate": "01-Sep-2026 06:00:00 +0000"},
            ],
            "Sent Items": [{"uid": 5, "raw": OUR_REPLY, "flags": ["\\Seen"], "internaldate": "27-Aug-2026 07:00:00 +0000"}],
            "Drafts": [],
            "Junk": [],
        },
        special={"Sent Items": "\\Sent", "Drafts": "\\Drafts", "Junk": "\\Junk"},
    )
    smtp = FakeSMTP()
    source = ImapSource("imap.example.com", 993, "sales@medmack.com", "app-password", own_domains=("medmack.com",),
                        connection_factory=lambda: fake, smtp_factory=lambda: smtp, **kwargs)
    return source, fake, smtp


def test_parse_canned_rfc822_with_arabic_headers():
    msg = parse_rfc822(RAW_RFQ, message_id="11:777:INBOX", thread_id="t", account="sales@medmack.com",
                       own_domains=["medmack.com"])
    assert msg.subject == "RFQ – طلب تسعير وحدة صيانة المباني BMU"
    assert msg.from_name == "محمد إبراهيم" and msg.from_email == "a.engineer@contractor.example"
    assert msg.to == ["sales@medmack.com"] and msg.cc == ["tenders@contractor.example"]
    assert msg.date == datetime(2026, 8, 26, 8, 20, 26, tzinfo=timezone.utc)
    assert msg.direction == "inbound"
    assert "يرجى تسعير وحدة صيانة المباني" in msg.body_text and "drive.google.com/drive/folders" in msg.body_text
    assert msg.body_html and "<b>BMU</b>" in msg.body_html
    assert msg.headers["References"] == "<root-0001@mail.contractor.example> <rfq-0117@mail.contractor.example>"
    assert msg.list_unsubscribe == "<https://contractor.example/unsubscribe?id=9>"
    pdf, forwarded = msg.attachments
    assert pdf.filename == "BOQ - جدول الكميات.pdf" and pdf.mime == "application/pdf" and pdf.attachment_id == "2"
    assert forwarded.mime == "message/rfc822" and forwarded.filename.endswith(".eml")
    assert "Addendum 1" not in msg.body_text  # the attached e-mail is not merged into the body
    assert get_attachment_payload(RAW_RFQ, pdf.attachment_id).startswith(b"%PDF-1.4")


def test_thread_helpers():
    assert root_for_thread_id(thread_id_for_root("<root-0001@mail.contractor.example>")) == "root-0001@mail.contractor.example"
    groups = group_threads([
        {"key": 1, "message_id": "a@x", "in_reply_to": None, "references": [], "fallback_root": "u1"},
        {"key": 2, "message_id": "b@x", "in_reply_to": "a@x", "references": [], "fallback_root": "u2"},
        {"key": 3, "message_id": "c@x", "in_reply_to": "b@x", "references": [], "fallback_root": "u3"},
        {"key": 4, "message_id": None, "in_reply_to": None, "references": [], "fallback_root": "uid:4:777:INBOX"},
    ])
    assert sorted(groups.values()) == [[1, 2, 3], [4]]
    assert imap_utf7_decode("Entw&APw-rfe") == "Entwürfe" and imap_utf7_encode("Entwürfe") == "Entw&APw-rfe"
    assert imap_utf7_decode(imap_utf7_encode("المسودات")) == "المسودات"
    entries = parse_fetch_response([(b'1 (UID 5 X-GM-THRID 99 BODY[] {3}', b"abc"), b" FLAGS (\\Seen))",
                                    b"2 (UID 6 X-GM-THRID 100)"])
    assert [(e["uid"], e["thrid"], e["literal"], e["flags"]) for e in entries] == [
        (5, 99, b"abc", ["\\Seen"]), (6, 100, None, [])]


def test_search_groups_threads_across_folders():
    source, fake, _ = make_generic()
    threads = source.search("BMU", after="2026-08-01", before="2026-10-01")
    assert threads == [thread_id_for_root("root-0001@mail.contractor.example")]
    searches = [c for c in fake.commands if c[0] == "SEARCH"]
    assert ("SEARCH", "SINCE", "01-Aug-2026", "BEFORE", "01-Oct-2026", "TEXT", '"BMU"') in searches

    messages = source.get_thread(threads[0])
    assert [m.id for m in messages] == ["11:777:INBOX", "5:777:Sent Items", "12:777:INBOX"]
    rfq, reply, follow_up = messages
    assert reply.direction == "outbound" and "SENT" in reply.labels
    assert rfq.direction == "inbound" and "UNREAD" not in rfq.labels and "UNREAD" in follow_up.labels
    assert all(m.thread_id == threads[0] for m in messages)
    pdf = rfq.attachments[0]
    assert source.download_attachment(rfq.id, pdf.attachment_id).startswith(b"%PDF-1.4")


def test_search_unicode_and_or_queries():
    source, fake, _ = make_generic()
    assert source.search("وحدة صيانة") == [thread_id_for_root("root-0001@mail.contractor.example")]
    literal_search = [c for c in fake.commands if c[0] == "SEARCH" and "TEXT" in c][-1]
    assert literal_search[-1] == "وحدة صيانة"  # sent as a UTF-8 literal

    found = source.search("scaffolding OR gondola from:a.engineer@contractor.example has:attachment")
    assert found == [thread_id_for_root("news-1@offers.example.com")]
    assert ("SEARCH", "TEXT", '"gondola"', "FROM", '"a.engineer@contractor.example"') in fake.commands


def test_create_draft_then_approved_send():
    source, fake, smtp = make_generic()
    draft_id = source.create_draft(
        "a.engineer@contractor.example", "Re: RFQ – BMU", "Dear Mr. Engineer,\nOur offer is attached.",
        attachments=[("Offer AA-26-0118.pdf", b"%PDF-1.4 offer", "application/pdf")],
        in_reply_to="11:777:INBOX",
    )
    assert draft_id.startswith("<") and draft_id.endswith("@medmack.com>")
    [stored] = fake.mailboxes["Drafts"]
    assert "\\Draft" in stored["flags"]
    draft = email.message_from_bytes(stored["raw"], policy=email.policy.default)
    assert draft["In-Reply-To"] == "<rfq-0118@mail.contractor.example>"
    assert draft["References"] == "<root-0001@mail.contractor.example> <rfq-0117@mail.contractor.example> <rfq-0118@mail.contractor.example>"
    assert [a.get_filename() for a in draft.iter_attachments()] == ["Offer AA-26-0118.pdf"]
    assert smtp.sent == []  # nothing leaves before approval

    sent_id = source.send_draft(draft_id)
    assert sent_id == draft_id
    [delivery] = smtp.sent
    assert delivery["to"] == ["a.engineer@contractor.example"] and delivery["from"] == "sales@medmack.com"
    assert fake.mailboxes["Drafts"] == []  # draft removed after sending
    assert any(email.message_from_bytes(m["raw"])["Message-ID"] == draft_id for m in fake.mailboxes["Sent Items"])


def test_connection_test_and_login_errors():
    source, _, _ = make_generic()
    result = source.test()
    assert result["ok"] and result["drafts_folder"] == "Drafts" and result["sent_folder"] == "Sent Items"
    assert result["gmail"] is False and result["inbox_messages"] == 3

    bad = ImapSource("imap.gmail.com", username="sales@medmack.com", password="wrong",
                     connection_factory=lambda: FakeIMAP({"INBOX": []}, gmail=True))
    outcome = bad.test()
    assert outcome["ok"] is False and "app password" in outcome["error"]
    with pytest.raises(AuthError):
        bad.search("BMU")
    assert bad.smtp_host == "smtp.gmail.com"


def test_gmail_imap_uses_gmail_ids_and_labels():
    sent = _mail("<ourreply@medmack.com>", "Re: RFQ BMU", "Offer soon.", sender="sales@medmack.com",
                 to="a.engineer@contractor.example", refs="<rfq-0118@mail.contractor.example>")
    fake = FakeIMAP(
        {
            "INBOX": [],
            "[Gmail]/All Mail": [
                {"uid": 301, "raw": RAW_RFQ, "flags": ["\\Seen"], "internaldate": "26-Aug-2026 08:20:26 +0000",
                 "thrid": 0x18F1A2B3C4D5E6F7, "msgid": 0x18F1A2B3C4D5E6F7, "labels": ["\\Inbox", "\\Important"]},
                {"uid": 302, "raw": sent, "flags": ["\\Seen"], "internaldate": "27-Aug-2026 07:00:00 +0000",
                 "thrid": 0x18F1A2B3C4D5E6F7, "msgid": 0x18F1A2B3C4D5E700, "labels": ["\\Sent"]},
                {"uid": 303, "raw": NEWSLETTER, "flags": [], "internaldate": "01-Sep-2026 06:00:00 +0000",
                 "thrid": 0x1, "msgid": 0x1, "labels": ["\\Inbox"]},
            ],
            "[Gmail]/Drafts": [],
        },
        special={"[Gmail]/All Mail": "\\All", "[Gmail]/Drafts": "\\Drafts"},
        gmail=True,
    )
    source = ImapSource("imap.gmail.com", username="sales@medmack.com", password="app-password",
                        connection_factory=lambda: fake)
    assert source.search("BMU", after="2026-08-01") == ["18f1a2b3c4d5e6f7"]
    assert ("SEARCH", "X-GM-RAW", '"BMU after:2026/08/01"') in fake.commands
    first, reply = source.get_thread("18f1a2b3c4d5e6f7")
    assert first.id == "18f1a2b3c4d5e6f7" and reply.id == "18f1a2b3c4d5e700"
    assert first.labels == ["INBOX", "IMPORTANT"] and reply.labels == ["SENT"]
    assert reply.direction == "outbound" and first.direction == "inbound"
    assert first.view_url.endswith("#all/18f1a2b3c4d5e6f7")
    assert source.download_attachment(first.id, first.attachments[0].attachment_id).startswith(b"%PDF")
    draft_id = source.create_draft(["a.engineer@contractor.example"], "Re: RFQ", "Offer attached", in_reply_to=first.id)
    assert fake.mailboxes["[Gmail]/Drafts"] and draft_id.endswith("@medmack.com>")
