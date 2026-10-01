"""Customer monitoring: what is new about a customer since the last check.

``check_updates`` runs a few recency-limited searches, drops what was already seen (by normalised
URL hash, so tracking parameters or ``www.`` do not create duplicates), keeps results that are
actually about the customer, classifies them (news, project, tender, contract award, people) and
scores relevance higher when the text mentions one of OUR service families.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Iterable, Mapping, Sequence

from ess.customers.research import _as_result, _mentions, _search, name_variants, short_name
from ess.customers.search import normalize_url, parse_published, url_hash
from ess.knowledge.base import TermIndex
from ess.knowledge.text import FREE_MAIL_DOMAINS, registrable_domain

UPDATE_KINDS = ("news", "project", "tender", "contract_award", "people")
_KIND_CUES = {
    "contract_award": ["awarded", "award", "wins", "won", "secures", "secured", "signs contract", "signed a contract",
                       "contract worth", "contract valued", "ترسية", "فوز", "توقيع عقد", "يفوز"],
    "tender": ["tender", "rfq", "bid", "bidding", "prequalification", "pre-qualification", "invitation to tender",
               "مناقصة", "مناقصات", "ممارسة"],
    "project": ["project", "construction", "development", "launch", "launches", "tower", "phase", "groundbreaking",
                "ground-breaking", "handover", "مشروع", "إنشاء", "تطوير"],
    "people": ["appoints", "appointed", "appointment", "named as", "joins as", "has joined", "promoted", "new ceo",
               "chief executive", "managing director", "chairman", "تعيين", "يعين"],
}
_KIND_INDEX = TermIndex.from_phrases(_KIND_CUES, origin="update")
_KIND_PRIORITY = ("contract_award", "tender", "project", "people")


def _get(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        v = obj.get(n) if isinstance(obj, Mapping) else getattr(obj, n, None)
        if v not in (None, "", [], {}):
            return v
    return default


def _since(value: Any, now: datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    if value:
        try:
            d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return now - timedelta(days=30)


@lru_cache(maxsize=32)
def _terms_index(terms: tuple[str, ...]) -> TermIndex:
    return TermIndex.from_phrases({"ours": list(terms)}, origin="ours")


def _service_terms(our_services: Iterable[Any] | None, our_terms: Iterable[str] | None) -> tuple[str, ...]:
    words: list[str] = [str(t) for t in our_terms or [] if t]
    for s in our_services or []:
        words.append(str(_get(s, "label", default="") or ""))
        for field in ("synonyms", "terms", "keywords"):
            v = _get(s, field)
            if isinstance(v, Mapping):
                words += [str(x) for lst in v.values() for x in lst or []]
            elif isinstance(v, (list, tuple)):
                words += [str(x) for x in v]
    if not words:
        try:  # default: the work categories' vocabulary from the knowledge data
            from ess.knowledge.base import default_categories, term_index

            work = {c["key"] for c in default_categories() if c.get("is_work_type") and not c["key"].startswith("other")}
            words = [e.term for e in term_index().entries() if e.category in work]
        except Exception:
            words = []
    return tuple(sorted({w for w in words if w and len(w) >= 3}))


def classify_update(text: str) -> str:
    keys = {e.concept for m in _KIND_INDEX.find(text or "") for e in m.entries}
    return next((k for k in _KIND_PRIORITY if k in keys), "news")


def check_updates(customer: Any, provider: Any, since: Any = None, seen_urls: Iterable[str] | None = None, *,
                  our_services: Sequence[Any] | None = None, our_terms: Iterable[str] | None = None,
                  now: datetime | None = None, max_results: int = 10,
                  queries: Sequence[str] | None = None) -> list[dict[str, Any]]:
    """New items about ``customer`` since ``since``: ``[{kind, title, summary, url, url_hash, source,
    published_at, relevance, matched_terms}]`` sorted by relevance. ``seen_urls`` may hold raw URLs,
    normalised URLs or URL hashes from earlier checks."""
    now = now or datetime.now(timezone.utc)
    start = _since(since, now)
    days = max(1, math.ceil((now - start).total_seconds() / 86400))
    name = str(_get(customer, "name", default="") or "").strip()
    domain = str(_get(customer, "domain", default="") or "").lower().removeprefix("www.")
    if domain in FREE_MAIL_DOMAINS:
        domain = ""
    variants = name_variants(name, domain)
    if provider is None or not variants:
        return []
    seen: set[str] = set()
    for u in seen_urls or []:
        if not u:
            continue
        seen.add(str(u))
        if "/" in str(u) or "." in str(u):
            seen.add(normalize_url(str(u)))
            seen.add(url_hash(str(u)))
    base = f'"{short_name(name) or name}"' if name else domain
    country = str(_get(customer, "country", default="") or "")
    qs = list(queries) if queries else [f"{base} {country}".strip(), f"{base} project", f"{base} tender OR contract"]
    index = _terms_index(_service_terms(our_services, our_terms))
    out: dict[str, dict[str, Any]] = {}
    for i, q in enumerate(qs):
        try:
            results = [r for r in (_as_result(x) for x in _search(provider, {"q": q, "recency_days": days,
                                                                             "news": i == 0}, max_results)) if r]
        except Exception:
            continue
        for r in results:
            h = url_hash(r.url)
            if r.url in seen or normalize_url(r.url) in seen or h in seen or h in out:
                continue
            published = parse_published(r.published, now)
            if published and published < start.date().isoformat():
                continue
            text = f"{r.title}\n{r.snippet}"
            official = bool(domain) and registrable_domain(r.url) == registrable_domain(domain)
            in_title = _mentions(r.title, variants)
            if not (in_title or _mentions(text, variants) or official):
                continue
            kind = classify_update(text)
            matched = sorted({e.term for m in index.find(text) for e in m.entries}) if len(index) else []
            relevance = 0.3 + (0.25 if in_title else 0.15) + min(0.3, 0.15 * len(matched))
            relevance += 0.1 if kind in ("tender", "project", "contract_award") else 0.0
            if published and published >= (now - timedelta(days=30)).date().isoformat():
                relevance += 0.05
            out[h] = {"kind": kind, "title": r.title, "summary": (r.snippet or "")[:500], "url": r.url, "url_hash": h,
                      "source": r.source or getattr(provider, "name", "") or registrable_domain(r.url),
                      "site": registrable_domain(r.url), "published_at": published,
                      "relevance": round(min(1.0, relevance), 2), "matched_terms": matched}
    items = sorted(out.values(), key=lambda u: (u["published_at"] or "", u["url"]), reverse=True)
    items.sort(key=lambda u: -u["relevance"])  # stable: newest first among equally relevant items
    return items
