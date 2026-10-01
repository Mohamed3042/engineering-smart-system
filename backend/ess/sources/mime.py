"""MIME helpers shared by the Gmail API and IMAP connectors.

* :func:`build_mime_message` builds a draft (plain text + optional HTML + attachments) with
  reply-threading headers.
* :func:`parse_rfc822` turns raw RFC 822 bytes into a :class:`MailMessage` (encoded headers,
  Arabic charsets, nested multiparts, attachments with stable part ids).
* :func:`get_attachment_payload` returns the bytes of one part by the id ``parse_rfc822`` gave it.
"""
from __future__ import annotations

import email
import email.policy
import mimetypes
import re
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import EmailMessage, Message
from email.utils import formatdate, make_msgid
from typing import Iterable, Iterator, Sequence

from .base import (
    MailAttachment,
    MailMessage,
    default_own_domains,
    html_to_text,
    infer_direction,
    parse_address,
    parse_address_list,
    parse_mail_date,
    pick_headers,
)

__all__ = [
    "build_mime_message",
    "decode_mime_words",
    "get_attachment_payload",
    "iter_leaf_parts",
    "looks_like_message_id",
    "parse_rfc822",
]


def looks_like_message_id(value: str | None) -> bool:
    """RFC 5322 Message-ID (``<abc@host>``) rather than a provider id (Gmail hex, IMAP uid)."""
    return bool(value) and "@" in value and not value.startswith("http")


def _angle(value: str) -> str:
    value = value.strip()
    return value if value.startswith("<") else f"<{value}>"


def _as_list(value: str | Sequence[str] | None) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        return [v.strip() for v in re.split(r"[;,]", value) if v.strip()]
    return [str(v).strip() for v in value if v and str(v).strip()]


def build_mime_message(
    *,
    from_addr: str | None,
    to: str | Sequence[str],
    subject: str,
    body_text: str,
    attachments: Iterable[tuple[str, bytes, str | None]] = (),
    cc: str | Sequence[str] | None = None,
    bcc: str | Sequence[str] | None = None,
    body_html: str | None = None,
    in_reply_to: str | None = None,
    references: str | None = None,
    message_id_domain: str | None = None,
) -> EmailMessage:
    """Build an RFC 5322 message ready for a Gmail ``raw`` draft or an IMAP APPEND."""
    msg = EmailMessage()
    if from_addr:
        msg["From"] = from_addr
    to_list = _as_list(to)
    if not to_list:
        raise ValueError("a draft needs at least one recipient")
    msg["To"] = ", ".join(to_list)
    if cc_list := _as_list(cc):
        msg["Cc"] = ", ".join(cc_list)
    if bcc_list := _as_list(bcc):
        msg["Bcc"] = ", ".join(bcc_list)
    msg["Subject"] = subject or ""
    msg["Date"] = formatdate(localtime=False, usegmt=True)
    domain = message_id_domain or ((from_addr or "").rsplit("@", 1)[-1].strip(" >") if from_addr and "@" in from_addr else None)
    msg["Message-ID"] = make_msgid(idstring="ess", domain=domain or None)
    if in_reply_to:
        parent = _angle(in_reply_to)
        msg["In-Reply-To"] = parent
        refs = (references or "").split()
        if parent not in refs:
            refs.append(parent)
        msg["References"] = " ".join(refs)
    msg.set_content(body_text or "", subtype="plain", charset="utf-8")
    if body_html:
        msg.add_alternative(body_html, subtype="html", charset="utf-8")
    for name, data, mime in attachments or ():
        mime = (mime or mimetypes.guess_type(name)[0] or "application/octet-stream").lower()
        maintype, _, subtype = mime.partition("/")
        # bytes payloads are base64-encoded as-is (also for text/*), so files stay byte-exact
        msg.add_attachment(bytes(data), maintype=maintype or "application",
                           subtype=subtype or "octet-stream", filename=name)
    return msg


def decode_mime_words(value: str | None) -> str:
    """Decode RFC 2047 encoded words (``=?UTF-8?B?...?=``) robustly."""
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def iter_leaf_parts(msg: Message) -> Iterator[tuple[str, Message]]:
    """Leaf MIME parts with a stable id (``"1"``, ``"2.1"``, ...) for attachment download."""

    def walk(part: Message, prefix: str) -> Iterator[tuple[str, Message]]:
        # an attached e-mail (message/rfc822) is one attachment, not part of our body
        if part.is_multipart() and part.get_content_type() != "message/rfc822":
            for idx, sub in enumerate(part.get_payload() or [], start=1):
                yield from walk(sub, f"{prefix}.{idx}" if prefix else str(idx))
        else:
            yield (prefix or "1"), part

    yield from walk(msg, "")


def _part_filename(part: Message) -> str | None:
    name = part.get_filename()
    if name:
        return decode_mime_words(name).strip() or None
    ctype_name = part.get_param("name")
    if isinstance(ctype_name, tuple):  # RFC 2231 tuple
        ctype_name = email.utils.collapse_rfc2231_value(ctype_name)
    return decode_mime_words(str(ctype_name)).strip() if ctype_name else None


