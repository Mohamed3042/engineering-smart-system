"""Quotation terms the customer asked for.

Templates carry default terms (validity "One month.", contract period "One year", spare parts
"Excluded"…). When the customer's own mail asks for something else — "validity of the offer: 120
days", "comprehensive O&M with spares for 36 months" — the draft must follow the request, with the
customer's sentence as evidence. Changes are recorded in ``data["term_changes"]`` so the engineer
sees what differs from the template and why. Nothing here ever writes a price.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

from ..ai.guards import redact_prices

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


def apply_term_proposals(data: dict, proposals: list[dict], *, actor: str,
                         sources: Optional[dict[str, str]] = None, append_unknown: bool = False) -> dict:
    """Apply term changes to a quotation's ``data`` (in place).

    Each proposal: {key, text, label?, evidence?: {quote, source_id?}}. A change is applied only when
    its text carries no price and, when ``sources`` is given, its evidence quote is found word for word
    in them. Returns {"applied": [...], "rejected": [{key, reason}]}.
    """
    terms = [dict(t) for t in (data.get("terms") or []) if isinstance(t, dict)]
    by_key = {t.get("key"): t for t in terms if t.get("key")}
    changes = [c for c in (data.get("term_changes") or []) if isinstance(c, dict)]
    applied, rejected = [], []
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
        term = by_key.get(key)
        if term is None:
            if not append_unknown:
                rejected.append({"key": key, "reason": "this template has no such term"})
                continue
            term = {"key": key, "label": prop.get("label") or key.replace("_", " ").capitalize(), "text": ""}
            terms.append(term)
            by_key[key] = term
        before = term.get("text") or ""
        if before.strip() == text:
            continue
        term["text"] = text
        changes = [c for c in changes if c.get("key") != key]
        change = {"key": key, "label": term.get("label") or key, "from": before, "to": text, "by": actor,
                  "evidence": evidence}
        changes.append(change)
        applied.append(change)
    data["terms"] = terms
    data["term_changes"] = changes
    return {"applied": applied, "rejected": rejected}


def apply_requested_terms(data: dict, sources: dict[str, str], *, actor: str = "rules") -> list[dict]:
    """Detect term requirements in ``sources`` and apply those the template has a term for."""
    result = apply_term_proposals(data, detect_term_requirements(sources), actor=actor)
    return result["applied"]


__all__ = ["detect_term_requirements", "apply_term_proposals", "apply_requested_terms"]
