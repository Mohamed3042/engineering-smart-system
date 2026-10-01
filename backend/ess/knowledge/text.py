"""Text utilities shared by the knowledge miner and the customer modules.

Everything that produces evidence works on offsets into the ORIGINAL text, so quotes are always
exact substrings of their source (``ess.ai.guards`` and the snapshot importer re-check them).
"""
from __future__ import annotations

import bisect
import re
from functools import lru_cache
from typing import Iterable
from urllib.parse import urlsplit

from ess.knowledge.base import normalize_text

# --------------------------------------------------------------------------------------------
# Sentences
# --------------------------------------------------------------------------------------------

_ABBREVIATIONS = frozenset(
    {"co", "ltd", "no", "nos", "mr", "mrs", "ms", "dr", "st", "eng", "engr", "inc", "corp", "jr", "sr", "e.g",
     "i.e", "etc", "approx", "ref", "fig", "vs", "w.l.l", "l.l.c", "k.s.c", "k.s.c.c", "s.a", "p.o", "tel", "mob",
     "fax", "ext", "est", "dept", "govt", "u.s", "u.k", "u.a.e", "k.s.a", "w.e.f", "qty", "pcs", "max", "min",
     "sq", "m/s", "attn", "encl", "pls", "bldg", "blk", "a.m", "p.m", "jan", "feb", "mar", "apr", "jun", "jul",
     "aug", "sep", "sept", "oct", "nov", "dec", "messrs", "m/s", "kd", "k.d", "q.r", "s.r"}
)
_BOUNDARY_RE = re.compile(r"[.!?؟]+[\"'”’)\]]*(?=\s)")
_PREV_WORD_RE = re.compile(r"([\w.'/]+)$")


def _line_spans(text: str) -> list[tuple[int, int]]:
    spans = []
    pos = 0
    for line in text.splitlines(keepends=True):
        end = pos + len(line.rstrip("\r\n"))
        spans.append((pos, end))
        pos += len(line)
    return spans


def _trim(text: str, s: int, e: int) -> tuple[int, int]:
    while s < e and text[s].isspace():
        s += 1
    while e > s and text[e - 1].isspace():
        e -= 1
    return s, e


def sentence_spans(text: str) -> list[tuple[int, int]]:
    """Sentence-ish spans: every line, further split at sentence punctuation (abbreviation aware)."""
    out: list[tuple[int, int]] = []
    if not text:
        return out
    for ls, le in _line_spans(text):
        start = ls
        for m in _BOUNDARY_RE.finditer(text, ls, le):
            cut = m.end()
            nxt = cut
            while nxt < le and text[nxt].isspace():
                nxt += 1
            if nxt >= le:
                continue
            ch = text[nxt]
            if not (ch.isupper() or ch.isdigit() or "؀" <= ch <= "ۿ" or ch in "\"'(“‘-•*"):
                continue
            pw = _PREV_WORD_RE.search(text, start, m.start() + 1)
            word = (pw.group(1) if pw else "").rstrip(".").lower()
            if word in _ABBREVIATIONS or (len(word) == 1 and word.isalpha()):
                continue
            s, e = _trim(text, start, cut)
            if e > s:
                out.append((s, e))
            start = cut
        s, e = _trim(text, start, le)
        if e > s:
            out.append((s, e))
    return out


class SentenceIndex:
    """Fast "which sentence contains offset x" lookups for one text."""

    __slots__ = ("text", "spans", "_starts")

    def __init__(self, text: str) -> None:
        self.text = text or ""
        self.spans = sentence_spans(self.text)
        self._starts = [s for s, _ in self.spans]

    def span_at(self, pos: int) -> tuple[int, int]:
        i = bisect.bisect_right(self._starts, pos) - 1
        if 0 <= i < len(self.spans) and self.spans[i][0] <= pos < max(self.spans[i][1], self.spans[i][0] + 1):
            return self.spans[i]
        return (pos, pos)

    def quote(self, start: int, end: int, max_len: int = 280) -> str:
        return quote_around(self.text, start, end, max_len=max_len, span=self.span_at(start))


