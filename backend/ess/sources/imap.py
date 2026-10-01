"""IMAP connector (stdlib ``imaplib`` + ``smtplib``).

Works with Gmail (app password, or ``access_token`` for XOAUTH2), Office 365 (Exchange Online
needs ``access_token``: basic auth was retired) and any standard IMAP server.

* Gmail is detected through the ``X-GM-EXT-1`` capability: search uses ``X-GM-RAW`` (Gmail
  syntax), threads are ``X-GM-THRID`` and ids are the same hex ids the Gmail API uses.
* Other servers: search uses ``SINCE``/``BEFORE``/``TEXT`` (simple Gmail-style queries such as
  ``bmu OR gondola from:x@y.com`` are translated), threads are grouped through
  ``Message-ID``/``References``/``In-Reply-To``. Thread ids encode the root Message-ID, so
  ``get_thread`` works in a new process without any cache.
* Drafts are APPENDed to the ``\\Drafts`` special-use folder; ``send_draft`` (approval flow
  only) sends through SMTP, files a copy in ``\\Sent`` when the server does not, and removes
  the draft.

Message ids: Gmail -> hex ``X-GM-MSGID``; other servers -> ``"<uid>:<uidvalidity>:<folder>"``.
Attachment ids are MIME part paths (``"2"``, ``"1.2"``).
"""
from __future__ import annotations

import base64
import email
import email.policy
import imaplib
import re
import smtplib
import ssl as ssl_lib
import time
from contextlib import contextmanager
from datetime import date, datetime, timezone
from email.utils import getaddresses
from typing import Any, Callable, Iterable, Iterator, Sequence

from .base import (
    AuthError,
    MailMessage,
    MailSourceError,
    build_gmail_query,
    coerce_date,
    default_own_domains,
)
from .mime import build_mime_message, get_attachment_payload, looks_like_message_id, parse_rfc822

__all__ = [
    "ImapSource",
    "group_threads",
    "imap_utf7_decode",
    "imap_utf7_encode",
    "parse_fetch_response",
    "thread_id_for_root",
    "root_for_thread_id",
]

_GMAIL_LABEL_MAP = {
    "\\inbox": "INBOX",
    "\\sent": "SENT",
    "\\important": "IMPORTANT",
    "\\starred": "STARRED",
    "\\draft": "DRAFT",
    "\\spam": "SPAM",
    "\\trash": "TRASH",
}
_DRAFT_NAMES = (
    "drafts", "draft", "inbox.drafts", "inbox/drafts", "[gmail]/drafts", "[google mail]/drafts",
    "entwürfe", "brouillons", "borradores", "bozze", "المسودات",
)
_SENT_NAMES = (
    "sent", "sent items", "sent messages", "sent mail", "inbox.sent", "inbox/sent", "[gmail]/sent mail",
    "[google mail]/sent mail", "gesendet", "gesendete elemente", "envoyés", "éléments envoyés",
    "enviados", "posta inviata", "العناصر المرسلة", "المرسلة",
)
_ALL_NAMES = ("[gmail]/all mail", "[google mail]/all mail", "all mail")
_SMTP_HOSTS = {
    "imap.gmail.com": "smtp.gmail.com",
    "imap.googlemail.com": "smtp.gmail.com",
    "outlook.office365.com": "smtp.office365.com",
    "imap-mail.outlook.com": "smtp-mail.outlook.com",
    "imap.mail.yahoo.com": "smtp.mail.yahoo.com",
    "imap.zoho.com": "smtp.zoho.com",
    "imap.mail.me.com": "smtp.mail.me.com",
}
# Providers that file a copy of SMTP-sent mail in Sent by themselves
_AUTO_SENT_HOSTS = ("gmail.com", "googlemail.com", "office365.com", "outlook.com")


