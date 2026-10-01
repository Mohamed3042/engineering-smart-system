"""Deterministic guards applied to every AI answer.

These functions never call a model. ``ess.ai.tasks`` runs them on every result before returning
it, so callers (pipeline, REST API, MCP server) cannot skip them:

* :func:`validate_schema`  – JSON-schema validation (draft 2020-12, ``format: date`` checked).
* :func:`verify_evidence`  – every ``evidence`` quote must exist verbatim in its source text
  (normalised for case, whitespace, smart quotes, dashes and Arabic spelling variants; a
  rapidfuzz ``partial_ratio >= 97`` fallback tolerates PDF hyphenation noise on long quotes).
  Facts whose quote is not found are flagged ``verified: false`` – never silently kept.
* :func:`strip_prices`     – removes ``unit_price``/``total``/``amount``/``rate``/``price``…
  values produced by AI (and, on request, currency amounts inside free text).
* :func:`numbers_in` / :func:`date_supported` – a number or date the model reports must be
  readable in the quote it cites ("qty 6" needs a quote containing 6 or "six").
"""
from __future__ import annotations

import functools
import json
import re
import unicodedata
from typing import Any, Iterable

from rapidfuzz import fuzz

# --------------------------------------------------------------------------------------------
# Text normalisation (used for evidence matching and keyword rules)
# --------------------------------------------------------------------------------------------

_DROP_CHARS = frozenset(
    "ـ"  # Arabic tatweel (kashida)
    "​‌‍⁠﻿­"  # zero-width chars, BOM, soft hyphen
    "‎‏؜‪‫‬‭‮⁦⁧⁨⁩"  # bidi marks
)

_CHAR_MAP: dict[str, str] = {
    # quotes and primes
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "´": "'", "`": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "«": '"', "»": '"',
    # dashes and minus
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
    "⁃": "-", "﹘": "-", "﹣": "-", "－": "-",
    # Arabic punctuation
    "،": ",", "؛": ";", "؟": "?", "٫": ".", "٬": ",", "٪": "%", "۔": ".",
    # Arabic letter variants -> base letters
    "آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا", "ٲ": "ا",
    "ٳ": "ا",
    "ى": "ي",  # alef maqsura -> ya
    "ة": "ه",  # ta marbuta -> ha
    "ؤ": "و",  # waw with hamza -> waw
    "ئ": "ي",  # ya with hamza -> ya
    "ک": "ك",  # Persian kaf
    "ی": "ي", "ے": "ي",  # Persian / Urdu ya
    "ہ": "ه", "ھ": "ه",  # heh variants
}
# Arabic-Indic and Eastern Arabic-Indic digits -> ASCII
for _i in range(10):
    _CHAR_MAP[chr(0x0660 + _i)] = str(_i)
    _CHAR_MAP[chr(0x06F0 + _i)] = str(_i)

_DIGIT_TABLE = str.maketrans({chr(0x0660 + i): str(i) for i in range(10)} | {chr(0x06F0 + i): str(i) for i in range(10)})


@functools.lru_cache(maxsize=8192)
def _fold_char(c: str) -> str:
    """Normalise one character. May return "", one char or several chars."""
    if c in _DROP_CHARS:
        return ""
    mapped = _CHAR_MAP.get(c)
    if mapped is not None:
        return mapped
    if c.isspace():
        return " "
    out: list[str] = []
    for ch in unicodedata.normalize("NFKD", c):
        if unicodedata.category(ch) == "Mn":  # combining marks: accents, Arabic harakat, shadda, madda
            continue
        if ch in _DROP_CHARS:
            continue
        ch = _CHAR_MAP.get(ch, ch)
        out.append(" " if ch.isspace() else ch)
    return "".join(out).casefold()


def normalize_with_map(text: str) -> tuple[str, list[int]]:
    """Return (normalised text, index map). ``index_map[i]`` is the position in ``text`` of
    normalised character ``i`` – used to cut verbatim quotes back out of the original."""
    chars: list[str] = []
    index: list[int] = []
    prev_space = True  # drops leading whitespace
    for i, c in enumerate(text or ""):
        for ch in _fold_char(c):
            if ch == " ":
                if prev_space:
                    continue
                prev_space = True
            else:
                prev_space = False
            chars.append(ch)
            index.append(i)
    if chars and chars[-1] == " ":
        chars.pop()
        index.pop()
    return "".join(chars), index


