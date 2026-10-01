"""Deterministic detection of tender changes in mail: closing dates, extensions, addenda, reminders.

Every detected change carries the verbatim sentence it came from, so the engineer can check it.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Optional

from dateutil import parser as dateparser

DATE = r"(\d{1,2}(?:st|nd|rd|th)?[\s/\-.](?:\d{1,2}|[A-Za-z]{3,9})['’]?[\s/\-.,]*\d{2,4})"

CLOSING = [
    re.compile(r"date\s+of\s+closing\s*:?[^\n]{0,40}?\(ie\s*(\d{1,2}/\d{1,2}/\d{4})\)", re.I),
    re.compile(r"(?:closing|submission|due|bid)\s+date\s*(?:is|:)?\s*(?:on\s+or\s+before\s+)?" + DATE, re.I),
    re.compile(r"(?:on\s+or\s+before|not\s+later\s+than|latest\s+by)\s+" + DATE, re.I),
]
EXTENDED = [
    re.compile(r"(?:closing|submission|due|tender)?\s*(?:date)?[^\n.]{0,60}?extended\s+(?:to|till|until|up\s*to)\s+" + DATE, re.I),
    re.compile(r"extended\s+(?:dated|date)?\s*(?:as\s+on|on)\s+" + DATE, re.I),
]
ADDENDUM = re.compile(r"\baddendum\s*(?:no\.?|number|#)?\s*[\(\-:]?\s*([0-9]{1,2}|[A-Z]{0,4}-?\d{1,2})\)?", re.I)
REMINDER = re.compile(r"\b(?:kind|gentle|friendly)?\s*reminder\b", re.I)
REVISION = re.compile(r"\b(?:rev(?:ision)?\.?\s*(?:no\.?)?\s*([A-Z]?\d{1,2}[A-Z]?))\b", re.I)


def parse_any_date(text: str) -> Optional[date]:
    cleaned = re.sub(r"(\d)(st|nd|rd|th)", r"\1", text).replace("'", " ").replace("’", " ")
    try:
        return dateparser.parse(cleaned, dayfirst=True, fuzzy=True).date()
    except (ValueError, OverflowError):
        return None


def _sentence(text: str, start: int, end: int) -> str:
    left = max(text.rfind("\n", 0, start), text.rfind(". ", 0, start))
    right_candidates = [i for i in (text.find("\n", end), text.find(". ", end)) if i != -1]
    right = min(right_candidates) if right_candidates else len(text)
    return text[left + 1:right + 1].strip()[:300]


def find_closing_date(text: str) -> Optional[tuple[date, str]]:
    for rx in CLOSING:
        m = rx.search(text or "")
        if m:
            d = parse_any_date(m.group(1))
            if d:
                return d, _sentence(text, m.start(), m.end())
    return None


def detect_changes(text: str, *, email_id: str, sent_at: Optional[str], current_due: Optional[date]) -> list[dict]:
    """Changes announced in one message body (quoted history should already be removed)."""
    body = text or ""
    changes: list[dict] = []
    for rx in EXTENDED:
        m = rx.search(body)
        if m:
            new = parse_any_date(m.group(1))
            if new and new != current_due:
                changes.append({
                    "kind": "deadline_changed", "title": "Closing date extended",
                    "old_value": current_due.isoformat() if current_due else None, "new_value": new.isoformat(),
                    "date": sent_at, "evidence": {"quote": _sentence(body, m.start(), m.end()),
                                                   "source_type": "email", "source_id": email_id}})
            break
    m = ADDENDUM.search(body)
    if m:
        changes.append({"kind": "addendum", "title": f"Addendum {m.group(1)} issued", "old_value": None,
                        "new_value": m.group(1), "date": sent_at,
                        "evidence": {"quote": _sentence(body, m.start(), m.end()), "source_type": "email",
                                     "source_id": email_id}})
    m = REMINDER.search(body[:600])
    if m and not changes:
        changes.append({"kind": "reminder", "title": "Customer sent a reminder", "old_value": None, "new_value": None,
                        "date": sent_at, "evidence": {"quote": _sentence(body, m.start(), m.end()),
                                                       "source_type": "email", "source_id": email_id}})
    return changes
