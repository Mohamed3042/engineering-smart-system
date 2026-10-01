"""In-memory stand-ins for ``imaplib.IMAP4`` and ``smtplib.SMTP`` (only what ImapSource uses).

Responses use imaplib's real shapes, e.g. FETCH -> ``[(b'1 (UID 5 BODY[] {123}', b'raw'), b')']``.
"""
from __future__ import annotations

import email
import email.policy
import imaplib
import re
from datetime import datetime


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return value


def _decoded_text(raw: bytes) -> str:
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    parts = [str(msg.get(h) or "") for h in ("Subject", "From", "To", "Cc")]
    for part in msg.walk():
        if part.get_content_type() in ("text/plain", "text/html") and not part.get_filename():
            try:
                parts.append(part.get_content())
            except Exception:
                pass
    return "\n".join(parts).lower()


class FakeIMAP:
    def __init__(self, mailboxes: dict[str, list[dict]], *, special: dict[str, str] | None = None,
                 gmail: bool = False, password: str = "app-password", uidvalidity: int = 777):
        self.mailboxes = {name: [dict(m) for m in msgs] for name, msgs in mailboxes.items()}
        self.special = special or {}
        self.gmail = gmail
        self.password = password
        self.uidvalidity = uidvalidity
        self.capabilities = ("IMAP4REV1", "UIDPLUS", "IDLE") + (("X-GM-EXT-1",) if gmail else ())
        self.selected: str | None = None
        self.readonly = True
        self.literal: bytes | None = None
        self.commands: list[tuple] = []
        self.logins = 0

    # ---- session
    def login(self, user, password):
        if password != self.password:
            raise imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")
        self.logins += 1
        return "OK", [b"LOGIN completed"]

    def logout(self):
        self.selected = None
        return "BYE", [b"LOGOUT"]

    def capability(self):
        return "OK", [" ".join(self.capabilities).encode()]

    def list(self, directory='""', pattern="*"):
        lines = []
        for name in self.mailboxes:
            flags = ["\\HasNoChildren"] + ([self.special[name]] if name in self.special else [])
            lines.append(f'({" ".join(flags)}) "/" "{name}"'.encode())
        return "OK", lines

    def select(self, mailbox="INBOX", readonly=False):
        name = _unquote(mailbox)
        if name not in self.mailboxes:
            return "NO", [b"[NONEXISTENT] Unknown Mailbox"]
        self.selected, self.readonly = name, readonly
        return "OK", [str(len(self.mailboxes[name])).encode()]

    def response(self, code):
        if code == "UIDVALIDITY":
            return code, [str(self.uidvalidity).encode()]
        return code, [None]

    # ---- commands
    def uid(self, command, *args):
        command = command.upper()
        tokens = list(args)
        if self.literal is not None:
            tokens.append(self.literal.decode("utf-8"))
            self.literal = None
        self.commands.append((command, *tokens))
        if command == "SEARCH":
            return self._search(tokens)
        if command == "FETCH":
            return self._fetch(tokens[0], tokens[1])
        if command == "STORE":
            for msg in self._folder():
                if str(msg["uid"]) in tokens[0].split(","):
                    msg.setdefault("flags", [])
                    if "\\Deleted" in tokens[2]:
                        msg["flags"].append("\\Deleted")
            return "OK", [b"STORE completed"]
        if command == "EXPUNGE":
            wanted = tokens[0].split(",")
            self.mailboxes[self.selected] = [m for m in self._folder()
                                             if not (str(m["uid"]) in wanted and "\\Deleted" in m.get("flags", []))]
            return "OK", [b"EXPUNGE completed"]
        return "BAD", [b"unknown command"]

    def expunge(self):
        self.mailboxes[self.selected] = [m for m in self._folder() if "\\Deleted" not in m.get("flags", [])]
        return "OK", [b"EXPUNGE completed"]

    def append(self, mailbox, flags, date_time, message):
        name = _unquote(mailbox)
        if name not in self.mailboxes:
            return "NO", [b"[TRYCREATE] no such mailbox"]
        folder = self.mailboxes[name]
        uid = max((m["uid"] for m in folder), default=0) + 1
        folder.append({"uid": uid, "raw": bytes(message), "flags": flags.strip("()").split(),
                       "internaldate": "01-Oct-2026 10:00:00 +0000", "thrid": 1, "msgid": 900 + uid, "labels": []})
        self.commands.append(("APPEND", name, flags))
        return "OK", [f"[APPENDUID {self.uidvalidity} {uid}] APPEND completed".encode()]

    # ---- helpers
    def _folder(self) -> list[dict]:
        if self.selected is None:
            raise imaplib.IMAP4.error("no mailbox selected")
        return self.mailboxes[self.selected]

    def _search(self, tokens):
        if tokens[:2] == ["CHARSET", "UTF-8"]:
            tokens = tokens[2:]
        hits = [m["uid"] for m in self._folder() if self._matches(tokens, m)]
        return "OK", [" ".join(str(u) for u in hits).encode()]

    def _matches(self, tokens, msg) -> bool:
        pos, ok = 0, True
        while pos < len(tokens):
            result, pos = self._key(tokens, pos, msg)
            ok = ok and result
        return ok

    def _key(self, t, i, msg):
        key = t[i].upper()
        raw = msg["raw"]
        if key == "ALL":
            return True, i + 1
        if key == "OR":
            a, i = self._key(t, i + 1, msg)
            b, i = self._key(t, i, msg)
            return a or b, i
        if key == "NOT":
            a, i = self._key(t, i + 1, msg)
            return not a, i
        if key in ("SINCE", "BEFORE"):
            day = datetime.strptime(t[i + 1], "%d-%b-%Y").date()
            internal = datetime.strptime(msg["internaldate"], "%d-%b-%Y %H:%M:%S %z").date()
            return (internal >= day if key == "SINCE" else internal < day), i + 2
        if key in ("TEXT", "BODY"):
            return _unquote(t[i + 1]).lower() in _decoded_text(raw), i + 2
        if key in ("FROM", "TO", "CC", "SUBJECT"):
            parsed = email.message_from_bytes(raw, policy=email.policy.default)
            return _unquote(t[i + 1]).lower() in str(parsed.get(key.title()) or "").lower(), i + 2
        if key == "HEADER":
            parsed = email.message_from_bytes(raw, policy=email.policy.compat32)
            value = " ".join(str(v) for v in parsed.get_all(t[i + 1]) or [])
            return _unquote(t[i + 2]).lower() in value.lower(), i + 3
        if key == "X-GM-RAW":
            query = _unquote(t[i + 1])
            words = [w.lower() for w in query.split() if ":" not in w and w.upper() != "OR"]
            text = _decoded_text(raw)
            hit = any(w in text for w in words) if " OR " in query else all(w in text for w in words)
            return hit, i + 2
        if key == "X-GM-THRID":
            return msg.get("thrid") == int(t[i + 1]), i + 2
        if key == "X-GM-MSGID":
            return msg.get("msgid") == int(t[i + 1]), i + 2
        raise imaplib.IMAP4.error(f"unsupported search key {key}")

    def _fetch(self, uid_set, items):
        wanted = {int(u) for u in uid_set.split(",")}
        up = items.upper()
        out: list = []
        for seq, msg in enumerate(self._folder(), start=1):
            if msg["uid"] not in wanted:
                continue
            meta = [f"UID {msg['uid']}"]
            if "FLAGS" in up:
                meta.append(f"FLAGS ({' '.join(msg.get('flags', []))})")
            if "INTERNALDATE" in up:
                meta.append(f'INTERNALDATE "{msg["internaldate"]}"')
            if self.gmail and "X-GM-THRID" in up:
                meta.append(f"X-GM-THRID {msg['thrid']}")
            if self.gmail and "X-GM-MSGID" in up:
                meta.append(f"X-GM-MSGID {msg['msgid']}")
            if self.gmail and "X-GM-LABELS" in up:
                meta.append(f"X-GM-LABELS ({' '.join(msg.get('labels', []))})")
            literal = None
            fields = re.search(r"HEADER\.FIELDS \(([^)]*)\)", up)
            if fields:
                names = {f.lower() for f in fields.group(1).split()}
                header_block = msg["raw"].split(b"\r\n\r\n", 1)[0].split(b"\n\n", 1)[0]
                kept, keep = [], False
                for line in re.split(rb"\r?\n", header_block):
                    if line[:1] in (b" ", b"\t"):
                        if keep:
                            kept.append(line)
                        continue
                    keep = line.split(b":", 1)[0].decode("ascii", "ignore").lower() in names
                    if keep:
                        kept.append(line)
                literal = b"\r\n".join(kept) + b"\r\n\r\n"
                section = f"BODY[HEADER.FIELDS ({fields.group(1)})]"
            elif "BODY.PEEK[]" in up or "BODY[]" in up:
                literal, section = msg["raw"], "BODY[]"
            if literal is None:
                out.append(f"{seq} ({' '.join(meta)})".encode())
            else:
                out.append((f"{seq} ({' '.join(meta)} {section} {{{len(literal)}}}".encode(), literal))
                out.append(b")")
        return "OK", out


class FakeSMTP:
    def __init__(self):
        self.sent: list[dict] = []
        self.closed = False

    def send_message(self, msg, from_addr=None, to_addrs=None):
        self.sent.append({"msg": msg, "from": from_addr, "to": list(to_addrs or [])})
        return {}

    def quit(self):
        self.closed = True
