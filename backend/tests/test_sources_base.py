"""Provider-neutral mail helpers: models, HTML -> text, quoted history, addresses, dates."""
from __future__ import annotations

from datetime import date, datetime, timezone

from ess.sources.base import (
    MailAttachment,
    MailMessage,
    MailSource,
    NotSupported,
    build_gmail_query,
    default_own_domains,
    html_to_text,
    infer_direction,
    parse_address,
    parse_address_list,
    parse_mail_date,
    pick_headers,
    split_quoted_history,
)


def test_mail_message_model_defaults_and_tz():
    msg = MailMessage(id="m1", thread_id="t1", date=datetime(2026, 8, 26, 8, 20, 26),
                      body_text="Dear Sir,\n  please   quote BMU.", attachments=[MailAttachment(filename="BOQ.pdf")])
    assert msg.date.tzinfo is not None and msg.date.utcoffset().total_seconds() == 0
    assert msg.snippet == "Dear Sir, please quote BMU."
    assert msg.attachments[0].attachment_id is None and msg.attachments[0].mime == "application/octet-stream"
    dumped = msg.model_dump(mode="json")
    assert dumped["date"].startswith("2026-08-26T08:20:26") and dumped["direction"] == "inbound"
    assert issubclass(NotSupported, Exception)


def test_protocol_is_runtime_checkable():
    class Dummy:
        account = "a@b.com"

        def search(self, query, after=None, before=None, max_results=500): return []
        def get_thread(self, thread_id): return []
        def download_attachment(self, message_id, attachment_id): return b""
        def create_draft(self, to, subject, body_text, attachments=(), in_reply_to=None, thread_id=None): return "d"
        def send_draft(self, draft_id): return "s"
        def test(self): return {"ok": True, "account": self.account, "error": None}

    assert isinstance(Dummy(), MailSource)


def test_html_to_text_links_tables_quotes():
    html = """<html><head><style>p{color:red}</style><script>alert(1)</script></head><body>
    <div style="display:none">preheader junk</div>
    <p>Dear Sir,<br>Please find the drawings <a href="https://we.tl/t-AbC123">here</a> and
    <a href="https://drive.google.com/drive/folders/1Abc">https://drive.google.com/drive/folders/1Abc</a>.</p>
    <p>Contact <a href="mailto:a.engineer@contractor.example">a.engineer@contractor.example</a> or <a href="mailto:x@y.com">Ali</a></p>
    <table><tr><th>Item</th><th>Qty</th></tr><tr><td>BMU</td><td>1</td></tr></table>
    <ul><li>Monorail</li><li>Davits</li></ul>
    <div class="gmail_quote">On Tue wrote:<blockquote>Old line<br>second</blockquote></div>
    </body></html>"""
    text = html_to_text(html)
    assert "alert" not in text and "color:red" not in text and "preheader" not in text
    assert "drawings here (https://we.tl/t-AbC123)" in text
    assert "https://drive.google.com/drive/folders/1Abc." in text and "(https://drive.google.com" not in text
    assert "Contact a.engineer@contractor.example or Ali (x@y.com)" in text
    assert "Item | Qty\nBMU | 1" in text
    assert "- Monorail" in text and "- Davits" in text
    assert "> Old line\n> second" in text
    assert html_to_text("") == "" and html_to_text(None) == ""


def test_split_gmail_reply_and_wrapped_attribution():
    body = ("Thanks, noted.\n\nOn Wed, Aug 26, 2026 at 11:20 AM A. Engineer <\na.engineer@contractor.example> wrote:\n"
            "> Dear Sir,\n> please quote.\n")
    split = split_quoted_history(body)
    assert split.new_text == "Thanks, noted."
    assert len(split.blocks) == 1 and split.blocks[0].kind == "reply"
    assert "A. Engineer" in split.blocks[0].header and split.blocks[0].text == "Dear Sir,\nplease quote."
    assert split.has_history and "please quote" in split.quoted_text