def normalize_text(text: str | None) -> str:
    """Casefold, collapse whitespace, unify quotes/dashes/digits and Arabic spelling variants
    (diacritics, tatweel, alef/hamza forms, alef maqsura, ta marbuta)."""
    return normalize_with_map(text or "")[0]


class NormalizedSource:
    """A source text normalised once and searched many times."""

    __slots__ = ("raw", "norm", "index")

    def __init__(self, raw: str | None) -> None:
        self.raw = raw or ""
        self.norm, self.index = normalize_with_map(self.raw)

    def span(self, start: int, end: int) -> tuple[int, int]:
        return self.index[start], self.index[end - 1] + 1


def find_quote(source: str | NormalizedSource | None, quote: str | None, *,
               fuzzy_threshold: float = 97.0, min_chars: int = 3) -> dict | None:
    """Locate ``quote`` in ``source``. Returns ``{start, end, text, method, score}`` where
    ``text`` is the verbatim original span, or ``None`` when the quote is not in the source."""
    if not quote or source is None:
        return None
    src = source if isinstance(source, NormalizedSource) else NormalizedSource(source)
    if not src.norm:
        return None
    q = normalize_text(quote)
    if len(q.replace(" ", "")) < min_chars:
        return None
    pos = src.norm.find(q)
    if pos >= 0:
        start, end = src.span(pos, pos + len(q))
        return {"start": start, "end": end, "text": src.raw[start:end], "method": "exact", "score": 100.0}
    # Fuzzy fallback only for long quotes (short ones must match exactly) and never for a quote
    # longer than the source itself.
    if len(q) >= 12 and len(q) <= len(src.norm) and fuzzy_threshold <= 100:
        al = fuzz.partial_ratio_alignment(q, src.norm, score_cutoff=fuzzy_threshold)
        if al is not None and al.score >= fuzzy_threshold and al.dest_end > al.dest_start:
            start, end = src.span(al.dest_start, al.dest_end)
            return {"start": start, "end": end, "text": src.raw[start:end], "method": "fuzzy",
                    "score": round(float(al.score), 1)}
    return None


def quote_in(source: str | None, quote: str | None, **kwargs: Any) -> bool:
    return find_quote(source, quote, **kwargs) is not None


# --------------------------------------------------------------------------------------------
# JSON schema validation
# --------------------------------------------------------------------------------------------

@functools.lru_cache(maxsize=256)
def _validator_for(schema_json: str):
    from jsonschema import Draft202012Validator, FormatChecker

    schema = json.loads(schema_json)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _json_path(parts: Iterable[Any]) -> str:
    out = "$"
    for p in parts:
        out += f"[{p}]" if isinstance(p, int) else f".{p}"
    return out


def validate_schema(data: Any, schema: dict) -> list[str]:
    """Validate ``data`` against ``schema``. Returns a list of readable errors (empty = valid)."""
    validator = _validator_for(json.dumps(schema, sort_keys=True))
    errors = sorted(validator.iter_errors(data), key=lambda e: [str(p) for p in e.absolute_path])
    return [f"{_json_path(e.absolute_path)}: {e.message}"[:400] for e in errors]


# --------------------------------------------------------------------------------------------
# Evidence verification
# --------------------------------------------------------------------------------------------

def _flag(node: dict, flag: str) -> None:
    flags = node.get("flags")
    if not isinstance(flags, list):
        flags = []
        node["flags"] = flags
    if flag not in flags:
        flags.append(flag)


