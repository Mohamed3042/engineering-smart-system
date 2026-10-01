"""Quotation terms the customer asked for.

Templates carry default terms (validity "One month.", contract period "One year", spare parts
"Excluded"…). When the customer's own mail asks for something else — "validity of the offer: 120
days", "comprehensive O&M with spares for 36 months" — the request is recorded in
``data["term_changes"]`` with the customer's sentence as evidence. A detected request is not an
agreed term: the quotation keeps the template wording until a person accepts the requested wording,
keeps the template wording with a reason, or asks the customer to clarify. Nothing here ever
writes a price.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Iterable, Optional

from ..ai.guards import redact_prices

# Decisions a person can take on a requested term, and the status each one records.
DECISIONS = {"accept": "accepted", "retain": "retained", "clarify": "clarification"}
# Statuses that still block approval: nobody has agreed the term yet.
OPEN_STATUSES = ("pending", "clarification")

_DAYS_FROM = r"(?:\s+(?:from|after)\s+(?:the\s+)?(?P<anchor>(?:tender\s+|bid\s+)?(?:closing|submission|opening)\s+date|date\s+of\s+(?:submission|closing|opening)))?"

_VALIDITY = [
    re.compile(r"validity\s+of\s+(?:your|the|our)?\s*(?:offers?|quotations?|bids?|proposals?|prices?)\s*"
               r"(?:to\s+be|shall\s+be|should\s+be|must\s+be|is|:|-)?\s*(?:a\s+minimum\s+of\s+|at\s+least\s+)?"
               r"(?P<n>\d{2,3})\s*(?:\(\w+\)\s*)?(?:calendar\s+)?days" + _DAYS_FROM, re.I),
    re.compile(r"(?:offers?|quotations?|bids?|proposals?|prices?)\s+(?:shall|should|must|to)\s+(?:be\s+|remain\s+)valid\s+"
               r"(?:for\s+)?(?:a\s+(?:minimum|period)\s+of\s+|at\s+least\s+)?(?P<n>\d{2,3})\s*(?:calendar\s+)?days" + _DAYS_FROM, re.I),
    re.compile(r"validity(?:\s+period)?\s*[:\-–]\s*(?P<n>\d{2,3})\s*(?:calendar\s+)?days" + _DAYS_FROM, re.I),
]

_PERIOD = [
    re.compile(r"contract\s+(?:period|duration)\s*(?:of|:|-|–|is|shall\s+be)?\s*(?P<n>\d{1,3})\s*(?P<unit>months?|years?)"
               r"(?P<from>\s+from\s+[^,.;\n]{3,40})?", re.I),
    re.compile(r"(?:o\s*&\s*m|operation\s+and\s+maintenance|maintenance(?:\s+contract)?)\b[^.\n]{0,60}?\b(?:for|of|period\s+of)\s+"
               r"(?P<n>\d{1,3})\s*(?P<unit>months?|years?)", re.I),
]

_SPARES = re.compile(r"comprehensive\b[^.\n]{0,50}?\bwith\s+spares\b|\b(?:including|inclusive\s+of)\s+(?:all\s+)?spare\s*parts\b|"
                     r"\bspare\s*parts\s+(?:to\s+be\s+|are\s+|shall\s+be\s+)?included\b", re.I)


def _sentence(text: str, start: int, end: int) -> str:
    """The source line around a match, verbatim (bullets and list markers trimmed)."""
    lo = max(text.rfind("\n", 0, start), text.rfind(". ", 0, start) + 1 if text.rfind(". ", 0, start) >= 0 else -1) + 1
    hi_candidates = [i for i in (text.find("\n", end), text.find(". ", end)) if i >= 0]
    hi = min(hi_candidates) if hi_candidates else len(text)
    return text[lo:hi].strip().lstrip("*-•–·0123456789) ").strip()


def detect_term_requirements(sources: dict[str, str]) -> list[dict]:
    """Term requirements stated in the customer's text: [{key, text, evidence}] (first occurrence wins)."""
    found: dict[str, dict] = {}

    def add(key: str, text: str, source_id: str, body: str, m: re.Match) -> None:
        if key in found:
            return
        found[key] = {"key": key, "text": text,
                      "evidence": {"quote": _sentence(body, m.start(), m.end()), "source_type": "email",
                                   "source_id": source_id, "verified": True}}

    for source_id, body in sources.items():
        if not body:
            continue
        for rx in _VALIDITY:
            m = rx.search(body)
            if m:
                anchor = (m.groupdict().get("anchor") or "").strip().lower()
                anchor = re.sub(r"\s+", " ", anchor)
                text = f"{m['n']} days from the {anchor}." if anchor else f"{m['n']} days."
                add("validity", text, source_id, body, m)
                break
        for rx in _PERIOD:
            m = rx.search(body)
            if m:
                unit = m["unit"].lower()
                n = int(m["n"])
                unit = unit if unit.endswith("s") or n == 1 else unit + "s"
                frm = re.sub(r"\s+", " ", (m.groupdict().get("from") or "")).rstrip()
                add("contract_period", f"{n} {unit}{frm}", source_id, body, m)
                break
        m = _SPARES.search(body)
        if m:
            add("spare_parts", "Included — comprehensive maintenance with spare parts, as requested "
                               "(spare-parts coverage to be confirmed by the engineer).", source_id, body, m)
    return list(found.values())


