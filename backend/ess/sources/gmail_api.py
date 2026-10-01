"""Gmail API connector (google-api-python-client).

OAuth scopes are ``gmail.readonly`` + ``gmail.compose``: the app reads mail and stages drafts;
a draft is only sent through :meth:`GmailApiSource.send_draft`, which the approval flow calls
after an engineer approved it.

Typical OAuth round trip (the API layer stores ``token`` encrypted under ``data/``)::

    url = gmail_auth_url(client_config, redirect_uri, state)
    token = gmail_exchange_code(client_config, redirect_uri, code)
    source = GmailApiSource(token, client_config, on_token_refresh=save_token)

Google Workspace admins can use a service account with domain-wide delegation instead:
``GmailApiSource.from_service_account(info, subject="sales@company.com")``.
"""
from __future__ import annotations

import base64
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence
from urllib.parse import quote

from .base import (
    AuthError,
    MailAttachment,
    MailMessage,
    MailSourceError,
    build_gmail_query,
    default_own_domains,
    html_to_text,
    infer_direction,
    parse_address,
    parse_address_list,
    parse_mail_date,
    pick_headers,
)
from .mime import build_mime_message, decode_mime_words, looks_like_message_id

__all__ = [
    "GmailApiSource",
    "SCOPES",
    "gmail_auth_url",
    "gmail_exchange_code",
    "parse_gmail_message",
]

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
]
TOKEN_URI = "https://oauth2.googleapis.com/token"
_RAW_UPLOAD_LIMIT = 4 * 1024 * 1024  # bigger drafts go through the media-upload endpoint


# --------------------------------------------------------------------------- OAuth helpers
def _client_section(client_config: dict | None) -> dict:
    """``{"installed": {...}}`` / ``{"web": {...}}`` / flat dict -> the inner client dict."""
    if not client_config:
        return {}
    for key in ("installed", "web"):
        if isinstance(client_config.get(key), dict):
            return client_config[key]
    return client_config


def _normalise_client_config(client_config: dict) -> dict:
    if "installed" in client_config or "web" in client_config:
        return client_config
    inner = dict(client_config)
    inner.setdefault("auth_uri", "https://accounts.google.com/o/oauth2/auth")
    inner.setdefault("token_uri", TOKEN_URI)
    return {"installed": inner}


def _flow(client_config: dict, redirect_uri: str, code_verifier: str | None):
    from google_auth_oauthlib.flow import Flow

    return Flow.from_client_config(
        _normalise_client_config(client_config),
        scopes=SCOPES,
        redirect_uri=redirect_uri,
        code_verifier=code_verifier,
        # PKCE only when the caller keeps the verifier between the two calls; otherwise the
        # exchange (a separate request, separate Flow) would fail with "missing code verifier".
        autogenerate_code_verifier=False,
    )


def gmail_auth_url(
    client_config: dict,
    redirect_uri: str,
    state: str,
    *,
    code_verifier: str | None = None,
    login_hint: str | None = None,
) -> str:
    """Google consent-screen URL (offline access so we receive a refresh token)."""
    flow = _flow(client_config, redirect_uri, code_verifier)
    kwargs: dict[str, Any] = {
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent",
        "state": state,
    }
    if login_hint:
        kwargs["login_hint"] = login_hint
    url, _state = flow.authorization_url(**kwargs)
    return url


def gmail_exchange_code(
    client_config: dict,
    redirect_uri: str,
    code: str,
    *,
    code_verifier: str | None = None,
) -> dict:
    """Exchange the authorization ``code`` for a token dict (``Credentials.to_json`` format)."""
    # Google may return previously granted scopes too; don't treat that as an error.
    os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
    flow = _flow(client_config, redirect_uri, code_verifier)
    flow.fetch_token(code=code)
    creds = flow.credentials
    token = json.loads(creds.to_json())
    if not token.get("refresh_token"):
        token["warning"] = "no refresh_token returned; revoke the app's access and connect again"
    return token