def _is_unknown(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def verify_evidence(obj: Any, sources: dict[str, str | None], *, fuzzy_threshold: float = 97.0,
                    min_chars: int = 3) -> dict:
    """Walk ``obj`` and check every nested ``evidence`` object/list against ``sources``.

    * Each evidence item (``{"quote", "source"}``) gets ``verified: true|false``. When the quote is
      found in another source than the one cited, ``source`` is corrected (``source_claimed``
      keeps the model's claim).
    * Each *fact* (a dict holding an ``evidence`` key) gets ``verified`` = all its quotes verified.
      Facts whose quotes are not found are flagged ``evidence_not_found``; facts with a value but
      no evidence are flagged ``no_evidence``. A fact whose ``value`` is null (unknown) and has no
      evidence gets ``verified: null`` – there is nothing to verify.

    Returns statistics including ``failures`` (path, quote, cited source) and ``all_verified``.
    """
    normed = {k: NormalizedSource(v) for k, v in (sources or {}).items()}
    stats: dict[str, Any] = {
        "facts": 0, "facts_verified": 0, "facts_unverified": 0, "facts_without_evidence": 0,
        "quotes": 0, "quotes_verified": 0, "quotes_failed": 0, "sources_corrected": 0,
        "fuzzy_matches": 0, "failures": [],
    }

    def check_item(item: dict, path: str) -> bool:
        stats["quotes"] += 1
        quote = item.get("quote")
        cited = item.get("source")
        item.pop("verified", None)
        if not isinstance(quote, str) or not quote.strip():
            item["verified"] = False
            stats["quotes_failed"] += 1
            stats["failures"].append({"path": path, "quote": quote, "source": cited, "why": "empty quote"})
            return False
        order = ([cited] if isinstance(cited, str) and cited in normed else []) + [k for k in normed if k != cited]
        for key in order:
            match = find_quote(normed[key], quote, fuzzy_threshold=fuzzy_threshold, min_chars=min_chars)
            if match:
                item["verified"] = True
                item["match"] = match["method"]
                if match["method"] == "fuzzy":
                    stats["fuzzy_matches"] += 1
                if key != cited:
                    if cited:
                        item["source_claimed"] = cited
                        stats["sources_corrected"] += 1
                    item["source"] = key
                stats["quotes_verified"] += 1
                return True
        item["verified"] = False
        stats["quotes_failed"] += 1
        why = "quote too short" if len(normalize_text(quote).replace(" ", "")) < min_chars else "quote not found in source"
        stats["failures"].append({"path": path, "quote": quote[:200], "source": cited, "why": why})
        return False

    def handle_fact(node: dict, path: str) -> None:
        ev = node.get("evidence")
        if isinstance(ev, dict):
            items = [ev]
        elif isinstance(ev, list):
            items = [x for x in ev if isinstance(x, dict)]
        else:
            items = []
        if not items:
            if "value" in node and _is_unknown(node.get("value")):
                node["verified"] = None
                return
            stats["facts"] += 1
            stats["facts_unverified"] += 1
            stats["facts_without_evidence"] += 1
            node["verified"] = False
            _flag(node, "no_evidence")
            return
        stats["facts"] += 1
        results = [check_item(it, f"{path}.evidence" + (f"[{i}]" if isinstance(ev, list) else ""))
                   for i, it in enumerate(items)]
        ok = all(results)
        node["verified"] = ok
        if ok:
            stats["facts_verified"] += 1
        else:
            stats["facts_unverified"] += 1
            _flag(node, "evidence_not_found")

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            if "evidence" in node:
                handle_fact(node, path)
            for k, v in node.items():
                if k != "evidence":
                    walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")

    walk(obj, "$")
    stats["all_verified"] = stats["quotes_failed"] == 0 and stats["facts_unverified"] == 0
    return stats


# --------------------------------------------------------------------------------------------
# Prices
# --------------------------------------------------------------------------------------------

_PRICE_KEY_RE = re.compile(
    r"^(?:unit_?)?(?:price|prices|rate|rates|cost|costs|amount|amounts|total|totals|subtotal|sub_total|"
    r"grand_total|net_total|total_price|total_amount|lump_sum|discount|vat_amount|price_kwd|price_usd)$"
    r"|_(?:price|prices|cost|costs|amount|amounts)$|^(?:price|cost)_",
    re.IGNORECASE,
)
_NOT_PRICE_HINT = re.compile(r"qty|quantity|count|token|percent|pct|ratio|score|confidence", re.IGNORECASE)
_TEXT_SKIP_KEYS = frozenset({"evidence", "quote", "source", "source_id", "source_label", "source_type",
                             "url", "transcription", "match", "source_claimed"})

_CUR = (r"(?:KWD|KD|K\.D\.?|USD|US\$|EUR|AED|SAR|QAR|BHD|OMR|GBP|INR|EGP|CNY|RMB|\$|€|£|¥|"
        r"د\.ك|دينار(?:\s+كويتي)?|دنانير|ريال|درهم|دولار|يورو)")
_NUM = r"(?:\d{1,3}(?:[,٬ ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
_SCALE = r"(?:\s?(?:k|m|mn|bn|million|thousand|lakh|ألف|الف|مليون)\b)?"
_PRICE_RE = re.compile(
    rf"(?<![A-Za-z]){_CUR}\s?{_NUM}{_SCALE}"
    rf"|{_NUM}{_SCALE}\s?{_CUR}(?![A-Za-z])"
    rf"|\b(?:unit\s+)?(?:price|cost)s?\s*(?:of|is|was|at|:|=)?\s*\d[\d,]{{2,}}(?:\.\d+)?",
    re.IGNORECASE,
)
PRICE_PLACEHOLDER = "[price removed]"


def is_price_key(key: str) -> bool:
    return bool(_PRICE_KEY_RE.search(key)) and not _NOT_PRICE_HINT.search(key)


def find_price_mentions(text: str | None) -> list[str]:
    """Currency amounts in free text ("KWD 18,500", "18500 د.ك", "price: 950")."""
    if not text:
        return []
    t = text.translate(_DIGIT_TABLE)
    return [m.group(0).strip() for m in _PRICE_RE.finditer(t)]


def redact_prices(text: str) -> tuple[str, list[str]]:
    """Replace currency amounts in ``text`` with a placeholder. Returns (new_text, mentions)."""
    t = text.translate(_DIGIT_TABLE)  # 1:1 char mapping, so spans line up with ``text``
    mentions: list[str] = []
    out: list[str] = []
    last = 0
    for m in _PRICE_RE.finditer(t):
        mentions.append(text[m.start():m.end()].strip())
        out.append(text[last:m.start()])
        out.append(PRICE_PLACEHOLDER)
        last = m.end()
    if not mentions:
        return text, []
    out.append(text[last:])
    return "".join(out), mentions


def strip_prices(obj: Any, *, scan_text: bool = False) -> list[dict]:
    """Null every AI-produced price field in ``obj`` (in place) and report what was removed.

    Keys like ``unit_price``, ``total``, ``amount``, ``rate``, ``price``, ``*_cost`` lose their
    value (they stay present as ``null`` – an engineer fills prices). With ``scan_text=True`` free
    text is also scanned and currency amounts are replaced by ``[price removed]``. Evidence quotes
    are never touched (they are verbatim copies of the source, not AI output)."""
    removed: list[dict] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key in list(node.keys()):
                value = node[key]
                p = f"{path}.{key}"
                if isinstance(key, str) and is_price_key(key):
                    if not _is_unknown(value):
                        removed.append({"path": p, "key": key, "value": value, "kind": "field"})
                    node[key] = None
                    continue
                if key in _TEXT_SKIP_KEYS:
                    continue
                if scan_text and isinstance(value, str):
                    new, mentions = redact_prices(value)
                    if mentions:
                        node[key] = new
                        removed.append({"path": p, "kind": "text", "mentions": mentions})
                else:
                    walk(value, p)
        elif isinstance(node, list):
            for i, value in enumerate(node):
                p = f"{path}[{i}]"
                if scan_text and isinstance(value, str):
                    new, mentions = redact_prices(value)
                    if mentions:
                        node[i] = new
                        removed.append({"path": p, "kind": "text", "mentions": mentions})
                else:
                    walk(value, p)

    walk(obj, "$")
    return removed


# --------------------------------------------------------------------------------------------
# Numbers and dates must be readable in the cited quote
# --------------------------------------------------------------------------------------------

_EN_NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
    "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100,
    "single": 1, "pair": 2, "dozen": 12,
}
# normalised spellings (alef/hamza and ta marbuta already folded by normalize_text)
_AR_NUMBER_WORDS = {
    "واحد": 1, "واحده": 1, "اثنان": 2, "اثنين": 2, "اثنتين": 2, "اثنتان": 2, "ثلاث": 3, "ثلاثه": 3,
    "اربع": 4, "اربعه": 4, "خمس": 5, "خمسه": 5, "ست": 6, "سته": 6, "سبع": 7, "سبعه": 7, "ثمان": 8,
    "ثماني": 8, "ثمانيه": 8, "تسع": 9, "تسعه": 9, "عشر": 10, "عشره": 10,
}
_NUM_TOKEN_RE = re.compile(r"\d+(?:[.,]\d+)*")
_MONTHS = {
    1: ("january", "jan", "يناير", "كانون الثاني"), 2: ("february", "feb", "فبراير", "شباط"),
    3: ("march", "mar", "مارس", "اذار"), 4: ("april", "apr", "ابريل", "نيسان"), 5: ("may", "مايو", "ايار"),
    6: ("june", "jun", "يونيو", "حزيران"), 7: ("july", "jul", "يوليو", "تموز"),
    8: ("august", "aug", "اغسطس", "اب"), 9: ("september", "sept", "sep", "سبتمبر", "ايلول"),
    10: ("october", "oct", "اكتوبر", "تشرين الاول"), 11: ("november", "nov", "نوفمبر", "تشرين الثاني"),
    12: ("december", "dec", "ديسمبر", "كانون الاول"),
}


