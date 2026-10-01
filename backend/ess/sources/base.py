"""Mail-source contracts shared by every connector (Gmail API, IMAP, MCP).

Everything here is provider-neutral: the pydantic models the pipeline stores, the
``MailSource`` protocol the rest of the app codes against, and text helpers that every
connector reuses (HTML -> text, quoted-history splitting, address and date parsing).

Sending is never automatic: ``create_draft`` only stages a draft and ``send_draft`` is
called by the approval flow after an engineer approved it (see docs/architecture.md).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from email.utils import getaddresses, parseaddr, parsedate_to_datetime
from typing import Any, Iterable, Literal, Protocol, Sequence, runtime_checkable

from pydantic import BaseModel, Field, field_validator, model_validator

__all__ = [
    "AuthError",
    "Direction",
    "HEADER_SUBSET",
    "MailAttachment",
    "MailMessage",
    "MailSource",
    "MailSourceError",
    "NotSupported",
    "PUBLIC_MAIL_DOMAINS",
    "QuotedBlock",
    "QuotedSplit",
    "build_gmail_query",
    "coerce_date",
    "default_own_domains",
    "email_domain",
    "html_to_text",
    "infer_direction",
    "make_snippet",
    "parse_address",
    "parse_address_list",
    "parse_mail_date",
    "pick_headers",
    "split_quoted_history",
    "to_utc",
]


# --------------------------------------------------------------------------- errors
class MailSourceError(RuntimeError):
    """A mail provider call failed (network, quota, malformed data, missing item)."""


class AuthError(MailSourceError):
    """Credentials were rejected, revoked or expired: the user has to reconnect the mailbox."""


class NotSupported(MailSourceError):
    """The connected source cannot do this (e.g. an MCP server without an attachment tool)."""


# --------------------------------------------------------------------------- models
Direction = Literal["inbound", "outbound"]

#: Headers worth keeping on every message (threading, bulk-mail detection, replies).
HEADER_SUBSET: tuple[str, ...] = (
    "Message-ID",
    "In-Reply-To",
    "References",
    "Reply-To",
    "Return-Path",
    "Delivered-To",
    "List-Id",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "Precedence",
    "Auto-Submitted",
    "X-Auto-Response-Suppress",
    "X-Mailer",
    "Content-Language",
    "Thread-Topic",
    "Thread-Index",
)
_HEADER_CANON = {h.lower(): h for h in HEADER_SUBSET}


class MailAttachment(BaseModel):
    """Attachment metadata. Bytes are fetched on demand with ``download_attachment``."""

    attachment_id: str | None = None  # None when the provider exposes no id (download impossible)
    filename: str
    mime: str = "application/octet-stream"
    size: int = 0
    content_id: str | None = None  # without angle brackets
    inline: bool = False  # inline image (signature logo, pasted screenshot)


class MailMessage(BaseModel):
    """One message, normalised across providers."""

    id: str  # provider message id (Gmail hex id, IMAP "uid:uidvalidity:folder", ...)
    thread_id: str
    account: str | None = None  # mailbox the message was read from
    direction: Direction = "inbound"
    from_name: str | None = None
    from_email: str | None = None
    to: list[str] = Field(default_factory=list)  # plain lower-case addresses
    cc: list[str] = Field(default_factory=list)
    subject: str = ""
    date: datetime  # always timezone-aware (UTC when the source gave no offset)
    snippet: str = ""
    body_text: str = ""  # full plain-text body, quoted history included
    body_html: str | None = None
    labels: list[str] = Field(default_factory=list)
    attachments: list[MailAttachment] = Field(default_factory=list)
    list_unsubscribe: str | None = None
    list_unsubscribe_post: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)  # subset, see HEADER_SUBSET
    view_url: str | None = None

    @field_validator("date")
    @classmethod
    def _tz_aware(cls, value: datetime) -> datetime:
        return to_utc(value) if value.tzinfo is None else value

    @model_validator(mode="after")
    def _fill_snippet(self) -> "MailMessage":
        if not self.snippet and self.body_text:
            self.snippet = make_snippet(self.body_text)
        return self

    @property
    def message_id_header(self) -> str | None:
        """RFC 5322 ``Message-ID`` (with angle brackets) when the source exposed it."""
        return self.headers.get("Message-ID")

    @property
    def sender_domain(self) -> str | None:
        return email_domain(self.from_email)

    def split_body(self) -> "QuotedSplit":
        """New text of this message vs. the quoted history below it."""
        return split_quoted_history(self.body_text)


@runtime_checkable
class MailSource(Protocol):
    """What the pipeline needs from a mailbox. Implemented by GmailApiSource, ImapSource and
    McpMailSource. Methods a source cannot provide raise :class:`NotSupported`."""

    account: str | None

    def search(
        self,
        query: str,
        after: date | datetime | str | None = None,
        before: date | datetime | str | None = None,
        max_results: int = 500,
    ) -> list[str]:
        """Thread ids matching ``query`` (newest first where the provider allows)."""
        ...

    def get_thread(self, thread_id: str) -> list[MailMessage]:
        """All messages of a thread, oldest first."""
        ...

    def download_attachment(self, message_id: str, attachment_id: str) -> bytes: ...

    def create_draft(
        self,
        to: str | Sequence[str],
        subject: str,
        body_text: str,
        attachments: Sequence[tuple[str, bytes, str]] = (),
        in_reply_to: str | None = None,
        thread_id: str | None = None,
    ) -> str:
        """Stage a draft in the mailbox and return its draft id. Never sends."""
        ...

    def send_draft(self, draft_id: str) -> str:
        """Send a staged draft. Only the approval flow may call this. Returns the sent id."""
        ...

    def test(self) -> dict[str, Any]:
        """Connection check: ``{"ok": bool, "account": str | None, "error": str | None, ...}``."""
        ...


# --------------------------------------------------------------------------- addresses
PUBLIC_MAIL_DOMAINS = frozenset(
    {
        "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
        "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
        "protonmail.com", "gmx.com", "gmx.net", "gmx.de", "mail.com", "zoho.com", "yandex.com",
        "yandex.ru", "mail.ru", "qq.com", "163.com", "rediffmail.com", "hotmail.co.uk",
        "outlook.sa", "hotmail.fr", "yahoo.co.uk", "yahoo.fr",
    }
)

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+'=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def _clean_name(name: str | None) -> str | None:
    if not name:
        return None
    name = name.strip().strip('"').strip("'").strip()
    return name or None


def parse_address(value: str | None) -> tuple[str | None, str | None]:
    """``'A. Engineer <a.engineer@contractor.example>'`` -> ``('A. Engineer', 'a.engineer@contractor.example')``."""
    if not value:
        return None, None
    name, addr = parseaddr(str(value))
    addr = (addr or "").strip()
    if "@" not in addr:
        found = _EMAIL_RE.search(str(value))
        addr = found.group(0) if found else ""
    email = addr.lower() or None
    if name and "=?" in name:  # RFC 2047 encoded display name, e.g. Arabic names
        try:
            from email.header import decode_header, make_header

            name = str(make_header(decode_header(name)))
        except Exception:
            pass
    name = _clean_name(name)
    if name and email and name.lower() == email:
        name = None
    return name, email


def parse_address_list(values: str | Iterable[str] | None) -> list[str]:
    """Lower-cased addresses from header values or lists of ``Name <a@b>`` strings."""
    if not values:
        return []
    items = [values] if isinstance(values, str) else [str(v) for v in values if v]
    out: list[str] = []
    for _name, addr in getaddresses(items):
        addr = (addr or "").strip().lower()
        if "@" not in addr:
            continue
        if addr not in out:
            out.append(addr)
    if not out:  # tolerate exotic formatting: fall back to a plain regex scan
        for item in items:
            for match in _EMAIL_RE.findall(item):
                if match.lower() not in out:
                    out.append(match.lower())
    return out


def email_domain(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    return email.rsplit("@", 1)[1].strip().lower().rstrip(">") or None


def default_own_domains(account: str | None, own_domains: Iterable[str] = ()) -> tuple[str, ...]:
    """Own domains for direction detection: the given ones, else the account's company domain
    (never a public webmail domain, which would make every Gmail sender 'outbound')."""
    domains = [d.strip().lower().lstrip("@") for d in own_domains if d and d.strip()]
    if not domains:
        dom = email_domain(account)
        if dom and dom not in PUBLIC_MAIL_DOMAINS:
            domains.append(dom)
    return tuple(dict.fromkeys(domains))


def infer_direction(
    from_email: str | None,
    account: str | None = None,
    own_domains: Iterable[str] = (),
    labels: Iterable[str] = (),
) -> Direction:
    """``outbound`` when the mailbox (or a colleague on an own domain) sent it."""
    if "SENT" in {str(label).upper() for label in labels or ()}:
        return "outbound"
    sender = (from_email or "").lower()
    if not sender:
        return "inbound"
    if account and sender == account.lower():
        return "outbound"
    dom = email_domain(sender)
    if dom and dom in {d.lower() for d in own_domains}:
        return "outbound"
    return "inbound"


def pick_headers(pairs: Iterable[tuple[str, Any]]) -> dict[str, str]:
    """Keep the :data:`HEADER_SUBSET` headers (first occurrence wins) with canonical names."""
    out: dict[str, str] = {}
    for name, value in pairs:
        canon = _HEADER_CANON.get(str(name).strip().lower())
        if canon and canon not in out and value is not None:
            out[canon] = re.sub(r"\s+", " ", str(value)).strip()
    return out


# --------------------------------------------------------------------------- dates
def to_utc(value: datetime) -> datetime:
    """Naive datetimes are taken as UTC; aware ones are converted to UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def parse_mail_date(value: Any) -> datetime | None:
    """RFC 2822 header date, ISO-8601 string or epoch seconds/milliseconds -> aware datetime."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    if isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r"\d{9,14}", value.strip())):
        num = float(value)
        if num > 1e11:  # milliseconds
            num /= 1000.0
        return datetime.fromtimestamp(num, tz=timezone.utc)
    text = str(value).strip()
    try:
        iso = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
        parsed = datetime.fromisoformat(iso)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        parsed = None
    if parsed is not None:
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    try:  # last resort, e.g. "26 Aug 2026 08:20"
        from dateutil import parser as du_parser

        parsed = du_parser.parse(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def coerce_date(value: date | datetime | str | None) -> date | datetime | None:
    """Search bounds: keep datetimes (exact), turn ISO strings into date/datetime."""
    if value is None or value == "":
        return None
    if isinstance(value, (date, datetime)):
        return value
    text = str(value).strip().replace("/", "-")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return date.fromisoformat(text)
    parsed = parse_mail_date(text)
    if parsed is None:
        raise ValueError(f"unrecognised date: {value!r}")
    return parsed


def _gmail_date_term(value: date | datetime) -> str:
    if isinstance(value, datetime):
        return str(int(to_utc(value).timestamp()))  # exact instant, Gmail accepts epoch seconds
    return value.strftime("%Y/%m/%d")


def build_gmail_query(
    query: str | None,
    after: date | datetime | str | None = None,
    before: date | datetime | str | None = None,
) -> str:
    """Gmail search syntax with ``after:``/``before:`` bounds (Gmail API and Gmail MCP)."""
    parts = [query.strip()] if query and query.strip() else []
    lo, hi = coerce_date(after), coerce_date(before)
    if lo is not None:
        parts.append(f"after:{_gmail_date_term(lo)}")
    if hi is not None:
        parts.append(f"before:{_gmail_date_term(hi)}")
    return " ".join(parts)


def make_snippet(text: str, length: int = 200) -> str:
    flat = re.sub(r"\s+", " ", text or "").strip()
    return flat if len(flat) <= length else flat[: length - 1].rstrip() + "…"


# --------------------------------------------------------------------------- HTML -> text
_BLOCK_TAGS = (
    "p", "div", "section", "article", "header", "footer", "pre", "h1", "h2", "h3", "h4", "h5",
    "h6", "ul", "ol", "table", "address", "center", "dl", "dt", "dd", "form", "fieldset",
    "figure", "figcaption", "main", "nav", "aside",
)
_Q_OPEN = "\x00QO\x00"
_Q_CLOSE = "\x00QC\x00"


def _norm_url_for_compare(url: str) -> str:
    return re.sub(r"^(https?://)?(www\.)?", "", url.strip().lower()).rstrip("/")


def html_to_text(html: str | None) -> str:
    """Readable plain text from an HTML mail body.

    Links become ``text (url)``, ``<br>``/blocks become line breaks, table cells are
    separated with `` | ``, ``<blockquote>`` content is prefixed with ``> `` (so
    :func:`split_quoted_history` can find it), scripts/styles/hidden preheaders are dropped.
    """
    if not html or not html.strip():
        return ""
    from bs4 import BeautifulSoup, Comment, NavigableString

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:  # lxml missing or choked: the stdlib parser is always there
        soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "head", "title", "meta", "noscript", "template", "svg", "object"]):
        tag.decompose()
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()
    for tag in soup.find_all(style=re.compile(r"display\s*:\s*none|mso-hide\s*:\s*all", re.I)):
        tag.decompose()

    for a in soup.find_all("a"):
        href = (a.get("href") or "").strip()
        text = a.get_text(" ", strip=True)
        if not text:
            img = a.find("img")
            text = (img.get("alt") or "").strip() if img else ""
        low = href.lower()
        if low.startswith(("http://", "https://")):
            if not text or _norm_url_for_compare(text) == _norm_url_for_compare(href):
                repl = href
            else:
                repl = f"{text} ({href})"
        elif low.startswith("mailto:"):
            addr = href[7:].split("?", 1)[0]
            repl = text if (text and addr.lower() in text.lower()) else (f"{text} ({addr})" if text else addr)
        else:
            repl = text
        a.replace_with(NavigableString(repl))

    for img in soup.find_all("img"):
        alt = (img.get("alt") or "").strip()
        img.replace_with(NavigableString(f"[{alt}]" if alt and len(alt) < 80 else ""))
    for br in soup.find_all("br"):
        br.replace_with(NavigableString("\n"))
    for hr in soup.find_all("hr"):
        hr.replace_with(NavigableString("\n\n"))
    for cell in soup.find_all(["td", "th"]):
        cell.insert_after(NavigableString("\t"))
    for row in soup.find_all("tr"):
        row.insert_after(NavigableString("\n"))
    for li in soup.find_all("li"):
        li.insert_before(NavigableString("\n- "))
        li.insert_after(NavigableString("\n"))
    for bq in soup.find_all("blockquote"):
        bq.insert_before(NavigableString(f"\n{_Q_OPEN}\n"))
        bq.insert_after(NavigableString(f"\n{_Q_CLOSE}\n"))
    for tag in soup.find_all(_BLOCK_TAGS):
        tag.insert_before(NavigableString("\n"))
        tag.insert_after(NavigableString("\n"))

    raw = soup.get_text()
    raw = raw.replace("\xa0", " ").replace("​", "").replace("\r", "")
    lines: list[str] = []
    depth = 0
    for line in raw.split("\n"):
        if _Q_OPEN in line or _Q_CLOSE in line:
            depth += line.count(_Q_OPEN) - line.count(_Q_CLOSE)
            depth = max(depth, 0)
            line = line.replace(_Q_OPEN, "").replace(_Q_CLOSE, "")
            if not line.strip():
                continue
        if "\t" in line:
            cells = [re.sub(r"[ \f\v]+", " ", c).strip() for c in line.split("\t")]
            line = " | ".join(c for c in cells if c)
        else:
            line = re.sub(r"[ \t\f\v]+", " ", line).strip()
        if depth and line:
            line = "> " * depth + line
        lines.append(line)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# --------------------------------------------------------------------------- quoted history
class QuotedBlock(BaseModel):
    kind: Literal["reply", "forward", "quote"]
    header: str = ""  # attribution: "On Tue ... wrote:", "From: ... Sent: ...", "--- Forwarded ---"
    text: str = ""  # the quoted message body ('>' markers removed)


class QuotedSplit(BaseModel):
    new_text: str  # what the sender wrote in this message
    blocks: list[QuotedBlock] = Field(default_factory=list)  # older messages, newest first

    @property
    def quoted_text(self) -> str:
        return "\n\n".join(f"{b.header}\n{b.text}".strip() for b in self.blocks)

    @property
    def has_history(self) -> bool:
        return bool(self.blocks)


_WROTE_RE = re.compile(
    r"^(on|am|le|el|il|op|em|w dniu|в)\b.{0,250}?\b(wrote|writes|schrieb|a écrit|escribió|ha scritto"
    r"|schreef|escreveu|napisał|написал\(а\)|написал)\s*:?\s*$",
    re.I,
)
_WROTE_AR_RE = re.compile(r"^(في|بتاريخ)\s.{0,250}كتب.{0,200}:?\s*$")
_ORIGINAL_RE = re.compile(
    r"^[-_=\s]{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original"
    r"|messaggio originale|oorspronkelijk bericht|الرسالة الأصلية)\s*[-_=\s]{2,}$",
    re.I,
)
_FORWARD_RE = re.compile(
    r"^([-_=\s]{2,}\s*(forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado"
    r"|messaggio inoltrato|doorgestuurd bericht|رسالة معاد توجيهها|الرسالة المعاد توجيهها)\s*[-_=\s]{2,}"
    r"|begin forwarded message:?)$",
    re.I,
)
_HDR_FROM_RE = re.compile(r"^\*?\s*(from|de|von|van|da|od|من)\s*:\s*\*?\s*\S", re.I)
_HDR_SENT_RE = re.compile(
    r"^\*?\s*(sent|date|envoyé|gesendet|enviado|datum|inviato|data|verzonden|تاريخ الإرسال|التاريخ|أرسل|المرسل)\s*:",
    re.I,
)
_HDR_TO_SUBJ_RE = re.compile(
    r"^\*?\s*(to|à|a|an|para|aan|إلى|cc|subject|objet|betreff|asunto|oggetto|onderwerp|assunto|الموضوع)\s*:",
    re.I,
)
_HDR_ANY_RE = re.compile(
    r"^\*?\s*(from|de|von|van|da|od|من|sent|date|envoyé|gesendet|enviado|datum|inviato|data|verzonden"
    r"|تاريخ الإرسال|التاريخ|أرسل|to|à|a|an|para|aan|إلى|cc|bcc|subject|objet|betreff|asunto|oggetto"
    r"|onderwerp|assunto|الموضوع|importance|priority)\s*:",
    re.I,
)
_SEPARATOR_RE = re.compile(r"^[_\-=*]{8,}$")


def _outlook_header_at(lines: list[str], i: int) -> int:
    """If an Outlook-style ``From:/Sent:/To:/Subject:`` block starts at ``i`` return its end."""
    if not _HDR_FROM_RE.match(lines[i].strip()):
        return 0
    window = [ln.strip() for ln in lines[i + 1 : i + 7]]
    if not any(_HDR_SENT_RE.match(w) for w in window):
        return 0
    if not any(_HDR_TO_SUBJ_RE.match(w) for w in window):
        return 0
    end = i + 1
    while end < len(lines) and (_HDR_ANY_RE.match(lines[end].strip()) or (
        lines[end].strip() and end - i <= 6 and lines[end].startswith((" ", "\t")))):
        end += 1
    return end


def _strip_quote_marks(lines: list[str]) -> str:
    out = []
    for ln in lines:
        s = ln.lstrip()
        if s.startswith(">"):
            s = s[1:]
            if s.startswith(" "):
                s = s[1:]
            out.append(s)
        else:
            out.append(ln)
    return "\n".join(out).strip()


def split_quoted_history(text: str | None) -> QuotedSplit:
    """Separate what the sender wrote from the quoted conversation below it.

    Recognises Gmail/Apple ``On … wrote:`` attributions (also wrapped over two lines and the
    Arabic ``في … كتب:`` form), ``-----Original Message-----``, forwarded-message banners,
    Outlook ``From:/Sent:/To:/Subject:`` blocks (with or without the ``____`` rule) and a
    trailing run of ``>`` quoted lines. Every older message stays retrievable in ``blocks``.
    """
    if not text:
        return QuotedSplit(new_text="", blocks=[])
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    markers: list[tuple[int, int, str]] = []  # (start, header_end, kind)
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        hdr_end = 0
        kind = "reply"
        if _WROTE_RE.match(s) or _WROTE_AR_RE.match(s):
            hdr_end = i + 1
        elif (
            i + 1 < n
            and re.match(r"^(on|am|le|el|في)\b", s, re.I)
            and len(s) < 250
            and (_WROTE_RE.match(s + " " + lines[i + 1].strip()) or _WROTE_AR_RE.match(s + " " + lines[i + 1].strip()))
        ):
            hdr_end = i + 2
        elif _ORIGINAL_RE.match(s) or _FORWARD_RE.match(s):
            kind = "forward" if _FORWARD_RE.match(s) else "reply"
            hdr_end = i + 1
            while hdr_end < n and (_HDR_ANY_RE.match(lines[hdr_end].strip()) or not lines[hdr_end].strip()) and hdr_end - i < 10:
                if not lines[hdr_end].strip() and hdr_end + 1 < n and not _HDR_ANY_RE.match(lines[hdr_end + 1].strip()):
                    break
                hdr_end += 1
        else:
            end = _outlook_header_at(lines, i)
            if end:
                hdr_end = end
                subj = " ".join(lines[i:end]).lower()
                if re.search(r"(subject|الموضوع)\s*:\s*(fw|fwd|tr|wg|rv|إعادة توجيه)\s*:", subj):
                    kind = "forward"
        if hdr_end:
            start = i
            # pull an Outlook rule ("________") or blank lines just above into the header
            j = i - 1
            while j >= 0 and not lines[j].strip():
                j -= 1
            if j >= 0 and _SEPARATOR_RE.match(lines[j].strip()):
                start = j
            markers.append((start, hdr_end, kind))
            i = hdr_end
            continue
        i += 1

    if not markers:
        # trailing block of '>' quoted lines, e.g. a plain-text client without attribution
        k = n - 1
        while k >= 0 and not lines[k].strip():
            k -= 1
        end = k + 1
        while k >= 0 and (lines[k].lstrip().startswith(">") or not lines[k].strip()):
            k -= 1
        start = k + 1
        while start < end and not lines[start].strip():
            start += 1
        quoted = [ln for ln in lines[start:end] if ln.strip()]
        if len(quoted) >= 2 and start > 0:
            header = ""
            new_lines = lines[:start]
            prev = [ln for ln in new_lines if ln.strip()]
            if prev and prev[-1].strip().endswith(":") and len(prev[-1]) < 200:
                header = prev[-1].strip()
                idx = max(idx for idx, ln in enumerate(new_lines) if ln.strip())
                new_lines = new_lines[:idx]
            return QuotedSplit(
                new_text="\n".join(new_lines).strip(),
                blocks=[QuotedBlock(kind="quote", header=header, text=_strip_quote_marks(lines[start:end]))],
            )
        return QuotedSplit(new_text=text.strip(), blocks=[])

    blocks: list[QuotedBlock] = []
    for idx, (start, hdr_end, kind) in enumerate(markers):
        stop = markers[idx + 1][0] if idx + 1 < len(markers) else n
        header = "\n".join(ln.strip() for ln in lines[start:hdr_end] if ln.strip() and not _SEPARATOR_RE.match(ln.strip()))
        blocks.append(QuotedBlock(kind=kind, header=header, text=_strip_quote_marks(lines[hdr_end:stop])))
    new_lines = lines[: markers[0][0]]
    while new_lines and (not new_lines[-1].strip() or _SEPARATOR_RE.match(new_lines[-1].strip())):
        new_lines.pop()
    return QuotedSplit(new_text="\n".join(new_lines).strip(), blocks=blocks)