# --------------------------------------------------------------------------- payload parsing
class _Headers:
    """Case-insensitive view over Gmail's ``[{name, value}]`` header list."""

    def __init__(self, items: Iterable[dict] | None):
        self.items = [(str(h.get("name", "")), str(h.get("value", ""))) for h in items or []]

    def get(self, name: str) -> str | None:
        low = name.lower()
        for key, value in self.items:
            if key.lower() == low:
                return value
        return None

    def get_all(self, name: str) -> list[str]:
        low = name.lower()
        return [v for k, v in self.items if k.lower() == low]


def _b64url_decode(data: str) -> bytes:
    data = data.strip()
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _charset(content_type: str | None) -> str:
    match = re.search(r'charset\s*=\s*"?([^";\s]+)', content_type or "", re.I)
    return match.group(1) if match else "utf-8"


def _decode_text(data: bytes, content_type: str | None) -> str:
    for cs in (_charset(content_type), "utf-8", "windows-1256", "latin-1"):
        try:
            return data.decode(cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")


def _walk_payload(
    part: dict,
    texts: list[str],
    htmls: list[str],
    attachments: list[MailAttachment],
    fetch_body: Callable[[str], bytes] | None,
) -> None:
    mime = (part.get("mimeType") or "").lower()
    filename = part.get("filename") or ""
    body = part.get("body") or {}
    headers = _Headers(part.get("headers"))
    disposition = (headers.get("Content-Disposition") or "").lower()
    content_id = (headers.get("Content-ID") or headers.get("X-Attachment-Id") or "").strip().strip("<>") or None

    if mime.startswith("multipart/") and part.get("parts"):
        for sub in part["parts"]:
            _walk_payload(sub, texts, htmls, attachments, fetch_body)
        return

    is_attachment = bool(filename) or disposition.startswith("attachment") or (
        bool(body.get("attachmentId")) and mime not in ("text/plain", "text/html")
    )
    if mime in ("text/plain", "text/html") and not filename and not disposition.startswith("attachment"):
        is_attachment = False
    if is_attachment:
        if not filename:
            ext = {"message/rfc822": ".eml", "application/pdf": ".pdf"}.get(mime, "")
            filename = f"attachment-{part.get('partId') or len(attachments) + 1}{ext}"
        attachments.append(
            MailAttachment(
                attachment_id=body.get("attachmentId"),
                filename=filename,
                mime=mime or "application/octet-stream",
                size=int(body.get("size") or 0),
                content_id=content_id,
                inline=disposition.startswith("inline") or (bool(content_id) and not disposition.startswith("attachment")),
            )
        )
        return
    if mime not in ("text/plain", "text/html"):
        return
    raw: bytes | None = None
    if body.get("data"):
        raw = _b64url_decode(body["data"])
    elif body.get("attachmentId") and fetch_body is not None:  # very large bodies
        raw = fetch_body(body["attachmentId"])
    if raw is None:
        return
    text = _decode_text(raw, headers.get("Content-Type"))
    (texts if mime == "text/plain" else htmls).append(text)


def gmail_view_url(message_id: str, account: str | None = None) -> str:
    who = f"?authuser={quote(account)}" if account else ""
    return f"https://mail.google.com/mail/{who}#all/{message_id}"


def parse_gmail_message(
    data: dict,
    *,
    account: str | None = None,
    own_domains: Iterable[str] = (),
    fetch_body: Callable[[str], bytes] | None = None,
) -> MailMessage:
    """Map a Gmail API ``Message`` resource (``format=full``) to :class:`MailMessage`."""
    payload = data.get("payload") or {}
    hdr = _Headers(payload.get("headers"))
    from_name, from_email = parse_address(hdr.get("From"))
    when: datetime | None = None
    if data.get("internalDate"):
        when = datetime.fromtimestamp(int(data["internalDate"]) / 1000.0, tz=timezone.utc)
    if when is None:
        when = parse_mail_date(hdr.get("Date")) or datetime.now(timezone.utc)

    texts: list[str] = []
    htmls: list[str] = []
    attachments: list[MailAttachment] = []
    _walk_payload(payload, texts, htmls, attachments, fetch_body)
    texts = [t.replace("\r\n", "\n").replace("\r", "\n") for t in texts]
    body_text = "\n\n".join(t.strip("\n") for t in texts if t.strip())
    body_html = "\n".join(htmls) if htmls else None
    if not body_text and body_html:
        body_text = html_to_text(body_html)

    labels = list(data.get("labelIds") or [])
    headers = pick_headers(hdr.items)
    message_id = str(data.get("id") or "")
    snippet = data.get("snippet") or ""
    return MailMessage(
        id=message_id,
        thread_id=str(data.get("threadId") or message_id),
        account=account,
        direction=infer_direction(from_email, account, default_own_domains(account, own_domains), labels),
        from_name=from_name,
        from_email=from_email,
        to=parse_address_list(hdr.get_all("To")),
        cc=parse_address_list(hdr.get_all("Cc")),
        subject=re.sub(r"\s+", " ", decode_mime_words(hdr.get("Subject") or "")).strip(),
        date=when,
        snippet=_unescape(snippet),
        body_text=body_text,
        body_html=body_html,
        labels=labels,
        attachments=attachments,
        list_unsubscribe=headers.get("List-Unsubscribe"),
        list_unsubscribe_post=headers.get("List-Unsubscribe-Post"),
        headers=headers,
        view_url=gmail_view_url(message_id, account),
    )


def _unescape(snippet: str) -> str:
    import html

    return html.unescape(snippet)


# --------------------------------------------------------------------------- the source
class GmailApiSource:
    """:class:`~ess.sources.base.MailSource` over the Gmail REST API."""

    kind = "gmail_api"

    def __init__(
        self,
        token: dict | None = None,
        client_config: dict | None = None,
        account: str | None = None,
        *,
        own_domains: Sequence[str] = (),
        credentials: Any = None,
        service: Any = None,
        on_token_refresh: Callable[[dict], None] | None = None,
        user_id: str = "me",
        num_retries: int = 2,
    ) -> None:
        self.account = account.lower() if account else None
        self._own_domains = tuple(own_domains)
        self.user_id = user_id
        self.num_retries = num_retries
        self.on_token_refresh = on_token_refresh
        self._service = service
        self._creds = credentials
        self._token_updated = False
        if self._creds is None and token:
            self._creds = self._credentials_from_token(token, client_config)
        if self._creds is None and service is None:
            raise ValueError("GmailApiSource needs a token dict, credentials or a service")
        self._last_token = getattr(self._creds, "token", None)

    # ---- construction helpers
    @staticmethod
    def _credentials_from_token(token: dict, client_config: dict | None):
        from google.oauth2.credentials import Credentials

        info = dict(token)
        if "token" not in info and "access_token" in info:
            info["token"] = info["access_token"]
        client = _client_section(client_config)
        for key in ("client_id", "client_secret"):
            if not info.get(key) and client.get(key):
                info[key] = client[key]
        info.setdefault("token_uri", client.get("token_uri") or TOKEN_URI)
        scopes = info.get("scopes") or SCOPES
        if isinstance(scopes, str):
            scopes = scopes.split()
        if info.get("refresh_token"):
            info.pop("warning", None)
            return Credentials.from_authorized_user_info(info, scopes=scopes)
        expiry = parse_mail_date(info.get("expiry"))
        return Credentials(
            token=info.get("token"),
            token_uri=info.get("token_uri"),
            client_id=info.get("client_id"),
            client_secret=info.get("client_secret"),
            scopes=scopes,
            expiry=expiry.astimezone(timezone.utc).replace(tzinfo=None) if expiry else None,  # google-auth: naive UTC
        )

    @classmethod
    def from_service_account(
        cls,
        info: dict | str | Path,
        subject: str,
        *,
        own_domains: Sequence[str] = (),
        scopes: Sequence[str] = SCOPES,
    ) -> "GmailApiSource":
        """Google Workspace: service account with domain-wide delegation impersonating ``subject``."""
        from google.oauth2 import service_account

        if isinstance(info, (str, Path)) and Path(str(info)).exists():
            info = json.loads(Path(str(info)).read_text(encoding="utf-8"))
        elif isinstance(info, str):
            info = json.loads(info)
        creds = service_account.Credentials.from_service_account_info(info, scopes=list(scopes), subject=subject)
        return cls(credentials=creds, account=subject, own_domains=own_domains)

    # ---- token persistence
    @property
    def token(self) -> dict | None:
        """Current token dict (persist it when :attr:`token_updated` is true)."""
        creds = self._creds
        if creds is None or not hasattr(creds, "to_json"):
            return None
        try:
            return json.loads(creds.to_json())
        except Exception:
            return None

    @property
    def token_updated(self) -> bool:
        return self._token_updated

    def _check_token_change(self) -> None:
        current = getattr(self._creds, "token", None)
        if current and current != self._last_token:
            self._last_token = current
            self._token_updated = True
            if self.on_token_refresh is not None and self.token is not None:
                try:
                    self.on_token_refresh(self.token)
                except Exception:  # persistence problems must not break mail reading
                    pass

    def _ensure_fresh(self) -> None:
        creds = self._creds
        if creds is None or getattr(creds, "valid", True):
            return
        if not getattr(creds, "refresh_token", None) and not hasattr(creds, "signer"):
            return
        from google.auth.exceptions import RefreshError
        from google.auth.transport.requests import Request

        try:
            creds.refresh(Request())
        except RefreshError as exc:
            raise AuthError(f"Gmail authorization expired or was revoked: {exc}") from exc
        self._check_token_change()

    # ---- API plumbing
    def _svc(self):
        if self._service is None:
            from googleapiclient.discovery import build

            self._ensure_fresh()
            self._service = build("gmail", "v1", credentials=self._creds, cache_discovery=False, static_discovery=True)
        return self._service

    def _users(self):
        return self._svc().users()

    def _exec(self, request) -> dict:
        from googleapiclient.errors import HttpError

        try:
            from google.auth.exceptions import RefreshError
        except Exception:  # pragma: no cover
            RefreshError = ()  # type: ignore
        try:
            self._ensure_fresh()
            result = request.execute(num_retries=self.num_retries)
        except HttpError as exc:
            status = getattr(getattr(exc, "resp", None), "status", None)
            reason = _http_error_reason(exc)
            if status == 401 or (status == 403 and "insufficient" in reason.lower()):
                raise AuthError(f"Gmail rejected the credentials ({status}): {reason}") from exc
            raise MailSourceError(f"Gmail API error {status}: {reason}") from exc
        except RefreshError as exc:  # type: ignore[misc]
            raise AuthError(f"Gmail authorization expired or was revoked: {exc}") from exc
        finally:
            self._check_token_change()
        return result or {}

    # ---- MailSource API
    def search(self, query: str, after=None, before=None, max_results: int = 500, *, include_spam_trash: bool = False) -> list[str]:
        q = build_gmail_query(query, after, before)
        ids: list[str] = []
        seen: set[str] = set()
        page_token: str | None = None
        while len(ids) < max_results:
            kwargs: dict[str, Any] = {
                "userId": self.user_id,
                "maxResults": max(1, min(500, max_results - len(ids))),
                "includeSpamTrash": include_spam_trash,
            }
            if q:
                kwargs["q"] = q
            if page_token:
                kwargs["pageToken"] = page_token
            resp = self._exec(self._users().threads().list(**kwargs))
            for item in resp.get("threads") or []:
                tid = item.get("id")
                if tid and tid not in seen:
                    seen.add(tid)
                    ids.append(tid)
            page_token = resp.get("nextPageToken")
            if not page_token or not resp.get("threads"):
                break
        return ids[:max_results]

    def get_thread(self, thread_id: str) -> list[MailMessage]:
        data = self._exec(self._users().threads().get(userId=self.user_id, id=thread_id, format="full"))
        messages = []
        for raw in data.get("messages") or []:
            mid = raw.get("id")
            messages.append(
                parse_gmail_message(
                    raw,
                    account=self.account,
                    own_domains=self._own_domains,
                    fetch_body=(lambda aid, _mid=mid: self.download_attachment(_mid, aid)),
                )
            )
        messages.sort(key=lambda m: m.date)
        return messages

    def get_message(self, message_id: str) -> MailMessage:
        raw = self._exec(self._users().messages().get(userId=self.user_id, id=message_id, format="full"))
        return parse_gmail_message(
            raw,
            account=self.account,
            own_domains=self._own_domains,
            fetch_body=lambda aid: self.download_attachment(message_id, aid),
        )

    def download_attachment(self, message_id: str, attachment_id: str) -> bytes:
        if not attachment_id:
            raise MailSourceError("this attachment has no attachment id")
        data = self._exec(
            self._users().messages().attachments().get(userId=self.user_id, messageId=message_id, id=attachment_id)
        )
        if "data" not in data:
            raise MailSourceError(f"attachment {attachment_id} of message {message_id} returned no data")
        return _b64url_decode(data["data"])

    def create_draft(
        self,
        to: str | Sequence[str],
        subject: str,
        body_text: str,
        attachments: Sequence[tuple[str, bytes, str]] = (),
        in_reply_to: str | None = None,
        thread_id: str | None = None,
        *,
        cc: str | Sequence[str] | None = None,
        bcc: str | Sequence[str] | None = None,
        body_html: str | None = None,
    ) -> str:
        """Stage a draft. ``in_reply_to`` may be a Gmail message id or an RFC Message-ID."""
        parent_msgid: str | None = None
        references: str | None = None
        if in_reply_to:
            if looks_like_message_id(in_reply_to):
                parent_msgid = in_reply_to
            else:
                meta = self._exec(
                    self._users().messages().get(
                        userId=self.user_id,
                        id=in_reply_to,
                        format="metadata",
                        metadataHeaders=["Message-ID", "References", "Subject"],
                    )
                )
                hdr = _Headers((meta.get("payload") or {}).get("headers"))
                parent_msgid = hdr.get("Message-ID") or hdr.get("Message-Id")
                references = hdr.get("References")
                thread_id = thread_id or meta.get("threadId")
        msg = build_mime_message(
            from_addr=self.account,
            to=to,
            cc=cc,
            bcc=bcc,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            attachments=attachments,
            in_reply_to=parent_msgid,
            references=references,
        )
        raw_bytes = msg.as_bytes()
        message: dict[str, Any] = {}
        if thread_id:
            message["threadId"] = thread_id
        drafts = self._users().drafts()
        if len(raw_bytes) > _RAW_UPLOAD_LIMIT:
            import io

            from googleapiclient.http import MediaIoBaseUpload

            media = MediaIoBaseUpload(io.BytesIO(raw_bytes), mimetype="message/rfc822", resumable=True)
            resp = self._exec(drafts.create(userId=self.user_id, body={"message": message}, media_body=media))
        else:
            message["raw"] = base64.urlsafe_b64encode(raw_bytes).decode("ascii")
            resp = self._exec(drafts.create(userId=self.user_id, body={"message": message}))
        draft_id = resp.get("id")
        if not draft_id:
            raise MailSourceError("Gmail did not return a draft id")
        return str(draft_id)

    def send_draft(self, draft_id: str) -> str:
        """Send an approved draft; returns the sent Gmail message id."""
        resp = self._exec(self._users().drafts().send(userId=self.user_id, body={"id": draft_id}))
        return str(resp.get("id") or "")

    def test(self) -> dict[str, Any]:
        try:
            profile = self._exec(self._users().getProfile(userId=self.user_id))
        except Exception as exc:  # report, never raise, from a connection test
            return {"ok": False, "account": self.account, "error": str(exc)}
        email = (profile.get("emailAddress") or "").lower() or None
        if email and not self.account:
            self.account = email
        return {
            "ok": True,
            "account": email or self.account,
            "error": None,
            "messages_total": profile.get("messagesTotal"),
            "threads_total": profile.get("threadsTotal"),
            "token_updated": self._token_updated,
        }


def _http_error_reason(exc: Exception) -> str:
    try:
        content = getattr(exc, "content", b"") or b""
        data = json.loads(content.decode("utf-8", errors="replace"))
        return str(data.get("error", {}).get("message") or data)
    except Exception:
        return str(exc)