def _parse_number_token(tok: str) -> list[float]:
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", tok):
        return [float(tok.replace(",", ""))]
    if "," in tok and "." not in tok:
        parts = tok.split(",")
        vals = [float(p) for p in parts if p]
        try:
            vals.append(float(tok.replace(",", ".")))
        except ValueError:
            pass
        return vals
    try:
        return [float(tok)]
    except ValueError:
        return [float(p) for p in re.split(r"[.,]", tok) if p]


def numbers_in(text: str | None) -> set[float]:
    """Every number readable in ``text``: digits (Arabic-Indic too, thousands separators,
    decimals) and simple number words in English and Arabic."""
    norm = normalize_text(text)
    values: set[float] = set()
    for tok in _NUM_TOKEN_RE.findall(norm):
        values.update(_parse_number_token(tok))
    for word in re.findall(r"[a-z]+(?:-[a-z]+)?|[؀-ۿ]+", norm):
        if word in _EN_NUMBER_WORDS:
            values.add(float(_EN_NUMBER_WORDS[word]))
        elif "-" in word:
            a, _, b = word.partition("-")
            if a in _EN_NUMBER_WORDS and b in _EN_NUMBER_WORDS:
                values.add(float(_EN_NUMBER_WORDS[a] + _EN_NUMBER_WORDS[b]))
        else:
            base = word[1:] if word[:1] in ("و", "ب", "ل") and word[1:] in _AR_NUMBER_WORDS else word
            if base in _AR_NUMBER_WORDS:
                values.add(float(_AR_NUMBER_WORDS[base]))
    return values


def number_supported(value: Any, text: str | None) -> bool:
    """True when every number in ``value`` (a number or a string such as "1.40 m") can be read
    in ``text``. Values without digits are trivially supported."""
    if value is None or isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        wanted = {float(value)}
    else:
        wanted = set()
        for tok in _NUM_TOKEN_RE.findall(normalize_text(str(value))):
            wanted.update(_parse_number_token(tok)[:1])
    if not wanted:
        return True
    have = numbers_in(text)
    return all(any(abs(w - h) < 1e-9 for h in have) for w in wanted)


def date_supported(iso_date: str | None, text: str | None) -> bool:
    """True when the day of ``iso_date`` and its month (number or name, EN/AR) appear in ``text``."""
    if not iso_date:
        return True
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", str(iso_date).strip())
    if not m:
        return False
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    have = numbers_in(text)
    if float(day) not in have:
        return False
    norm = normalize_text(text)
    month_named = any(re.search(rf"(?<![a-z؀-ۿ]){re.escape(normalize_text(name))}", norm)
                      for name in _MONTHS[month])
    del year  # the year is often omitted in quotes ("closing 15 Nov"); day + month must be there
    return month_named or float(month) in have