# --------------------------------------------------------------------------- small helpers
def _s(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return "" if value is None else str(value)


def _quote(value: str) -> str:
    """IMAP quoted string (imaplib does not quote arguments by itself)."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _imap_date(value: date | datetime) -> str:
    if isinstance(value, datetime):
        value = value.astimezone(timezone.utc).date() if value.tzinfo else value.date()
    months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return f"{value.day:02d}-{months[value.month - 1]}-{value.year}"


def imap_utf7_decode(name: str) -> str:
    """Decode an IMAP modified-UTF-7 mailbox name (RFC 3501 §5.1.3)."""

    def repl(match: re.Match) -> str:
        chunk = match.group(1)
        if not chunk:
            return "&"
        b64 = chunk.replace(",", "/")
        b64 += "=" * (-len(b64) % 4)
        try:
            return base64.b64decode(b64).decode("utf-16-be")
        except Exception:
            return match.group(0)

    return re.sub(r"&([A-Za-z0-9+,]*)-", repl, name)


def imap_utf7_encode(name: str) -> str:
    out: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        if buf:
            data = "".join(buf).encode("utf-16-be")
            out.append("&" + base64.b64encode(data).decode("ascii").rstrip("=").replace("/", ",") + "-")
            buf.clear()

    for ch in name:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


def thread_id_for_root(root: str) -> str:
    """Stable, reversible thread id for a non-Gmail thread root (a Message-ID or a uid key)."""
    raw = root.strip().strip("<>")
    return "imap-" + base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def root_for_thread_id(thread_id: str) -> str:
    if not thread_id.startswith("imap-"):
        raise ValueError(f"not an IMAP thread id: {thread_id!r}")
    data = thread_id[5:]
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8")


def _msgids(value: str | None) -> list[str]:
    return [m.strip("<>").strip() for m in re.findall(r"<[^<>\s]+>", value or "")]


def group_threads(items: Sequence[dict]) -> dict[str, list[Any]]:
    """Group messages into threads through Message-ID / References / In-Reply-To.

    ``items``: ``{"key", "message_id", "in_reply_to", "references", "fallback_root"}``.
    Returns ``{thread_id: [key, ...]}``. A thread's root is the first References entry, else
    the In-Reply-To parent (resolved through known messages), else the message itself.
    """
    by_id = {it["message_id"]: it for it in items if it.get("message_id")}
    roots: dict[Any, str] = {}

    def root_of(it: dict, depth: int = 0) -> str:
        refs = it.get("references") or []
        if refs:
            return refs[0]
        parent = it.get("in_reply_to")
        if parent:
            if parent in by_id and depth < 25 and by_id[parent] is not it:
                return root_of(by_id[parent], depth + 1)
            return parent
        return it.get("message_id") or it["fallback_root"]

    groups: dict[str, list[Any]] = {}
    for it in items:
        root = root_of(it)
        roots[it["key"]] = root
        groups.setdefault(thread_id_for_root(root), []).append(it["key"])
    return groups


def parse_fetch_response(data: Iterable[Any]) -> list[dict]:
    """Split an ``imaplib`` FETCH response into ``{"meta": str, "literal": bytes | None}``."""
    out: list[dict] = []
    current: dict | None = None
    for item in data or []:
        if item is None:
            continue
        if isinstance(item, tuple):
            head = _s(item[0])
            literal = item[1] if len(item) > 1 else None
            if current is not None and not re.match(r"^\s*\d+\s+\(", head):
                current["meta"] += " " + head  # second literal of the same message
                if current["literal"] is None:
                    current["literal"] = literal
                continue
            current = {"meta": head, "literal": literal}
            out.append(current)
        else:
            text = _s(item)
            if re.match(r"^\s*\d+\s+\(", text):
                current = {"meta": text, "literal": None}
                out.append(current)
            elif current is not None:
                current["meta"] += " " + text
    for entry in out:
        meta = entry["meta"]
        uid = re.search(r"\bUID\s+(\d+)", meta)
        entry["uid"] = int(uid.group(1)) if uid else None
        for key, rx in (("thrid", r"X-GM-THRID\s+(\d+)"), ("gmsgid", r"X-GM-MSGID\s+(\d+)")):
            m = re.search(rx, meta)
            entry[key] = int(m.group(1)) if m else None
        m = re.search(r'INTERNALDATE\s+"([^"]+)"', meta)
        entry["internaldate"] = _internaldate(m.group(1)) if m else None
        m = re.search(r"FLAGS\s+\(([^)]*)\)", meta)
        entry["flags"] = m.group(1).split() if m else []
        m = re.search(r"X-GM-LABELS\s+\(((?:[^()\"]|\"(?:[^\"\\]|\\.)*\")*)\)", meta)
        entry["gm_labels"] = [lbl.strip('"') for lbl in re.findall(r'"(?:[^"\\]|\\.)*"|\S+', m.group(1))] if m else []
    return out


def _internaldate(value: str) -> datetime | None:
    """IMAP INTERNALDATE (``26-Aug-2026 08:20:26 +0300``) -> aware UTC datetime."""
    try:
        return datetime.strptime(value.strip(), "%d-%b-%Y %H:%M:%S %z").astimezone(timezone.utc)
    except ValueError:
        return None


_LIST_RE = re.compile(r'^\((?P<flags>[^)]*)\)\s+(?P<delim>"(?:[^"\\]|\\.)*"|NIL)\s*(?P<name>.*)$', re.I)


def _parse_list(data: Iterable[Any]) -> list[tuple[set[str], str]]:
    folders: list[tuple[set[str], str]] = []
    for item in data or []:
        if item is None:
            continue
        if isinstance(item, tuple):
            head, name = _s(item[0]), _s(item[1])
            m = _LIST_RE.match(head)
        else:
            m = _LIST_RE.match(_s(item))
            name = m.group("name") if m else ""
        if not m:
            continue
        name = name.strip()
        if len(name) >= 2 and name.startswith('"') and name.endswith('"'):
            name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        flags = {f.lower() for f in m.group("flags").split()}
        folders.append((flags, name))
    return folders


def _or_terms(query: str) -> list[str]:
    """Split a simple Gmail-style query on top-level ``OR`` (parentheses removed)."""
    q = (query or "").strip()
    if not q:
        return []
    q = re.sub(r"^\((.*)\)$", r"\1", q)
    parts = [p.strip().strip("()").strip() for p in re.split(r"\s+OR\s+|\s*\|\s*", q)]
    return [p for p in parts if p]


def _term_criteria(term: str) -> tuple[list[str], bytes | None]:
    """IMAP SEARCH criteria for one AND-term; non-ASCII text becomes a single UTF-8 literal."""
    if not term.isascii():
        cleaned = re.sub(r"\b(from|to|subject|cc):", "", term).strip('" ')
        return ["TEXT"], cleaned.encode("utf-8")
    criteria: list[str] = []
    for token in re.findall(r'-?\w+:"[^"]*"|-?\w+:\S+|"[^"]+"|\S+', term):
        negate = token.startswith("-")
        tok = token[1:] if negate else token
        key, sep, value = tok.partition(":")
        value = value.strip('"')
        crit: list[str]
        if sep and key.lower() in ("from", "to", "cc", "subject", "bcc"):
            crit = [key.upper(), _quote(value)]
        elif sep and key.lower() in ("has", "in", "is", "label", "category", "filename", "after", "before",
                                     "newer_than", "older_than", "larger", "smaller", "list"):
            continue  # Gmail-only operators: ignored on plain IMAP
        else:
            word = tok.strip('"')
            if not word or word.upper() in ("AND",):
                continue
            crit = ["TEXT", _quote(word)]
        criteria += (["NOT"] + crit) if negate else crit
    return criteria, None


# --------------------------------------------------------------------------- the source
class ImapSource:
    """:class:`~ess.sources.base.MailSource` over IMAP (+ SMTP for approved sends)."""

    kind = "imap"

    def __init__(
        self,
        host: str,
        port: int = 993,
        username: str = "",
        password: str = "",
        ssl: bool = True,
        smtp_host: str | None = None,
        smtp_port: int = 587,
        own_domains: Sequence[str] = (),
        *,
        account: str | None = None,
        access_token: str | None = None,
        starttls: bool = True,
        folders: Sequence[str] | None = None,
        from_address: str | None = None,
        save_sent: bool | None = None,
        timeout: float = 60.0,
        connection_factory: Callable[[], Any] | None = None,
        smtp_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.ssl = ssl
        self.starttls = starttls
        self.access_token = access_token
        self.smtp_host = smtp_host or _SMTP_HOSTS.get(host.lower()) or re.sub(r"^imap\.", "smtp.", host)
        self.smtp_port = smtp_port
        self.account = (account or (username if "@" in username else None) or None)
        self.account = self.account.lower() if self.account else None
        self._own_domains = tuple(own_domains)
        self.folders = list(folders) if folders else None
        self.from_address = from_address or self.account
        self.save_sent = save_sent
        self.timeout = timeout
        self._factory = connection_factory
        self._smtp_factory = smtp_factory
        self._thread_cache: dict[str, set[tuple[str, int]]] = {}

    # ---- connection
    def _open(self):
        if self._factory is not None:
            conn = self._factory()
        else:
            ctx = ssl_lib.create_default_context()
            try:
                if self.ssl:
                    conn = imaplib.IMAP4_SSL(self.host, self.port, ssl_context=ctx, timeout=self.timeout)
                else:
                    conn = imaplib.IMAP4(self.host, self.port, timeout=self.timeout)
                    if self.starttls and "STARTTLS" in getattr(conn, "capabilities", ()):
                        conn.starttls(ssl_context=ctx)
            except (OSError, imaplib.IMAP4.error) as exc:
                raise MailSourceError(f"cannot reach IMAP server {self.host}:{self.port}: {exc}") from exc
        try:
            if self.access_token:
                auth = f"user={self.username}\x01auth=Bearer {self.access_token}\x01\x01"
                conn.authenticate("XOAUTH2", lambda _challenge: auth.encode("utf-8"))
            else:
                conn.login(self.username, self.password)
        except imaplib.IMAP4.error as exc:
            try:
                conn.logout()
            except Exception:
                pass
            raise AuthError(self._login_hint(_s(exc))) from exc
        return conn

    def _login_hint(self, message: str) -> str:
        hint = ""
        host = self.host.lower()
        if "gmail" in host or "googlemail" in host:
            hint = " Gmail needs an app password (Google Account > Security > App passwords) or OAuth."
        elif "office365" in host or "outlook" in host:
            hint = " Office 365 / Outlook.com need OAuth2 (pass access_token): basic auth is retired."
        return f"IMAP login failed for {self.username}: {message}.{hint}"

    @contextmanager
    def _session(self) -> Iterator[Any]:
        conn = self._open()
        try:
            yield conn
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    @staticmethod
    def _caps(conn) -> set[str]:
        try:
            typ, data = conn.capability()
            if typ == "OK" and data and data[0]:
                return {c.upper() for c in _s(data[0]).split()}
        except Exception:
            pass
        return {str(c).upper() for c in getattr(conn, "capabilities", ())}

    def _is_gmail(self, conn) -> bool:
        return "X-GM-EXT-1" in self._caps(conn)

    def _folders_with_flags(self, conn) -> list[tuple[set[str], str]]:
        typ, data = conn.list()
        if typ != "OK":
            return []
        return _parse_list(data)

    def _special_folder(self, conn, flag: str, names: Sequence[str]) -> str | None:
        folders = self._folders_with_flags(conn)
        for flags, name in folders:
            if flag.lower() in flags:
                return name
        for wanted in names:
            for _flags, name in folders:
                if imap_utf7_decode(name).lower() == wanted:
                    return name
        return None

    def _select(self, conn, folder: str, readonly: bool = True) -> int:
        typ, data = conn.select(_quote(folder), readonly=readonly)
        if typ != "OK":
            raise MailSourceError(f"cannot open folder {imap_utf7_decode(folder)!r}: {_s(data[0]) if data else typ}")
        uidvalidity = 0
        try:
            _typ, resp = conn.response("UIDVALIDITY")
            if resp and resp[0]:
                uidvalidity = int(_s(resp[0]).split()[0])
        except Exception:
            pass
        return uidvalidity

    def _search_folders(self, conn, gmail: bool) -> list[str]:
        if self.folders:
            return [imap_utf7_encode(f) if not f.isascii() else f for f in self.folders]
        if gmail:
            return [self._special_folder(conn, "\\All", _ALL_NAMES) or "INBOX"]
        out = ["INBOX"]
        sent = self._special_folder(conn, "\\Sent", _SENT_NAMES)
        if sent and sent.upper() != "INBOX":
            out.append(sent)
        return out

    def _uid_search(self, conn, criteria: list[str], literal: bytes | None) -> list[int]:
        args = (["CHARSET", "UTF-8"] if literal is not None else []) + (criteria or ["ALL"])
        if literal is not None:
            conn.literal = literal
        typ, data = conn.uid("SEARCH", *args)
        if typ != "OK":
            raise MailSourceError(f"IMAP SEARCH failed: {_s(data[0]) if data else typ}")
        uids: list[int] = []
        for chunk in data or []:
            uids += [int(x) for x in _s(chunk).split() if x.isdigit()]
        return uids

    def _uid_fetch(self, conn, uids: Sequence[int], items: str) -> list[dict]:
        out: list[dict] = []
        for i in range(0, len(uids), 400):
            chunk = ",".join(str(u) for u in uids[i : i + 400])
            typ, data = conn.uid("FETCH", chunk, items)
            if typ != "OK":
                raise MailSourceError(f"IMAP FETCH failed: {_s(data[0]) if data else typ}")
            out += parse_fetch_response(data)
        return out

    # ---- search
    def search(self, query: str, after=None, before=None, max_results: int = 500) -> list[str]:
        with self._session() as conn:
            gmail = self._is_gmail(conn)
            if gmail:
                return self._search_gmail(conn, query, after, before, max_results)
            return self._search_generic(conn, query, after, before, max_results)

    def _search_gmail(self, conn, query, after, before, max_results) -> list[str]:
        folder = self._search_folders(conn, True)[0]
        self._select(conn, folder)
        raw = build_gmail_query(query, after, before)
        if not raw:
            uids = self._uid_search(conn, ["ALL"], None)
        elif raw.isascii():
            uids = self._uid_search(conn, ["X-GM-RAW", _quote(raw)], None)
        else:
            uids = self._uid_search(conn, ["X-GM-RAW"], raw.encode("utf-8"))
        uids.sort(reverse=True)  # newest first
        thread_ids: list[str] = []
        for i in range(0, len(uids), 400):
            for entry in self._uid_fetch(conn, uids[i : i + 400], "(UID X-GM-THRID)"):
                if entry.get("thrid") is None:
                    continue
                tid = format(entry["thrid"], "x")
                if tid not in thread_ids:
                    thread_ids.append(tid)
            if len(thread_ids) >= max_results:
                break
        return thread_ids[:max_results]

    def _search_generic(self, conn, query, after, before, max_results) -> list[str]:
        lo, hi = coerce_date(after), coerce_date(before)
        base: list[str] = []
        if lo is not None:
            base += ["SINCE", _imap_date(lo)]
        if hi is not None:
            base += ["BEFORE", _imap_date(hi)]
        terms = _or_terms(query)
        items: list[dict] = []
        for folder in self._search_folders(conn, False):
            try:
                uidvalidity = self._select(conn, folder)
            except MailSourceError:
                continue
            found: set[int] = set()
            if not terms:
                found |= set(self._uid_search(conn, base or ["ALL"], None))
            for term in terms:
                crit, literal = _term_criteria(term)
                found |= set(self._uid_search(conn, base + crit, literal))
            if not found:
                continue
            uids = sorted(found, reverse=True)[: max_results * 4]
            entries = self._uid_fetch(
                conn, uids, "(UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])"
            )
            for entry in entries:
                if entry.get("uid") is None:
                    continue
                hdr = email.message_from_bytes(entry.get("literal") or b"", policy=email.policy.compat32)
                mid = (_msgids(hdr.get("Message-ID")) or [None])[0]
                items.append(
                    {
                        "key": (folder, entry["uid"]),
                        "message_id": mid,
                        "in_reply_to": (_msgids(hdr.get("In-Reply-To")) or [None])[0],
                        "references": _msgids(hdr.get("References")),
                        "fallback_root": f"uid:{entry['uid']}:{uidvalidity}:{folder}",
                        "date": entry.get("internaldate") or datetime.min.replace(tzinfo=timezone.utc),
                    }
                )
        groups = group_threads(items)
        newest: dict[str, datetime] = {}
        by_key = {it["key"]: it for it in items}
        for tid, keys in groups.items():
            newest[tid] = max(by_key[k]["date"] for k in keys)
            self._thread_cache.setdefault(tid, set()).update(keys)
        ordered = sorted(groups, key=lambda t: newest[t], reverse=True)
        return ordered[:max_results]

    # ---- threads
    def get_thread(self, thread_id: str) -> list[MailMessage]:
        with self._session() as conn:
            if not thread_id.startswith("imap-"):
                if not self._is_gmail(conn):
                    raise MailSourceError(f"unknown thread id {thread_id!r} for a non-Gmail IMAP server")
                return self._gmail_thread(conn, thread_id)
            return self._generic_thread(conn, thread_id)

    def _gmail_full_fetch_items(self) -> str:
        return "(UID FLAGS INTERNALDATE X-GM-MSGID X-GM-THRID X-GM-LABELS BODY.PEEK[])"

    def _gmail_thread(self, conn, thread_id: str) -> list[MailMessage]:
        folder = self._search_folders(conn, True)[0]
        self._select(conn, folder)
        uids = self._uid_search(conn, ["X-GM-THRID", str(int(thread_id, 16))], None)
        messages = [self._gmail_message(entry) for entry in self._uid_fetch(conn, sorted(uids), self._gmail_full_fetch_items())
                    if entry.get("literal")]
        messages.sort(key=lambda m: m.date)
        return messages

    def _gmail_message(self, entry: dict) -> MailMessage:
        labels = []
        for lbl in entry.get("gm_labels") or []:
            labels.append(_GMAIL_LABEL_MAP.get(lbl.lower(), lbl.replace("\\\\", "\\")))
        if "\\Seen" not in entry.get("flags", []):
            labels.append("UNREAD")
        mid = format(entry["gmsgid"], "x") if entry.get("gmsgid") else str(entry.get("uid"))
        tid = format(entry["thrid"], "x") if entry.get("thrid") else mid
        return parse_rfc822(
            entry["literal"],
            message_id=mid,
            thread_id=tid,
            account=self.account,
            own_domains=self._own_domains,
            labels=labels,
            view_url=(f"https://mail.google.com/mail/?authuser={self.account}#all/{mid}" if self.account
                      else f"https://mail.google.com/mail/#all/{mid}"),
            fallback_date=entry.get("internaldate"),
        )

    def _generic_thread(self, conn, thread_id: str) -> list[MailMessage]:
        root = root_for_thread_id(thread_id)
        wanted: dict[str, set[int]] = {}
        for folder, uid in self._thread_cache.get(thread_id, set()):
            wanted.setdefault(folder, set()).add(uid)
        if root.startswith("uid:"):
            _tag, uid, _uidv, folder = root.split(":", 3)
            wanted.setdefault(folder, set()).add(int(uid))
            folders = list(wanted)
        else:
            folders = list(dict.fromkeys(self._search_folders(conn, False) + list(wanted)))
        sent_folder = self._special_folder(conn, "\\Sent", _SENT_NAMES)
        messages: dict[str, MailMessage] = {}
        for folder in folders:
            try:
                uidvalidity = self._select(conn, folder)
            except MailSourceError:
                continue
            uids = set(wanted.get(folder, set()))
            if not root.startswith("uid:"):
                rid = _quote(f"<{root}>")
                uids |= set(self._uid_search(
                    conn,
                    ["OR", "HEADER", "Message-ID", rid, "OR", "HEADER", "References", rid, "HEADER", "In-Reply-To", rid],
                    None,
                ))
            if not uids:
                continue
            labels = ["SENT"] if (sent_folder and folder == sent_folder) else (["INBOX"] if folder.upper() == "INBOX" else [imap_utf7_decode(folder)])
            for entry in self._uid_fetch(conn, sorted(uids), "(UID FLAGS INTERNALDATE BODY.PEEK[])"):
                if not entry.get("literal") or entry.get("uid") is None:
                    continue
                entry_labels = list(labels) + ([] if "\\Seen" in entry.get("flags", []) else ["UNREAD"])
                msg = parse_rfc822(
                    entry["literal"],
                    message_id=f"{entry['uid']}:{uidvalidity}:{folder}",
                    thread_id=thread_id,
                    account=self.account,
                    own_domains=self._own_domains,
                    labels=entry_labels,
                    fallback_date=entry.get("internaldate"),
                )
                key = msg.message_id_header or msg.id
                if key not in messages or "SENT" in entry_labels:
                    messages[key] = msg
        return sorted(messages.values(), key=lambda m: m.date)

    # ---- attachments
    def _locate(self, conn, message_id: str) -> tuple[str, int]:
        """(folder, uid) for one of our message ids, selected read-only."""
        if ":" in message_id:
            uid_s, uidv_s, folder = message_id.split(":", 2)
            uidvalidity = self._select(conn, folder)
            if uidvalidity and uidv_s.isdigit() and int(uidv_s) != uidvalidity:
                raise MailSourceError(f"folder {folder!r} was rebuilt (UIDVALIDITY changed); search again")
            return folder, int(uid_s)
        if self._is_gmail(conn) and re.fullmatch(r"[0-9a-fA-F]+", message_id):
            folder = self._search_folders(conn, True)[0]
            self._select(conn, folder)
            uids = self._uid_search(conn, ["X-GM-MSGID", str(int(message_id, 16))], None)
            if uids:
                return folder, uids[0]
        raise MailSourceError(f"message {message_id!r} not found")

    def _fetch_raw(self, conn, uid: int) -> bytes:
        entries = self._uid_fetch(conn, [uid], "(UID BODY.PEEK[])")
        for entry in entries:
            if entry.get("literal"):
                return entry["literal"]
        raise MailSourceError(f"message uid {uid} has no content")

    def download_attachment(self, message_id: str, attachment_id: str) -> bytes:
        with self._session() as conn:
            _folder, uid = self._locate(conn, message_id)
            raw = self._fetch_raw(conn, uid)
        try:
            return get_attachment_payload(raw, attachment_id)
        except KeyError as exc:
            raise MailSourceError(str(exc)) from exc

    # ---- drafts and sending
    def _parent_headers(self, conn, in_reply_to: str) -> tuple[str | None, str | None]:
        if looks_like_message_id(in_reply_to):
            return in_reply_to, None
        _folder, uid = self._locate(conn, in_reply_to)
        entries = self._uid_fetch(conn, [uid], "(UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID REFERENCES)])")
        if not entries or not entries[0].get("literal"):
            return None, None
        hdr = email.message_from_bytes(entries[0]["literal"], policy=email.policy.compat32)
        return hdr.get("Message-ID"), hdr.get("References")

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
        """APPEND a draft to the Drafts folder; returns its Message-ID (the draft id)."""
        with self._session() as conn:
            parent, refs = (None, None)
            if in_reply_to:
                parent, refs = self._parent_headers(conn, in_reply_to)
            msg = build_mime_message(
                from_addr=self.from_address,
                to=to,
                cc=cc,
                bcc=bcc,
                subject=subject,
                body_text=body_text,
                body_html=body_html,
                attachments=attachments,
                in_reply_to=parent,
                references=refs,
                message_id_domain=(default_own_domains(self.account, self._own_domains) or (None,))[0],
            )
            drafts = self._special_folder(conn, "\\Drafts", _DRAFT_NAMES) or "Drafts"
            typ, data = conn.append(
                _quote(drafts),
                "(\\Draft \\Seen)",
                imaplib.Time2Internaldate(time.time()),
                msg.as_bytes(policy=email.policy.SMTP),
            )
            if typ != "OK":
                raise MailSourceError(f"could not save the draft in {imap_utf7_decode(drafts)!r}: {_s(data[0]) if data else typ}")
            return str(msg["Message-ID"])

    def _smtp(self):
        if self._smtp_factory is not None:
            return self._smtp_factory()
        ctx = ssl_lib.create_default_context()
        try:
            if self.smtp_port == 465:
                smtp = smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, timeout=self.timeout, context=ctx)
            else:
                smtp = smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=self.timeout)
                smtp.ehlo()
                if smtp.has_extn("starttls"):
                    smtp.starttls(context=ctx)
                    smtp.ehlo()
        except OSError as exc:
            raise MailSourceError(f"cannot reach SMTP server {self.smtp_host}:{self.smtp_port}: {exc}") from exc
        try:
            if self.access_token:
                auth = f"user={self.username}\x01auth=Bearer {self.access_token}\x01\x01"
                smtp.auth("XOAUTH2", lambda challenge=None: auth)
            else:
                smtp.login(self.username, self.password)
        except smtplib.SMTPException as exc:
            smtp.close()
            raise AuthError(f"SMTP login failed for {self.username}: {exc}") from exc
        return smtp

    def _should_save_sent(self) -> bool:
        if self.save_sent is not None:
            return self.save_sent
        host = (self.smtp_host or "").lower()
        return not any(host.endswith(h) for h in _AUTO_SENT_HOSTS)

    def send_draft(self, draft_id: str) -> str:
        """Send an approved draft through SMTP (approval flow only); returns its Message-ID."""
        with self._session() as conn:
            drafts = self._special_folder(conn, "\\Drafts", _DRAFT_NAMES) or "Drafts"
            self._select(conn, drafts, readonly=False)
            uids = self._uid_search(conn, ["HEADER", "Message-ID", _quote(draft_id)], None)
            if not uids:
                raise MailSourceError("draft not found: it may have been sent or deleted in the mail client")
            uid = uids[-1]
            raw = self._fetch_raw(conn, uid)
            msg = email.message_from_bytes(raw, policy=email.policy.default)
            recipients = [addr for _n, addr in getaddresses(
                [str(v) for k in ("To", "Cc", "Bcc") for v in (msg.get_all(k) or [])]) if addr]
            if not recipients:
                raise MailSourceError("the draft has no recipients")
            del msg["Bcc"]
            sender = self.from_address or self.username
            smtp = self._smtp()
            try:
                smtp.send_message(msg, from_addr=sender, to_addrs=recipients)
            except smtplib.SMTPException as exc:
                raise MailSourceError(f"SMTP refused the message: {exc}") from exc
            finally:
                try:
                    smtp.quit()
                except Exception:
                    pass
            if self._should_save_sent():
                sent = self._special_folder(conn, "\\Sent", _SENT_NAMES)
                if sent:
                    conn.append(_quote(sent), "(\\Seen)", imaplib.Time2Internaldate(time.time()),
                                msg.as_bytes(policy=email.policy.SMTP))
            conn.uid("STORE", str(uid), "+FLAGS.SILENT", "(\\Deleted)")
            if "UIDPLUS" in self._caps(conn):
                conn.uid("EXPUNGE", str(uid))
            else:
                conn.expunge()
            return str(msg["Message-ID"] or draft_id)

    # ---- connection test
    def test(self, *, check_smtp: bool = False) -> dict[str, Any]:
        try:
            with self._session() as conn:
                gmail = self._is_gmail(conn)
                folders = self._folders_with_flags(conn)
                typ, data = conn.select("INBOX", readonly=True)
                inbox = int(_s(data[0]) or 0) if typ == "OK" and data and _s(data[0]).isdigit() else None
                result: dict[str, Any] = {
                    "ok": True,
                    "account": self.account or self.username,
                    "error": None,
                    "gmail": gmail,
                    "inbox_messages": inbox,
                    "drafts_folder": self._special_folder(conn, "\\Drafts", _DRAFT_NAMES),
                    "sent_folder": self._special_folder(conn, "\\Sent", _SENT_NAMES),
                    "folders": [imap_utf7_decode(name) for _flags, name in folders][:200],
                }
        except Exception as exc:
            return {"ok": False, "account": self.account or self.username, "error": str(exc)}
        if check_smtp:
            try:
                smtp = self._smtp()
                smtp.quit()
                result["smtp"] = {"ok": True, "host": self.smtp_host, "port": self.smtp_port}
            except Exception as exc:
                result["smtp"] = {"ok": False, "host": self.smtp_host, "port": self.smtp_port, "error": str(exc)}
        return result
