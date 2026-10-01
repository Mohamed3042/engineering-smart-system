"""Gmail API connector against canned API JSON (googleapiclient HTTP mocks, no network)."""
from __future__ import annotations

import base64
import email
import email.policy
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from googleapiclient.discovery import build
from googleapiclient.http import HttpMockSequence

from ess.sources.base import AuthError, MailSourceError
from ess.sources.gmail_api import SCOPES, GmailApiSource, gmail_auth_url, gmail_exchange_code, parse_gmail_message

FIXTURES = Path(__file__).resolve().parent / "fixtures"
THREAD = json.loads((FIXTURES / "gmail_thread.json").read_text(encoding="utf-8"))
CLIENT_CONFIG = {"installed": {"client_id": "cid.apps.googleusercontent.com", "client_secret": "secret",
                               "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                               "token_uri": "https://oauth2.googleapis.com/token"}}


class RecordingHttp(HttpMockSequence):
    """HttpMockSequence that remembers every request (uri, method, body)."""

    def __init__(self, responses):
        super().__init__([({"status": str(status), **headers}, body if isinstance(body, (str, bytes)) else json.dumps(body))
                          for status, body, headers in responses])
        self.requests: list[dict] = []

    def request(self, uri, method="GET", body=None, headers=None, redirections=1, connection_type=None):
        if hasattr(body, "read"):  # resumable uploads send stream slices
            body = body.read()
        self.requests.append({"uri": uri, "method": method, "body": body})
        return super().request(uri, method, body, headers, redirections, connection_type)


def make_source(responses, **kwargs) -> tuple[GmailApiSource, RecordingHttp]:
    http = RecordingHttp([(r[0], r[1], r[2] if len(r) > 2 else {}) for r in responses])
    service = build("gmail", "v1", http=http, static_discovery=True, cache_discovery=False)
    return GmailApiSource(service=service, account="sales@medmack.com", **kwargs), http


def test_get_thread_parses_full_payloads():
    source, http = make_source([(200, THREAD)])
    messages = source.get_thread("18f1a2b3c4d5e6f7")
    assert "/threads/18f1a2b3c4d5e6f7" in http.requests[0]["uri"] and "format=full" in http.requests[0]["uri"]
    first, reply, update = messages

    assert first.from_name == "A. Engineer" and first.from_email == "a.engineer@contractor.example"
    assert first.to == ["sales@medmack.com"] and first.cc == ["tenders@contractor.example", "ali.k@contractor.example"]
    assert first.subject == "RFQ: BMU for Harbour Tower – طلب تسعير"
    assert first.date == datetime(2026, 8, 26, 8, 20, 26, tzinfo=timezone.utc)
    assert first.direction == "inbound" and first.labels[0] == "INBOX"
    assert "Please quote for the supply and installation" in first.body_text
    assert "https://we.tl/t-AbCdEf1234" in first.body_text and "\r" not in first.body_text
    assert first.body_html and "<b>BMU</b>" in first.body_html
    assert first.snippet.endswith("Tower & Plot 12.")  # HTML entities unescaped
    names = {a.filename: a for a in first.attachments}
    assert names["Tender BOQ.pdf"].attachment_id == "ANGjdJ_boq_pdf" and names["Tender BOQ.pdf"].size == 245760
    assert not names["Tender BOQ.pdf"].inline
    logo = names["image001.png"]
    assert logo.inline and logo.content_id == "image001.png@01DB1234"
    assert first.headers["Message-ID"] == "<CAF1234abcd@mail.contractor.example>"
    assert first.view_url == "https://mail.google.com/mail/?authuser=sales%40medmack.com#all/18f1a2b3c4d5e6f7"

    assert reply.direction == "outbound" and reply.from_email == "sales@medmack.com"
    assert reply.headers["In-Reply-To"] == "<CAF1234abcd@mail.contractor.example>"
    assert reply.split_body().new_text.endswith("Regards,\nSales")

    assert update.from_name == "محمد إبراهيم"  # RFC 2047 encoded display name
    assert "تم تمديد الموعد النهائي إلى 18 أكتوبر 2026" in update.body_text  # windows-1256 HTML body
    assert update.list_unsubscribe.startswith("<mailto:unsubscribe@contractor.example")
    assert update.list_unsubscribe_post == "List-Unsubscribe=One-Click"
    assert [m.date for m in messages] == sorted(m.date for m in messages)


def test_large_text_body_fetched_by_attachment_id():
    body = base64.urlsafe_b64encode("Long body text from an attachment id".encode()).decode()
    data = {"id": "m1", "threadId": "t1", "internalDate": "1787732426000",
            "payload": {"mimeType": "text/plain", "headers": [{"name": "From", "value": "a@b.com"}],
                        "body": {"attachmentId": "BIGBODY", "size": 900000}}}
    fetched = []
    msg = parse_gmail_message(data, fetch_body=lambda aid: fetched.append(aid) or base64.urlsafe_b64decode(body))
    assert fetched == ["BIGBODY"] and msg.body_text == "Long body text from an attachment id"


def test_search_paginates_with_date_bounds():
    source, http = make_source([
        (200, {"threads": [{"id": "t1"}, {"id": "t2"}], "nextPageToken": "page-2"}),
        (200, {"threads": [{"id": "t2"}, {"id": "t3"}]}),
    ])
    ids = source.search("BMU OR gondola", after="2026-08-01", before="2026-10-01", max_results=50)
    assert ids == ["t1", "t2", "t3"]
    first = parse_qs(urlsplit(http.requests[0]["uri"]).query)
    assert first["q"] == ["BMU OR gondola after:2026/08/01 before:2026/10/01"]
    assert first["maxResults"] == ["50"] and first["includeSpamTrash"] == ["false"]
    assert parse_qs(urlsplit(http.requests[1]["uri"]).query)["pageToken"] == ["page-2"]

    limited, _ = make_source([(200, {"threads": [{"id": f"t{i}"} for i in range(5)], "nextPageToken": "x"})])
    assert limited.search("", max_results=3) == ["t0", "t1", "t2"]


def test_download_attachment_decodes_base64url():
    payload = b"%PDF-1.7\n\xff\xfe binary"
    source, http = make_source([(200, {"size": len(payload), "data": base64.urlsafe_b64encode(payload).decode().rstrip("=")})])
    assert source.download_attachment("18f1a2b3c4d5e6f7", "ANGjdJ_boq_pdf") == payload
    assert "/messages/18f1a2b3c4d5e6f7/attachments/ANGjdJ_boq_pdf" in http.requests[0]["uri"]


def test_create_reply_draft_and_send():
    meta = {"id": "18f1a2b3c4d5e6f7", "threadId": "18f1a2b3c4d5e6f7",
            "payload": {"headers": [{"name": "Message-ID", "value": "<CAF1234abcd@mail.contractor.example>"},
                                    {"name": "References", "value": "<root@contractor.example>"}]}}
    source, http = make_source([
        (200, meta),
        (200, {"id": "r-draft-1", "message": {"id": "m9", "threadId": "18f1a2b3c4d5e6f7"}}),
        (200, {"id": "sent-77", "threadId": "18f1a2b3c4d5e6f7", "labelIds": ["SENT"]}),
    ])
    draft_id = source.create_draft(
        ["a.engineer@contractor.example"], "Re: RFQ: BMU for Harbour Tower", "Dear Mr. Engineer,\nPlease find our offer.",
        attachments=[("Quotation AA-26-0118.pdf", b"%PDF-1.4 offer", "application/pdf")],
        in_reply_to="18f1a2b3c4d5e6f7",
    )
    assert draft_id == "r-draft-1"
    assert "format=metadata" in http.requests[0]["uri"]
    body = json.loads(http.requests[1]["body"])
    assert body["message"]["threadId"] == "18f1a2b3c4d5e6f7"
    raw = base64.urlsafe_b64decode(body["message"]["raw"] + "==")
    mime = email.message_from_bytes(raw, policy=email.policy.default)
    assert mime["To"] == "a.engineer@contractor.example" and mime["From"] == "sales@medmack.com"
    assert mime["In-Reply-To"] == "<CAF1234abcd@mail.contractor.example>"
    assert mime["References"] == "<root@contractor.example> <CAF1234abcd@mail.contractor.example>"
    [attachment] = list(mime.iter_attachments())
    assert attachment.get_filename() == "Quotation AA-26-0118.pdf" and attachment.get_content() == b"%PDF-1.4 offer"
    assert mime.get_body(("plain",)).get_content().startswith("Dear Mr. Engineer")

    assert source.send_draft(draft_id) == "sent-77"
    assert json.loads(http.requests[2]["body"]) == {"id": "r-draft-1"}
    assert http.requests[2]["uri"].endswith("/drafts/send?alt=json")


def test_large_draft_uses_media_upload():
    big = bytes(range(256)) * (5 * 4096)  # 5 MB attachment -> raw message above the JSON body limit
    source, http = make_source([
        (200, "", {"location": "https://gmail.googleapis.com/upload/session-1"}),
        (200, {"id": "r-big", "message": {"id": "m-big"}}),
    ])
    assert source.create_draft("a.engineer@contractor.example", "Drawings", "See attached.",
                               attachments=[("model.zip", big, "application/zip")]) == "r-big"
    assert "uploadType=resumable" in http.requests[0]["uri"]
    uploaded = email.message_from_bytes(http.requests[1]["body"], policy=email.policy.default)
    [attachment] = list(uploaded.iter_attachments())
    assert attachment.get_content() == big


def test_service_account_constructor():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    info = {"type": "service_account", "project_id": "p", "private_key_id": "k1", "private_key": pem,
            "client_email": "ess@p.iam.gserviceaccount.com", "client_id": "1", "token_uri": "https://oauth2.googleapis.com/token"}
    source = GmailApiSource.from_service_account(info, subject="sales@medmack.com")
    assert source.account == "sales@medmack.com"
    assert source._creds._subject == "sales@medmack.com" and set(source._creds._scopes) == set(SCOPES)


def test_test_and_error_mapping():
    source, _ = make_source([(200, {"emailAddress": "Sales@Medmack.com", "messagesTotal": 120, "threadsTotal": 80})])
    result = source.test()
    assert result == {"ok": True, "account": "sales@medmack.com", "error": None, "messages_total": 120,
                      "threads_total": 80, "token_updated": False}

    unauthorized, _ = make_source([(401, {"error": {"code": 401, "message": "Invalid Credentials"}})])
    with pytest.raises(AuthError, match="Invalid Credentials"):
        unauthorized.get_thread("t1")
    assert unauthorized.test()["ok"] is False

    missing, _ = make_source([(404, {"error": {"code": 404, "message": "Requested entity was not found."}})])
    with pytest.raises(MailSourceError, match="404"):
        missing.get_thread("nope")


def test_token_refresh_is_exposed(monkeypatch):
    from google.oauth2.credentials import Credentials

    def fake_refresh(self, request):
        self.token = "fresh-access-token"
        self.expiry = datetime.utcnow() + timedelta(hours=1)

    monkeypatch.setattr(Credentials, "refresh", fake_refresh)
    saved: list[dict] = []
    expired = {"token": "old", "refresh_token": "1//refresh", "expiry": "2020-01-01T00:00:00Z", "scopes": SCOPES}
    http = RecordingHttp([(200, {"emailAddress": "sales@medmack.com"}, {})])
    service = build("gmail", "v1", http=http, static_discovery=True, cache_discovery=False)
    source = GmailApiSource(expired, CLIENT_CONFIG, service=service, on_token_refresh=saved.append)
    assert source.test()["ok"]
    assert source.token_updated and saved and saved[-1]["token"] == "fresh-access-token"
    assert saved[-1]["refresh_token"] == "1//refresh" and saved[-1]["client_id"] == "cid.apps.googleusercontent.com"


def test_oauth_helpers(monkeypatch):
    url = gmail_auth_url(CLIENT_CONFIG, "http://127.0.0.1:8765/api/connections/gmail/callback", "conn-1")
    query = parse_qs(urlsplit(url).query)
    assert url.startswith("https://accounts.google.com/o/oauth2/auth?")
    assert query["client_id"] == ["cid.apps.googleusercontent.com"] and query["state"] == ["conn-1"]
    assert query["access_type"] == ["offline"] and query["prompt"] == ["consent"]
    assert set(query["scope"][0].split()) == set(SCOPES)
    assert "code_challenge" not in query  # stateless exchange: no PKCE unless a verifier is kept
    pkce = parse_qs(urlsplit(gmail_auth_url(CLIENT_CONFIG, "http://x/cb", "s", code_verifier="v" * 50)).query)
    assert pkce["code_challenge_method"] == ["S256"]

    from google_auth_oauthlib.flow import Flow

    def fake_fetch_token(self, **kwargs):
        assert kwargs["code"] == "auth-code-123"
        self.oauth2session.token = {"access_token": "at-1", "refresh_token": "rt-1", "token_type": "Bearer",
                                    "expires_in": 3599, "expires_at": time.time() + 3599, "scope": SCOPES}
        return self.oauth2session.token

    monkeypatch.setattr(Flow, "fetch_token", fake_fetch_token)
    token = gmail_exchange_code(CLIENT_CONFIG, "http://127.0.0.1:8765/cb", "auth-code-123")
    assert token["token"] == "at-1" and token["refresh_token"] == "rt-1"
    assert token["client_id"] == "cid.apps.googleusercontent.com"
    restored = GmailApiSource(token, CLIENT_CONFIG)
    assert restored.token["refresh_token"] == "rt-1"