def _part_text(part: Message) -> str:
    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    for cs in (charset, "utf-8", "windows-1256", "latin-1"):
        try:
            return payload.decode(cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return payload.decode("utf-8", errors="replace")


def _header_str(msg: Message, name: str) -> str | None:
    try:
        value = msg.get(name)
    except Exception:  # malformed header under the modern policy
        value = None
    if value is None:
        return None
    return decode_mime_words(str(value)) if "=?" in str(value) else str(value)


def _header_all(msg: Message, name: str) -> list[str]:
    try:
        values = msg.get_all(name) or []
    except Exception:
        values = []
    return [decode_mime_words(str(v)) for v in values]


def _load(raw: bytes) -> Message:
    try:
        return email.message_from_bytes(raw, policy=email.policy.default)
    except Exception:  # pragma: no cover - extremely malformed input
        return email.message_from_bytes(raw, policy=email.policy.compat32)


def parse_rfc822(
    raw: bytes,
    *,
    message_id: str,
    thread_id: str,
    account: str | None = None,
    own_domains: Iterable[str] = (),
    labels: Iterable[str] = (),
    view_url: str | None = None,
    fallback_date: datetime | None = None,
) -> MailMessage:
    """Parse raw RFC 822 bytes into a :class:`MailMessage`.

    Attachment ids are MIME part paths from :func:`iter_leaf_parts`, so
    :func:`get_attachment_payload` can find the same part again.
    """
    msg = _load(raw)
    from_name, from_email = parse_address(_header_str(msg, "From"))
    to = parse_address_list(_header_all(msg, "To"))
    cc = parse_address_list(_header_all(msg, "Cc"))
    subject = (_header_str(msg, "Subject") or "").strip()
    subject = re.sub(r"\s+", " ", subject)
    when = parse_mail_date(_header_str(msg, "Date")) or fallback_date
    headers = pick_headers((k, _header_str(msg, k)) for k in msg.keys())
    if when is None:
        when = datetime.now(timezone.utc)
        headers["X-ESS-Date-Estimated"] = "1"

    texts: list[str] = []
    htmls: list[str] = []
    attachments: list[MailAttachment] = []
    for part_id, part in iter_leaf_parts(msg):
        ctype = (part.get_content_type() or "application/octet-stream").lower()
        disposition = (part.get_content_disposition() or "").lower()
        filename = _part_filename(part)
        content_id = (part.get("Content-ID") or "").strip().strip("<>") or None
        is_attachment = bool(filename) or disposition == "attachment" or not ctype.startswith(("text/plain", "text/html"))
        if ctype in ("text/plain", "text/html") and not filename and disposition != "attachment":
            is_attachment = False
        if is_attachment:
            if not filename:
                ext = mimetypes.guess_extension(ctype) or ".bin"
                filename = f"attachment-{part_id}{ext}"
            payload = part.get_payload(decode=True)
            if ctype == "message/rfc822" and payload is None:
                inner = part.get_payload()
                payload = inner[0].as_bytes() if isinstance(inner, list) and inner else b""
            attachments.append(
                MailAttachment(
                    attachment_id=part_id,
                    filename=filename,
                    mime=ctype,
                    size=len(payload or b""),
                    content_id=content_id,
                    inline=disposition == "inline" or (bool(content_id) and disposition != "attachment"),
                )
            )
        elif ctype == "text/plain":
            texts.append(_part_text(part))
        else:
            htmls.append(_part_text(part))

    texts = [t.replace("\r\n", "\n").replace("\r", "\n") for t in texts]
    body_text = "\n\n".join(t.strip("\n") for t in texts if t and t.strip())
    body_html = "\n".join(htmls) if htmls else None
    if not body_text and body_html:
        body_text = html_to_text(body_html)
    labels = list(labels)
    domains = default_own_domains(account, own_domains)
    return MailMessage(
        id=message_id,
        thread_id=thread_id,
        account=account,
        direction=infer_direction(from_email, account, domains, labels),
        from_name=from_name,
        from_email=from_email,
        to=to,
        cc=cc,
        subject=subject,
        date=when,
        body_text=body_text.replace("\r\n", "\n"),
        body_html=body_html,
        labels=labels,
        attachments=attachments,
        list_unsubscribe=headers.get("List-Unsubscribe"),
        list_unsubscribe_post=headers.get("List-Unsubscribe-Post"),
        headers=headers,
        view_url=view_url,
    )


def get_attachment_payload(raw: bytes, attachment_id: str) -> bytes:
    """Bytes of the part ``attachment_id`` (a part path from :func:`parse_rfc822`)."""
    msg = _load(raw)
    for part_id, part in iter_leaf_parts(msg):
        if part_id == attachment_id:
            payload = part.get_payload(decode=True)
            if payload is None and part.get_content_type() == "message/rfc822":
                inner = part.get_payload()
                payload = inner[0].as_bytes() if isinstance(inner, list) and inner else b""
            return payload or b""
    raise KeyError(f"attachment part {attachment_id!r} not found")