def quote_around(text: str, start: int, end: int, *, max_len: int = 280,
                 span: tuple[int, int] | None = None) -> str:
    """Exact substring of ``text`` around ``[start, end)``: the containing sentence, or a window
    cut at word boundaries when the sentence is longer than ``max_len``."""
    if not text:
        return ""
    if span is None or span[1] <= span[0] or not (span[0] <= start and end <= span[1]):
        span = SentenceIndex(text).span_at(start) if span is None else span
        if not (span[0] <= start and end <= span[1]):
            span = (start, end)
    s, e = span
    if e - s <= max_len:
        return text[s:e]
    room = max(0, max_len - (end - start))
    ws = max(s, start - room // 2)
    we = min(e, end + (room - (start - ws)))
    while ws > s and not text[ws - 1].isspace() and ws < start:
        ws += 1
    while we < e and we > end and not text[we].isspace():
        we -= 1
    ws, we = _trim(text, ws, we)
    return text[ws:we] if we > ws else text[start:end]


# --------------------------------------------------------------------------------------------
# Quote verification
# --------------------------------------------------------------------------------------------

_WORDS_RE = re.compile(r"[^\W_]+")
_AR_EQUIV = {
    "ا": "[اأإآٱ]", "ي": "[يىئی]", "ه": "[هة]", "و": "[وؤ]", "ك": "[كک]",
}


def squash(text: str) -> str:
    """Normalised words joined by single spaces (punctuation dropped) - for containment checks."""
    return " ".join(_WORDS_RE.findall(normalize_text(text)))


@lru_cache(maxsize=512)
def _flex_pattern(quote: str) -> re.Pattern | None:
    words = _WORDS_RE.findall(quote)
    if not words:
        return None
    marks = "[̀-ͯؐ-ًؚ-ٰٟـ]*"
    parts = []
    for w in words:
        chars = []
        for ch in w:
            if ch in _AR_EQUIV:
                chars.append(_AR_EQUIV[ch] + marks)
            elif "؀" <= ch <= "ۿ":
                chars.append(re.escape(ch) + marks)
            else:
                chars.append(re.escape(ch) + marks)
        parts.append("".join(chars))
    try:
        return re.compile(r"(?<!\w)" + r"[\W_]+".join(parts) + r"(?!\w)", re.IGNORECASE)
    except re.error:
        return None


def _guards_find_quote():
    try:  # the AI guards (other package) are the reference implementation when present
        from ess.ai.guards import find_quote  # type: ignore

        return find_quote
    except Exception:
        return None


def find_verbatim(quote: str | None, text: str | None) -> str | None:
    """The exact span of ``text`` matching ``quote`` (tolerating case, whitespace, punctuation and
    Arabic spelling variants), or ``None``."""
    if not quote or not text:
        return None
    q = quote.strip()
    if not q:
        return None
    i = text.find(q)
    if i >= 0:
        return text[i:i + len(q)]
    finder = _guards_find_quote()
    if finder is not None:
        try:
            hit = finder(text, q)
        except Exception:
            hit = None
        if hit and hit.get("text"):
            return hit["text"]
    pat = _flex_pattern(normalize_text(q)) if len(q) <= 2000 else None
    if pat is not None:
        m = pat.search(text)
        if m:
            return text[m.start():m.end()]
    return None


def quote_in_text(quote: str | None, text: str | None) -> bool:
    """Normalised containment (case, accents, Arabic variants, punctuation and spacing ignored)."""
    if not quote or not text:
        return False
    q = squash(quote)
    return bool(q) and q in squash(text)


# --------------------------------------------------------------------------------------------
# Quoted history in e-mail bodies (offset based: the kept part is always a prefix)
# --------------------------------------------------------------------------------------------

_WROTE_RE = re.compile(
    r"^\s*(?:on|am|le|el|il|op|em|в)\b.{0,250}?\b(?:wrote|writes|schrieb|a écrit|escribió|ha scritto|schreef"
    r"|escreveu|написал\(а\)|написал|пишет)\s*:?\s*$", re.I)
_WROTE_AR_RE = re.compile(r"^\s*(?:في|بتاريخ)\s.{0,250}كتب.{0,200}:?\s*$")
_ORIGINAL_RE = re.compile(
    r"^\s*[-_=\s]{2,}\s*(?:original message|ursprüngliche nachricht|message d'origine|mensaje original"
    r"|messaggio originale|الرسالة الأصلية|исходное сообщение)\s*[-_=\s]{2,}\s*$", re.I)
_FORWARD_RE = re.compile(
    r"^\s*(?:[-_=\s]{2,}\s*(?:forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado"
    r"|messaggio inoltrato|رسالة معاد توجيهها|الرسالة المعاد توجيهها|пересылаемое сообщение)\s*[-_=\s]{2,}"
    r"|begin forwarded message:?)\s*$", re.I)
_HDR_FROM_RE = re.compile(r"^\s*\*?\s*(?:from|de|von|van|da|من|от)\s*:\s*\*?\s*\S", re.I)
_HDR_SENT_RE = re.compile(
    r"^\s*\*?\s*(?:sent|date|envoyé|gesendet|enviado|datum|inviato|data|تاريخ الإرسال|التاريخ|أرسل|отправлено|дата)\s*:",
    re.I)
_HDR_SUBJ_RE = re.compile(r"^\s*\*?\s*(?:subject|objet|betreff|asunto|oggetto|الموضوع|тема)\s*:\s*(.*)$", re.I)
_HDR_ANY_RE = re.compile(
    r"^\s*\*?\s*(?:from|de|von|da|من|от|sent|date|envoyé|gesendet|enviado|datum|inviato|data|تاريخ الإرسال|التاريخ"
    r"|أرسل|отправлено|дата|to|à|an|para|إلى|кому|cc|bcc|subject|objet|betreff|asunto|oggetto|الموضوع|тема"
    r"|importance|priority)\s*:", re.I)


def quoted_cut(text: str, mode: str = "reply") -> int:
    """Offset where quoted history starts.

    ``mode="all"`` cuts at the first quote OR forward marker (use it for the company's own sent
    mail: only what we wrote counts). ``mode="reply"`` keeps forwarded content (a customer
    forwarding their client's RFQ is still customer-side text) and cuts at reply quotes.
    Returns ``len(text)`` when nothing is quoted.
    """
    if not text:
        return 0
    lines = text.splitlines(keepends=True)
    offsets = []
    pos = 0
    for ln in lines:
        offsets.append(pos)
        pos += len(ln)
    n = len(lines)
    i = 0
    while i < n:
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        kind = None
        if _WROTE_RE.match(s) or _WROTE_AR_RE.match(s):
            kind = "reply"
        elif i + 1 < n and len(s) < 250 and re.match(r"^(?:on|am|le|el|في)\b", s, re.I) and (
                _WROTE_RE.match(s + " " + lines[i + 1].strip()) or _WROTE_AR_RE.match(s + " " + lines[i + 1].strip())):
            kind = "reply"
        elif _ORIGINAL_RE.match(s):
            kind = "reply"
        elif _FORWARD_RE.match(s):
            kind = "forward"
        elif _HDR_FROM_RE.match(s):
            window = [ln.strip() for ln in lines[i + 1:i + 7]]
            if any(_HDR_SENT_RE.match(w) for w in window):
                subj = next((m.group(1) for w in window for m in [_HDR_SUBJ_RE.match(w)] if m), "")
                kind = "forward" if re.match(r"\s*(?:fw|fwd|tr|wg|rv|إعادة توجيه)\s*:", subj, re.I) else "reply"
        elif s.startswith(">"):
            rest = [ln for ln in lines[i:] if ln.strip()]
            if len(rest) >= 2 and sum(1 for ln in rest if ln.lstrip().startswith(">")) >= 0.6 * len(rest):
                kind = "reply"
        if kind is None:
            i += 1
            continue
        if mode == "all" or kind == "reply":
            cut = offsets[i]
            # include an Outlook rule line ("_____") above the header in the cut
            j = i - 1
            while j >= 0 and not lines[j].strip():
                j -= 1
            if j >= 0 and re.fullmatch(r"[_\-=*]{8,}", lines[j].strip()):
                cut = offsets[j]
            return cut
        # forwarded content is kept: skip the forwarded message's own header block
        i += 1
        k = 0
        while i < n and k < 10 and (not lines[i].strip() or _HDR_ANY_RE.match(lines[i].strip())):
            i += 1
            k += 1
    return len(text)


def strip_quoted(text: str, mode: str = "reply") -> str:
    """``text`` without its quoted history (see :func:`quoted_cut`), right-stripped."""
    return (text or "")[:quoted_cut(text or "", mode)].rstrip()


# --------------------------------------------------------------------------------------------
# Signatures and contact details
# --------------------------------------------------------------------------------------------

CLOSING_RE = re.compile(
    r"(?im)^[ \t]*(?:best\s+regards|kind\s+regards|warm\s+regards|warmest\s+regards|regards|best\s+wishes|"
    r"many\s+thanks|thanks\s*(?:and|&)\s*(?:best\s+)?regards|thanks|thank\s+you|yours\s+(?:faithfully|sincerely|truly)|"
    r"sincerely|respectfully|cheers|with\s+regards|مع\s+(?:خالص\s+)?التحية(?:\s+والتقدير)?|مع\s+الشكر|"
    r"وتفضلوا\s+بقبول\s+فائق\s+الاحترام|تحياتي|وشكرا|с\s+уважением)\b[^\n]{0,40}$")
EMAIL_RE = re.compile(r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+")
URL_RE = re.compile(r"\bhttps?://[^\s<>\"')\]]+", re.I)
WEBSITE_RE = re.compile(r"\b(?:https?://)?www\.[\w-]+(?:\.[\w-]+)+(?:/[^\s<>\"')\]]*)?", re.I)
PHONE_LABELED_RE = re.compile(
    r"(?i)(?<![\w])(?P<label>tel(?:ephone)?|phone|ph|t|mob(?:ile)?|m|cell|fax|f|office|direct|hotline|whatsapp|"
    r"هاتف|تلفون|جوال|نقال|فاكس|тел|факс|моб)\b\.?\s*(?:no\.?)?\s*[:.]?\s*(?P<num>\+?\(?\d[\d\s().\-/]{5,}\d)")
PHONE_INTL_RE = re.compile(r"(?<![\w/+])(?:\+|00)\d{1,3}[\s\-.]?\(?\d{1,4}\)?(?:[\s\-.]?\d{2,5}){1,4}(?![\w/])")
LEGAL_SUFFIX_RE = re.compile(
    r"(?i)(?:\b(?:ltd|limited|llc|l\.l\.c|w\.l\.l|wll|co|company|corp|corporation|inc|gmbh|plc|fze|fzco|fz-llc|"
    r"k\.s\.c(?:\.c)?|k\.s\.c\.p|s\.p\.c|s\.a\.l|s\.a|b\.v|ag|spa|s\.r\.l|establishment|est|group|holding)\b\.?"
    r"|\bооо\b|\bао\b|\bзао\b|\bпао\b|شركة|مؤسسة|ذ\.?\s?م\.?\s?م|ش\.?\s?م\.?\s?ك)")
ADDRESS_RE = re.compile(
    r"(?i)(?:\bp\.?\s?o\.?\s?box\b|\bpost\s+box\b|\bpob\b|\bunit\s+\d|\bfloor\b|\bbuilding\b|\bbldg\b|\bblock\b|"
    r"\bstreet\b|\bst\.(?=\s|$)|\broad\b|\brd\.(?=\s|$)|\bavenue\b|\bave\.|\bplot\b|\bindustrial\s+area\b|"
    r"\bsafat\b|\boffice\s+no\.?\s*\d|"
    r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b|ص\.?\s?ب|شارع|مبنى|الدور|قطعة|ул\.|улица|дом\b)")
_PLAIN_ADDRESS_HINT_RE = re.compile(r"(?i)\b(?:kuwait|dubai|abu dhabi|doha|riyadh|jeddah|manama|muscat|london|leeds|"
                                    r"manchester|new york|moscow|cairo|amman|sharjah)\b")


def extract_signature(text: str, max_lines: int = 15) -> tuple[int, int] | None:
    """Span ``(start, end)`` of the signature block: lines after the last closing phrase, or the
    trailing lines that carry contact details. ``None`` when nothing signature-like is found."""
    if not text:
        return None
    cut = quoted_cut(text, "all")
    body = text[:cut]
    closing = None
    for m in CLOSING_RE.finditer(body):
        closing = m
    lines = _line_spans(body)
    if closing is not None:
        start = closing.start()
        idx = next((k for k, (s, e) in enumerate(lines) if s <= closing.start() <= e), len(lines))
        end_idx = min(len(lines), idx + 1 + max_lines)
        end = lines[end_idx - 1][1] if end_idx > 0 else len(body)
        s, e = _trim(text, start, end)
        return (s, e) if e > s else None
    tail = [ln for ln in lines[-max_lines:] if ln[1] > ln[0]]
    contact = [ln for ln in tail if _is_contact_line(text[ln[0]:ln[1]])]
    if len(contact) >= 2:
        s, e = _trim(text, contact[0][0], tail[-1][1])
        # pull up to two lines above the first contact line (name / title)
        k = lines.index(contact[0]) if contact[0] in lines else 0
        if k >= 2:
            s = _trim(text, lines[k - 2][0], e)[0]
        return (s, e) if e > s else None
    return None


def _is_contact_line(line: str) -> bool:
    return bool(EMAIL_RE.search(line) or WEBSITE_RE.search(line) or PHONE_LABELED_RE.search(line)
                or PHONE_INTL_RE.search(line) or ADDRESS_RE.search(line))


def is_contact_line(line: str) -> bool:
    """True for lines carrying a phone, e-mail, website or postal address."""
    return _is_contact_line(line)


def normalize_phone(raw: str) -> str:
    digits = re.sub(r"[^\d+]", "", raw or "")
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    return digits


def find_phones(text: str) -> list[tuple[str, str, int, int]]:
    """``[(label, normalised number, start, end)]`` - labelled numbers first, then international."""
    out: list[tuple[str, str, int, int]] = []
    taken: list[tuple[int, int]] = []
    for m in PHONE_LABELED_RE.finditer(text or ""):
        num = normalize_phone(m.group("num"))
        if 7 <= len(num.lstrip("+")) <= 15:
            label = m.group("label").lower()
            kind = "fax" if label in ("fax", "f", "فاكس", "факс") else "mobile" if label.startswith(("mob", "m", "cell", "جوال", "نقال", "моб", "whatsapp")) else "phone"
            out.append((kind, num, m.start("num"), m.end("num")))
            taken.append((m.start(), m.end()))
    for m in PHONE_INTL_RE.finditer(text or ""):
        if any(s <= m.start() < e for s, e in taken):
            continue
        num = normalize_phone(m.group(0))
        if 8 <= len(num.lstrip("+")) <= 15:
            out.append(("phone", num, m.start(), m.end()))
    return out


# --------------------------------------------------------------------------------------------
# Domains
# --------------------------------------------------------------------------------------------

FREE_MAIL_DOMAINS = frozenset(
    {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
     "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "gmx.de",
     "mail.com", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "rediffmail.com",
     "hotmail.co.uk", "outlook.sa", "hotmail.fr", "yahoo.co.uk", "yahoo.fr", "inbox.ru", "bk.ru", "list.ru"}
)
_SLD = frozenset({"co", "com", "gov", "org", "net", "ac", "edu", "mil", "gob", "gouv", "or", "ne", "go", "nic", "sch"})


def email_domain(address: str | None) -> str:
    if not address or "@" not in address:
        return ""
    return address.rsplit("@", 1)[1].strip().strip(">").lower()


def host_of(url: str | None) -> str:
    if not url:
        return ""
    u = url if "://" in url else "http://" + url
    try:
        host = urlsplit(u).hostname or ""
    except ValueError:
        return ""
    return host.lower().rstrip(".")


def registrable_domain(host_or_url: str | None) -> str:
    """``news.example.co.uk`` -> ``example.co.uk``; ``www.contractor-kw.example`` -> ``contractor-kw.example``."""
    host = host_of(host_or_url) if host_or_url and ("/" in host_or_url or ":" in host_or_url) else (host_or_url or "").lower()
    host = host.strip(".")
    if host.startswith("www."):
        host = host[4:]
    parts = [p for p in host.split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    if len(parts[-1]) == 2 and parts[-2] in _SLD:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def same_site(a: str | None, b: str | None) -> bool:
    ra, rb = registrable_domain(a), registrable_domain(b)
    return bool(ra) and ra == rb


def domain_matches(domain: str, own_domains: Iterable[str]) -> bool:
    """True when ``domain`` equals or is a subdomain of one of ``own_domains``."""
    d = (domain or "").lower().strip().lstrip("@")
    if not d:
        return False
    for o in own_domains:
        o = (o or "").lower().strip().lstrip("@")
        if o and (d == o or d.endswith("." + o)):
            return True
    return False