def _quote_in(quote: str, sources: Iterable[str]) -> bool:
    q = " ".join(quote.split()).lower()
    return bool(q) and any(q in " ".join((s or "").split()).lower() for s in sources)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_term_requests(data: dict, proposals: list[dict], *, actor: str,
                         sources: Optional[dict[str, str]] = None, enquiry_id: Optional[str] = None) -> dict:
    """Record the customer's requested terms in a quotation's ``data`` (in place), as pending requests.

    Each proposal: {key, text, evidence?: {quote, source_id?}}. A request is recorded only when its text
    carries no price, the template has that term and, when ``sources`` is given, its evidence quote is
    found word for word in them. The agreed term text (``data["terms"]``) never changes here. A request
    identical to one already recorded keeps its decision; a different wording replaces it as pending.
    Returns {"recorded": [...], "rejected": [{key, reason}]}.
    """
    terms = {t.get("key"): t for t in (data.get("terms") or []) if isinstance(t, dict) and t.get("key")}
    changes = [dict(c) for c in (data.get("term_changes") or []) if isinstance(c, dict)]
    recorded, rejected = [], []
    for prop in proposals or []:
        key = str(prop.get("key") or "").strip()
        text = str(prop.get("text") or "").strip()
        if not key or not text:
            rejected.append({"key": key, "reason": "key and text are required"})
            continue
        _, mentions = redact_prices(text)
        if mentions:
            rejected.append({"key": key, "reason": "terms must not contain prices"})
            continue
        evidence = prop.get("evidence") if isinstance(prop.get("evidence"), dict) else None
        if sources is not None:
            if not evidence or not evidence.get("quote"):
                rejected.append({"key": key, "reason": "quote the customer's sentence that asks for this term"})
                continue
            if not _quote_in(evidence["quote"], sources.values()):
                rejected.append({"key": key, "reason": "quote not found in the project's mail"})
                continue
            evidence = {**evidence, "verified": True}
        term = terms.get(key)
        if term is None:
            rejected.append({"key": key, "reason": "this template has no such term"})
            continue
        current = (term.get("text") or "").strip()
        known = next((c for c in changes if c.get("key") == key), None)
        if current == text or (known and known.get("to") == text):
            continue  # already the agreed wording, or this exact request is already recorded
        change = {"key": key, "label": term.get("label") or key, "from": term.get("text") or "", "to": text,
                  "by": actor, "evidence": evidence, "enquiry_id": enquiry_id, "status": "pending",
                  "detected_at": _now()}
        changes = [c for c in changes if c.get("key") != key] + [change]
        recorded.append(change)
    data["term_changes"] = changes
    return {"recorded": recorded, "rejected": rejected}


def record_requested_terms(data: dict, sources: dict[str, str], *, actor: str = "rules",
                           enquiry_id: Optional[str] = None) -> list[dict]:
    """Detect term requirements in ``sources`` and record those the template has a term for."""
    return record_term_requests(data, detect_term_requirements(sources), actor=actor,
                                enquiry_id=enquiry_id)["recorded"]


def open_term_requests(data: dict) -> list[dict]:
    """Requested terms nobody has agreed yet (older drafts carry no status: pending)."""
    return [c for c in (data.get("term_changes") or [])
            if isinstance(c, dict) and c.get("status", "pending") in OPEN_STATUSES]


def decide_term_change(data: dict, key: str, decision: str, *, actor: str, revision: str, reason: str = "") -> bool:
    """A person's decision on one requested term, recorded with who, when and the quotation revision.

    accept → the requested wording becomes the term; retain (reason required) and clarify keep the
    template wording. Returns True when the agreed term text changed. Raises LookupError for an unknown
    request, ValueError for a bad decision or a missing reason.
    """
    if decision not in DECISIONS:
        raise ValueError("decision must be accept, retain or clarify")
    reason = (reason or "").strip()
    if decision == "retain" and not reason:
        raise ValueError("say why the template wording stays")
    changes = [dict(c) for c in (data.get("term_changes") or []) if isinstance(c, dict)]
    change = next((c for c in changes if c.get("key") == key), None)
    term = next((t for t in (data.get("terms") or []) if isinstance(t, dict) and t.get("key") == key), None)
    if change is None or term is None:
        raise LookupError(key)
    current = term.get("text") or ""
    # keep/clarify only undo an earlier acceptance; a person's own edit of the term stays as it is
    text = change["to"] if decision == "accept" else (change.get("from", "") if current == change["to"] else current)
    changed = current != text
    data["terms"] = [{**t, "text": text} if t is term else t for t in data["terms"]]
    change.update(status=DECISIONS[decision], decided_by=actor, decided_at=_now(), revision=revision, reason=reason)
    data["term_changes"] = [change if c.get("key") == key else c for c in changes]
    return changed


__all__ = ["detect_term_requirements", "record_term_requests", "record_requested_terms", "open_term_requests",
           "decide_term_change", "DECISIONS"]