def test_split_outlook_blocks_nested():
    body = (
        "Please see our revised scope.\n\n________________________________\n"
        "From: A. Engineer <a.engineer@contractor.example>\nSent: Wednesday, August 26, 2026 11:20 AM\n"
        "To: Sales <sales@medmack.com>\nSubject: RE: RFQ BMU\n\nDear Sir, please quote the BMU.\n\n"
        "-----Original Message-----\nFrom: Sales\nSent: Tuesday, August 25, 2026 9:00 AM\nTo: A. Engineer\n"
        "Subject: RFQ BMU\n\nWe received your enquiry.\n"
    )
    split = split_quoted_history(body)
    assert split.new_text == "Please see our revised scope."
    assert [b.kind for b in split.blocks] == ["reply", "reply"]
    assert split.blocks[0].header.startswith("From: A. Engineer") and "Sent:" in split.blocks[0].header
    assert split.blocks[0].text == "Dear Sir, please quote the BMU."
    assert split.blocks[1].text == "We received your enquiry."


def test_split_forward_and_arabic_and_plain_quotes():
    fwd = ("FYI\n\n---------- Forwarded message ---------\nFrom: Consultant <c@kec.com>\n"
           "Date: Mon, Sep 21, 2026 at 8:00 AM\nSubject: Addendum 1\nTo: UE <t@contractor.example>\n\nClosing date extended.\n")
    split = split_quoted_history(fwd)
    assert split.new_text == "FYI" and split.blocks[0].kind == "forward"
    assert split.blocks[0].text == "Closing date extended."

    arabic = "شكراً لكم\n\nفي الأربعاء، 26 أغسطس 2026 في 11:20 ص كتب A. Engineer <m@contractor.example>:\n> نص قديم\n"
    split = split_quoted_history(arabic)
    assert split.new_text == "شكراً لكم" and split.blocks[0].text == "نص قديم"

    quoted = "Agreed, go ahead.\n\n> You wrote that the\n> BMU needs a parking bay\n"
    split = split_quoted_history(quoted)
    assert split.new_text == "Agreed, go ahead." and split.blocks[0].kind == "quote"
    assert split.blocks[0].text == "You wrote that the\nBMU needs a parking bay"

    plain = split_quoted_history("Just one message.\nNo history here.")
    assert plain.blocks == [] and plain.new_text == "Just one message.\nNo history here."


def test_addresses_and_direction():
    assert parse_address('"A. Engineer" <A.Engineer@Contractor.EXAMPLE>') == ("A. Engineer", "a.engineer@contractor.example")
    assert parse_address("=?UTF-8?B?2YXYrdmF2K8g2KXYqNix2KfZh9mK2YU=?= <m@contractor.example>") == ("محمد إبراهيم", "m@contractor.example")
    assert parse_address("sales@medmack.com") == (None, "sales@medmack.com")
    assert parse_address(None) == (None, None)
    assert parse_address_list(["A <a@x.com>, b@y.com", "A@X.com"]) == ["a@x.com", "b@y.com"]
    assert parse_address_list("Sales <sales@medmack.com>; tenders@contractor.example") == ["sales@medmack.com", "tenders@contractor.example"]

    assert default_own_domains("sales@medmack.com") == ("medmack.com",)
    assert default_own_domains("someone@gmail.com") == ()
    assert infer_direction("sales@medmack.com", "sales@medmack.com") == "outbound"
    assert infer_direction("eng@medmack.com", "sales@medmack.com", ("medmack.com",)) == "outbound"
    assert infer_direction("m@contractor.example", "sales@medmack.com", ("medmack.com",)) == "inbound"
    assert infer_direction("x@y.com", None, (), ["SENT"]) == "outbound"
    assert pick_headers([("message-id", "<a@b>"), ("X-Junk", "1"), ("list-unsubscribe", "<mailto:u@x>")]) == {
        "Message-ID": "<a@b>", "List-Unsubscribe": "<mailto:u@x>"}


def test_dates_and_queries():
    utc = timezone.utc
    assert parse_mail_date("Wed, 26 Aug 2026 11:20:26 +0300") == datetime(2026, 8, 26, 8, 20, 26, tzinfo=utc)
    assert parse_mail_date("2026-08-26T08:20:26Z") == datetime(2026, 8, 26, 8, 20, 26, tzinfo=utc)
    assert parse_mail_date("1787732426000") == datetime.fromtimestamp(1787732426, tz=utc)
    assert parse_mail_date("") is None and parse_mail_date("not a date at all !!") is None
    assert build_gmail_query("bmu OR gondola", "2026-08-01", date(2026, 10, 1)) == \
        "bmu OR gondola after:2026/08/01 before:2026/10/01"
    exact = datetime(2026, 8, 1, 12, 0, tzinfo=utc)
    assert build_gmail_query("", exact) == f"after:{int(exact.timestamp())}"
