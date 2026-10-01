"""Deep customer profiling with achievable evidence standards.

``research_customer`` searches the web for one customer (name, domain, country), fetches the most
useful pages, and builds a profile of sections (overview, business lines, current and past
projects, news, people, relationship with us, opportunities). Every published claim cites at least
one source with a verbatim quote that was verified against the page text (or our own e-mail).

The standards are designed to be reachable for ordinary companies - most businesses have a thin
web presence, and a profile that is "mostly gaps" is still useful:

* ``basic``    - the company's identity is confirmed by ONE source: its official site, a registry
  or directory entry, or our own e-mails with them. Every section may be ``not_found``.
* ``standard`` - basic + every published claim cites >= 1 source with a verbatim quote. Key facts
  (what they do, size, current projects) aim for 2 independent sources, but 1 official source (their
  own site, a registry, or their e-mails to us) is accepted.
* ``deep``     - standard + news searched for the last 12 months + >= 2 independent sources for each
  current project shown as found.

Anything that misses its bar becomes a *gap* (with the reason), never a failure: the claim stays
visible as ``partial`` so a person can judge it. ``met_standard`` only fails when the identity
cannot be confirmed (or, for ``deep``, when the news search itself could not run).
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping, Sequence

from ess.customers.search import PageText, SearchResult, fetch_page_text, normalize_url, page_from_html
from ess.knowledge.ai_bridge import AITaskUnavailable, as_plain, call_ai_task
from ess.knowledge.base import TermIndex
from ess.knowledge.text import (
    FREE_MAIL_DOMAINS,
    extract_signature,
    find_verbatim,
    quote_in_text,
    registrable_domain,
    sentence_spans,
    squash,
)

log = logging.getLogger(__name__)

EVIDENCE_STANDARDS: dict[str, dict[str, Any]] = {
    "basic": {
        "label": "Basic",
        "summary": "Identity confirmed by one source (official site, registry, or our own e-mails); any section "
                   "may be 'not found'.",
        "identity_sources": 1,
        "identity_source_kinds": ["official", "registry", "directory", "own_email"],
        "claims_need_verbatim_quote": True,
        "verify_quotes_against_page": False,  # a search snippet may be quoted as shown
        "key_fact_target_sources": 1,
        "single_official_source_ok": True,
        "current_project_sources": 1,
        "news_window_days": None,
        "news_search_required": False,
        "max_queries": 3,
        "max_pages": 3,
        "unresolved_items": "gaps",
    },
    "standard": {
        "label": "Standard",
        "summary": "Basic + every published claim cites at least one source with a verbatim quote; key facts "
                   "(what they do, size, current projects) aim for two sources, one official source is "
                   "acceptable.",
        "identity_sources": 1,
        "identity_source_kinds": ["official", "registry", "directory", "own_email"],
        "claims_need_verbatim_quote": True,
        "verify_quotes_against_page": True,
        "key_fact_target_sources": 2,
        "single_official_source_ok": True,
        "current_project_sources": 1,
        "news_window_days": 365,
        "news_search_required": False,
        "max_queries": 6,
        "max_pages": 8,
        "unresolved_items": "gaps",
    },
    "deep": {
        "label": "Deep",
        "summary": "Standard + news searched for the last 12 months + at least two independent sources for "
                   "current projects.",
        "identity_sources": 1,
        "identity_source_kinds": ["official", "registry", "directory", "own_email"],
        "claims_need_verbatim_quote": True,
        "verify_quotes_against_page": True,
        "key_fact_target_sources": 2,
        "single_official_source_ok": True,
        "current_project_sources": 2,
        "news_window_days": 365,
        "news_search_required": True,
        "max_queries": 10,
        "max_pages": 14,
        "unresolved_items": "gaps",
    },
}

SECTIONS = ("overview", "business_lines", "projects_current", "projects_past", "news", "people",
            "relationship_with_us", "opportunities")
SECTION_LABELS = {"overview": "overview", "business_lines": "business lines", "projects_current": "current projects",
                  "projects_past": "past projects", "news": "news", "people": "people",
                  "relationship_with_us": "relationship with us", "opportunities": "opportunities"}
KEY_SECTIONS = ("overview", "business_lines", "projects_current")
SOURCE_KIND_CONFIDENCE = {"official": 0.7, "registry": 0.7, "own_email": 0.75, "news": 0.6, "directory": 0.5,
                          "other": 0.4}
OFFICIAL_KINDS = frozenset({"official", "registry", "own_email"})

REGISTRY_HOSTS = frozenset({
    "opencorporates.com", "company-information.service.gov.uk", "companieshouse.gov.uk", "moci.gov.kw",
    "kcci.org.kw", "kuwaitchamber.org.kw", "dubaichamber.com", "chamber.org.qa", "sec.gov", "bahrainchamber.org.bh",
    "chamber.om", "mc.gov.sa"})
DIRECTORY_HOSTS = frozenset({
    "linkedin.com", "kompass.com", "crunchbase.com", "zoominfo.com", "dnb.com", "zawya.com", "bloomberg.com",
    "yellowpages.com", "yellowpages.com.kw", "yellowpages.ae", "dubizzle.com", "glassdoor.com", "facebook.com",
    "instagram.com", "x.com", "twitter.com"})
_NEWS_HINTS = ("news", "times", "gazette", "reuters", "meed", "constructionweek", "arabianbusiness", "tradearabia",
               "thenational", "khaleejtimes", "gulfnews", "zawya", "arabtimes", "alqabas", "alrai", "aljarida",
               "alanba", "kuna", "wam.ae", "spa.gov.sa", "press", "media")
_COUNTRY_NAMES = {"KW": "Kuwait", "SA": "Saudi Arabia", "AE": "UAE", "QA": "Qatar", "BH": "Bahrain", "OM": "Oman",
                  "EG": "Egypt", "JO": "Jordan", "LB": "Lebanon", "IQ": "Iraq", "GB": "United Kingdom",
                  "UK": "United Kingdom", "US": "United States", "RU": "Russia", "IN": "India", "PK": "Pakistan",
                  "TR": "Turkey", "DE": "Germany", "FR": "France", "IT": "Italy", "ES": "Spain"}

_SECTION_CUES: dict[str, list[str]] = {
    "people": ["ceo", "chief executive", "chief executive officer", "managing director", "general manager",
               "chairman", "vice chairman", "founder", "co-founder", "president", "owner", "board of directors",
               "head of", "appointed", "joins as", "رئيس مجلس الإدارة", "المدير العام",
               "الرئيس التنفيذي", "مؤسس"],
    "projects_current": ["currently", "ongoing", "under construction", "is executing", "are executing", "executing",
                         "awarded", "has been awarded", "won", "wins", "signed", "contract for", "contract to",
                         "new project", "commenced", "will build", "is building", "underway", "under way",
                         "mobilised", "mobilized", "تنفيذ", "ترسية", "قيد التنفيذ", "توقيع عقد"],
    "projects_past": ["completed", "delivered", "handed over", "has built", "previous projects", "past projects",
                      "track record", "portfolio", "references include", "successfully completed", "أنجزت",
                      "مشاريع منجزة", "سابقة الأعمال"],
    "business_lines": ["specialise", "specialize", "specialised", "specialized", "specialist", "services include",
                       "our services", "we provide", "we offer", "provides", "offers", "activities", "divisions",
                       "products", "solutions", "engaged in", "core business", "operates in", "general contractor",
                       "contractor for", "متخصصة", "خدماتنا", "نقدم", "مجالات"],
    "overview": ["is a", "is an", "is one of", "leading", "established", "founded", "headquartered",
                 "registered", "group of companies", "تأسست", "شركة رائدة", "من الشركات"],
    "size": ["employees", "staff", "workforce", "engineers and", "paid capital", "paid-up capital", "capital of",
             "revenue", "turnover", "annual sales", "موظف", "رأس المال"],
}
_CUE_INDEX = TermIndex.from_phrases(_SECTION_CUES, origin="section")
_PAST_RE = re.compile(r"(?i)\b(?:completed|delivered|handed over|finished)\b")
_CURRENT_RE = re.compile(r"(?i)\b(?:currently|ongoing|under construction|underway|under way|is executing|"
                         r"are executing|now)\b")
_JUNK_RE = re.compile(r"(?i)cookie|privacy policy|all rights reserved|copyright|©|subscribe|sign in|log in|login|"
                      r"javascript|click here|read more|terms of use|newsletter|follow us|skip to")
_NAME_RE = re.compile(r"\b[A-Z][a-z'\-]+(?:\s+(?:[A-Z][a-z'\-]+|Al|al|bin|Bin|El|el|Abu|Abdul)){1,3}\b")
_RFQ_LINE_RE = re.compile(r"(?i)\b(?:rfq|request for quotation|tender|enquiry|inquiry|quotation for|quote for)\b|"
                          r"مناقصة|طلب عرض سعر")
_PROJECT_WORD_RE = re.compile(r"(?i)\b(?:project|tower|hospital|school|schools|complex|mall|building|centre|center|"
                              r"stadium|airport|hotel|villa|plant|campus|university)\b|مشروع|مجمع|مستشفى|مدارس|برج")
_TITLE_LINE_RE = re.compile(
    r"(?i)\b(?:engineer|manager|director|officer|estimator|surveyor|architect|coordinator|head|chairman|ceo|"
    r"president|procurement|purchasing|buyer|consultant|supervisor|executive)\b|مهندس|مدير|رئيس")


# --------------------------------------------------------------------------------------------
# Small records
# --------------------------------------------------------------------------------------------


@dataclass
class _Source:
    url: str
    title: str
    kind: str
    text: str
    verification: str  # page | snippet | own_email
    published: str | None
    retrieved_at: str
    site: str
    query: str | None = None
    date: str | None = None

    def ref(self, quote: str) -> dict[str, Any]:
        out = {"url": self.url, "quote": quote, "retrieved_at": self.retrieved_at, "title": self.title,
               "kind": self.kind, "verification": self.verification}
        if self.published:
            out["published"] = self.published
        if self.date:
            out["date"] = self.date
        return out


@dataclass
class _Claim:
    section: str
    text: str
    sources: list[dict[str, Any]] = field(default_factory=list)
    fact: str | None = None
    derived: bool = False
    origin: str = "rules"

    def add(self, src: dict[str, Any]) -> None:
        if all((s["url"], s["quote"]) != (src["url"], src["quote"]) for s in self.sources):
            self.sources.append(src)


def _get(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        v = obj.get(n) if isinstance(obj, Mapping) else getattr(obj, n, None)
        if v not in (None, "", [], {}):
            return v
    return default


def _iso_now(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _date(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# --------------------------------------------------------------------------------------------
# Customer identity helpers
# --------------------------------------------------------------------------------------------

_LEGAL_TAIL_RE = re.compile(
    r"(?i)[\s,]*(?:\(\s*[a-z.\s]+\s*\)|\b(?:ltd|limited|llc|l\.l\.c|w\.l\.l|wll|co|company|inc|gmbh|plc|k\.s\.c(?:\.c)?|"
    r"k\.s\.c\.p|s\.p\.c|general\s+trading(?:\s*(?:&|and)\s*contracting)?|est)\b\.?)[\s,.\-]*$")


_GENERIC_NAME_WORDS = frozenset({"contracting", "construction", "constructions", "contractors", "trading", "general",
                                 "engineering", "group", "company", "holding", "holdings", "international", "services",
                                 "industries", "enterprises", "corporation", "est", "establishment", "co", "and", "",
                                 "the"})


def short_name(name: str) -> str:
    out = (name or "").strip()
    for _ in range(4):
        new = _LEGAL_TAIL_RE.sub("", out).strip(" ,.-")
        if new == out:
            break
        out = new
    return out or (name or "").strip()


def name_variants(name: str, domain: str = "") -> list[str]:
    """Strings that identify the customer in a text: full and short name, acronym (when the domain
    confirms it) and the domain itself."""
    variants: list[str] = []
    if name:
        variants.append(name.strip())
        s = short_name(name)
        if s and s != name.strip():
            variants.append(s)
        words = [w for w in re.findall(r"[A-Za-z]+", s) if w.lower() not in ("and", "the", "of", "for")]
        label = registrable_domain(domain).split(".")[0].lower() if domain else ""
        if len(words) >= 3 and label:
            acro = "".join(w[0] for w in words).lower()
            if label.startswith(acro) and len(acro) >= 3:
                variants.append(acro.upper())
        # brand form used by the press: "Gulf Horizon" for "Gulf Horizon Contracting Co."
        brand_words = s.split()
        while brand_words and brand_words[-1].lower().strip(".,&") in _GENERIC_NAME_WORDS:
            brand_words.pop()
        brand = " ".join(brand_words)
        if brand and brand != s and (len(brand_words) >= 2 or (label and brand.lower().replace(" ", "") in label)):
            variants.append(brand)
    if domain and domain not in FREE_MAIL_DOMAINS:
        variants.append(registrable_domain(domain))
    return [v for v in dict.fromkeys(variants) if len(squash(v)) >= 3]


def _mentions(text: str, variants: Sequence[str]) -> bool:
    hay = f" {squash(text)} "
    return any(f" {squash(v)} " in hay for v in variants if squash(v))


def _site_kind(url: str, domain: str) -> str:
    site = registrable_domain(url)
    if domain and site and site == registrable_domain(domain):
        return "official"
    if site in REGISTRY_HOSTS:
        return "registry"
    if site in DIRECTORY_HOSTS:
        return "directory"
    if any(h in site for h in _NEWS_HINTS):
        return "news"
    return "other"


# --------------------------------------------------------------------------------------------
# Own evidence (our e-mails with the customer)
# --------------------------------------------------------------------------------------------


def _own_docs(own_evidence: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Normalise ``own_evidence`` (list of e-mail/evidence dicts, or a dict with emails/projects/
    tags/opportunities) into documents + extras."""
    extras: dict[str, Any] = {}
    items: list[Any] = []
    if isinstance(own_evidence, Mapping):
        items = list(own_evidence.get("emails") or own_evidence.get("evidence") or [])
        for k in ("projects", "tags", "opportunities", "notes"):
            if own_evidence.get(k):
                extras[k] = own_evidence[k]
    elif own_evidence:
        items = list(own_evidence)
    docs = []
    for i, it in enumerate(items):
        if isinstance(it, str):
            it = {"text": it}
        text = str(_get(it, "text", "body_text", "body", "snippet", "quote", default="") or "")
        subject = str(_get(it, "subject", "title", default="") or "")
        if subject and subject not in text:
            text = f"{subject}\n{text}"
        if not text.strip():
            continue
        ident = _get(it, "id", "email_id")
        url = str(_get(it, "url", "view_url", default="") or (f"mail:{ident}" if ident else "")
                  or _get(it, "source", default="") or f"own:{i + 1}")
        when = _get(it, "date", "received_at")
        docs.append({"url": url, "text": text, "title": subject or str(_get(it, "source", default="Our e-mail")),
                     "date": when.isoformat() if isinstance(when, datetime) else (str(when) if when else None)})
    return docs, extras


def _signature_people(doc: dict[str, Any]) -> list[tuple[str, str]]:
    """``[(claim text, verbatim quote)]`` for name + title lines in an e-mail signature."""
    text = doc["text"]
    span = extract_signature(text)
    if not span:
        return []
    lines = [ln.strip() for ln in text[span[0]:span[1]].splitlines()]
    out = []
    for name, title in zip(lines, lines[1:]):
        if not name or not title or len(title.split()) > 8 or "@" in name or re.search(r"\d", name):
            continue
        person = re.fullmatch(r"(?:(?:Mr|Mrs|Ms|Dr|Eng|Engr)\.?\s+)?[A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*){1,3}", name) \
            or re.fullmatch(r"[\u0600-\u06ff]+(?:\s+[\u0600-\u06ff]+){1,3}", name)
        if person and _TITLE_LINE_RE.search(title) and not _TITLE_LINE_RE.search(name):
            quote = find_verbatim(f"{name}\n{title}", text)
            if quote:
                out.append((f"{name} - {title}", quote))
    return out[:2]


# --------------------------------------------------------------------------------------------
# Deterministic extraction
# --------------------------------------------------------------------------------------------


def _informative(sentence: str) -> bool:
    s = sentence.strip()
    if not 30 <= len(s) <= 420 or len(s.split()) < 5 or _JUNK_RE.search(s):
        return False
    letters = sum(ch.isalpha() for ch in s)
    return letters / max(1, len(s)) >= 0.55


def _classify(sentence: str) -> tuple[str | None, bool]:
    """(primary section, mentions size)"""
    keys = {e.concept for m in _CUE_INDEX.find(sentence) for e in m.entries}
    size = "size" in keys
    if "people" in keys and _NAME_RE.search(sentence):
        return "people", size
    if "projects_current" in keys and "projects_past" in keys:
        return ("projects_current" if _CURRENT_RE.search(sentence) else "projects_past"), size
    for sec in ("projects_current", "projects_past", "business_lines", "overview"):
        if sec in keys:
            return sec, size
    return ("overview" if size else None), size


def _extract_from_source(src: _Source, variants: Sequence[str], out: list[_Claim]) -> None:
    text = src.text
    own_site = src.kind in ("official", "own_email")
    for s, e in sentence_spans(text):
        sent = text[s:e].strip()
        if not _informative(sent):
            continue
        if not own_site and not _mentions(sent, variants):
            continue
        section, size = _classify(sent)
        if section is None:
            continue
        if section == "people" and src.kind == "other":
            continue
        out.append(_Claim(section, sent, [src.ref(sent)], fact="size" if size and section == "overview" else None))
        if size and section != "overview":
            out.append(_Claim("overview", sent, [src.ref(sent)], fact="size"))


def _news_claims(src: _Source, variants: Sequence[str], window_start: datetime | None, out: list[_Claim]) -> None:
    published = _date(src.published)
    if window_start is not None and published is not None and published < window_start:
        return
    title = src.title.strip()
    if title and _mentions(f"{title}\n{src.text[:600]}", variants) and len(title) >= 15:
        out.append(_Claim("news", title, [src.ref(title)]))


_PROJECT_NAME_RE = re.compile(
    r"((?:[A-Z][\w'\-]+\s+){0,4}(?:Tower|Towers|Hospital|Mall|School|Schools|Complex|Stadium|Airport|Hotel|"
    r"University|Bridge|Plant|Refinery|Centre|Center|Residences|Residence|Campus|Terminal|Headquarters|Building)"
    r"(?:\s+(?:[A-Z][\w'\-]+|extension|expansion|project|phase\s+\d+)){0,3})")
_PROJECT_STOP = {"the", "new", "our", "a", "an", "rfq", "re", "fw", "fwd", "tender", "for", "project", "extension",
                 "expansion"}


def project_key(text: str) -> str | None:
    """The project a sentence is about ("Jahra Hospital extension" -> "jahra hospital"), if named."""
    for m in _PROJECT_NAME_RE.finditer(text or ""):
        words = [w for w in squash(m.group(1)).split() if w not in _PROJECT_STOP]
        if len(words) >= 2:
            return " ".join(words)
    return None


def _merge(claims: list[_Claim]) -> list[_Claim]:
    try:
        from rapidfuzz import fuzz
    except Exception:  # pragma: no cover
        fuzz = None
    merged: list[_Claim] = []
    for c in claims:
        key = squash(c.text)
        pkey = project_key(c.text) if c.section in ("projects_current", "projects_past") else None
        target = None
        for m in merged:
            if m.section != c.section:
                continue
            mk = squash(m.text)
            if mk == key or (fuzz is not None and len(key) > 30 and fuzz.ratio(mk, key) >= 90) or (
                    pkey is not None and project_key(m.text) == pkey):
                target = m
                break
        if target is None:
            merged.append(c)
        else:
            for s in c.sources:
                target.add(s)
            target.fact = target.fact or c.fact
    return merged


# --------------------------------------------------------------------------------------------
# AI path (ess.ai.tasks.research_customer), verified quote by quote
# --------------------------------------------------------------------------------------------

_AI_SECTION_MAP = {"profile": "overview", "locations": "overview", "financial": "overview", "risks": "overview",
                   "other": "overview", "services": "business_lines", "projects": "projects_current",
                   "people": "people", "news": "news", "overview": "overview", "business_lines": "business_lines",
                   "projects_current": "projects_current", "projects_past": "projects_past",
                   "relationship_with_us": "relationship_with_us", "opportunities": "opportunities"}


def _ai_claims(result: Any, sources: list[_Source], gaps: list[dict[str, Any]]) -> list[_Claim]:
    result = as_plain(result) or {}
    by_url = {normalize_url(s.url): s for s in sources}
    raw_sections = result.get("sections") or {}
    pairs: list[tuple[str, dict]] = []
    if isinstance(raw_sections, Mapping):
        for key, sec in raw_sections.items():
            claims = sec.get("claims") if isinstance(sec, Mapping) else sec
            pairs += [(key, c) for c in claims or [] if isinstance(c, Mapping)]
    else:
        for sec in raw_sections:
            sec = as_plain(sec)
            if isinstance(sec, Mapping):
                pairs += [(sec.get("key") or sec.get("section") or "other", c) for c in sec.get("claims") or []
                          if isinstance(c, Mapping)]
    for c in result.get("claims") or []:
        if isinstance(c, Mapping):
            pairs.append((c.get("section") or "other", c))
    out: list[_Claim] = []
    for key, c in pairs:
        text = str(c.get("text") or "").strip()
        if not text:
            continue
        section = _AI_SECTION_MAP.get(str(key), "overview")
        if section == "projects_current" and _PAST_RE.search(text) and not _CURRENT_RE.search(text):
            section = "projects_past"
        refs = list(c.get("sources") or [])
        ev = c.get("evidence")
        if isinstance(ev, Mapping):
            refs.append({"url": ev.get("url") or c.get("url"), "quote": ev.get("quote")})
        elif isinstance(ev, list):
            refs += [{"url": e.get("url") or c.get("url"), "quote": e.get("quote")} for e in ev if isinstance(e, Mapping)]
        if c.get("quote"):
            refs.append({"url": c.get("url"), "quote": c.get("quote")})
        claim = _Claim(section, text, origin="ai")
        for ref in refs:
            quote = str(ref.get("quote") or "").strip()
            if not quote:
                continue
            candidates = [by_url[normalize_url(ref["url"])]] if ref.get("url") and normalize_url(ref["url"]) in by_url \
                else sources
            for src in candidates:
                found = find_verbatim(quote, src.text)
                if found:
                    claim.add(src.ref(found))
                    break
        if claim.sources:
            out.append(claim)
        else:
            gaps.append({"section": section, "kind": "unverified_claim_dropped",
                         "message": f"AI claim dropped - its quote was not found in the cited source: {text[:140]}"})
    for g in result.get("gaps") or []:
        if isinstance(g, str) and g.strip():
            gaps.append({"section": None, "kind": "ai_gap", "message": g.strip()[:300]})
    return out


# --------------------------------------------------------------------------------------------
# Evaluation
# --------------------------------------------------------------------------------------------


def _independent(sources: list[dict[str, Any]]) -> int:
    sites = set()
    for s in sources:
        sites.add("own" if s.get("kind") == "own_email" else (registrable_domain(s.get("url") or "") or s.get("url")))
    return len(sites)


def _claim_confidence(claim: _Claim) -> float:
    base = max(SOURCE_KIND_CONFIDENCE.get(s.get("kind") or "other", 0.4) for s in claim.sources)
    if all(s.get("verification") == "snippet" for s in claim.sources):
        base *= 0.8
    extra = min(0.25, 0.1 * (_independent(claim.sources) - 1))
    if claim.derived:
        base = min(base, 0.6)
    return round(min(0.95, base + extra), 2)


def _meets(claim: _Claim, section: str, rules: Mapping[str, Any], standard: str) -> tuple[bool, str | None]:
    n = _independent(claim.sources)
    official = any(s.get("kind") in OFFICIAL_KINDS for s in claim.sources)
    if standard == "basic":
        return True, None
    if section == "projects_current" and rules["current_project_sources"] >= 2 and n < 2:
        return False, f"needs {rules['current_project_sources']} independent sources ({n} found)"
    if section in KEY_SECTIONS or claim.fact == "size":
        if n >= rules["key_fact_target_sources"] or (official and rules["single_official_source_ok"]):
            return True, None
        return False, "one non-official source only - look for a second source or the official site"
    return True, None


def _summary(name: str, sections: dict[str, Any], standard: str, met: bool, evidence_count: int) -> str:
    def first(sec: str, skip: Iterable[str] = ()) -> str | None:
        for c in sections[sec]["claims"]:
            if c.get("meets_standard") and c.get("fact") not in ("identity",) and c["text"] not in skip:
                return c["text"]
        return None

    def sentence(t: str) -> str:
        t = t.strip()
        return t if t.endswith((".", "!", "?", "؟")) else t + "."

    overview = first("overview")
    parts = [sentence(p) for p in (overview, first("business_lines", skip=[overview or ""])) if p]
    current = [c["text"] for c in sections["projects_current"]["claims"] if c.get("meets_standard")][:2]
    if current:
        parts.append("Current projects: " + " ".join(sentence(t[:200]) for t in current))
    news = sections["news"]["claims"]
    if news:
        parts.append(f"{len(news)} news item(s) in the search window.")
    tail = (f"Evidence: {evidence_count} cited source quote(s); {standard} standard "
            f"{'met' if met else 'not met'}.")
    if not parts:
        return f"{name}: little public information found. {tail}"
    return " ".join([*parts, tail])


# --------------------------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------------------------


def _queries(info: Mapping[str, Any], standard: str, now: datetime) -> list[dict[str, Any]]:
    rules = EVIDENCE_STANDARDS[standard]
    name = info["name"]
    short = info["short"] or name
    base = f'"{short}"' if short else info["domain"]
    country = info["country_name"]
    window = rules["news_window_days"]
    qs: list[dict[str, Any]] = [{"q": f"{base} {country}".strip(), "kind": "general"}]
    if info["domain"]:
        qs.append({"q": f"{base} {info['domain']}", "kind": "official"})
    if window:
        qs.append({"q": f"{base} news", "kind": "news", "recency_days": window, "news": True})
    qs.append({"q": f"{base} projects", "kind": "projects"})
    if standard != "basic":
        qs.append({"q": f"{base} contract awarded", "kind": "projects", "recency_days": window})
        qs.append({"q": f"{base} company profile", "kind": "profile"})
    if standard == "deep":
        qs.append({"q": f"{base} tender {now.year}", "kind": "projects", "recency_days": window})
        qs.append({"q": f'{base} "managing director" OR CEO OR "general manager"', "kind": "people"})
        qs.append({"q": f"{base} new project {now.year}", "kind": "news", "recency_days": window, "news": True})
        if info.get("name_ar"):
            qs.append({"q": f'"{info["name_ar"]}"', "kind": "general"})
    return qs[:rules["max_queries"]]


def _search(provider: Any, q: dict[str, Any], max_results: int) -> list[SearchResult]:
    kwargs: dict[str, Any] = {"max_results": max_results}
    if q.get("recency_days"):
        kwargs["recency_days"] = q["recency_days"]
    if q.get("news"):
        kwargs["news"] = True
    try:
        return list(provider.search(q["q"], **kwargs) or [])
    except TypeError:
        return list(provider.search(q["q"], max_results=max_results) or [])


def _as_result(r: Any) -> SearchResult | None:
    if isinstance(r, SearchResult):
        return r
    get = (lambda k: r.get(k)) if isinstance(r, Mapping) else (lambda k: getattr(r, k, None))
    url = get("url") or get("link")
    if not url:
        return None
    return SearchResult(title=str(get("title") or ""), url=str(url), snippet=str(get("snippet") or ""),
                        published=get("published"), source=str(get("source") or ""))


def research_customer(customer: Any, provider: Any = None, engine: Any = None, standard: str = "standard",
                      own_evidence: Any = None, *, fetcher: Callable[[str], PageText] | None = None,
                      now: datetime | None = None, opportunities: Sequence[Mapping[str, Any]] | None = None,
                      max_results_per_query: int = 6) -> dict[str, Any]:
    """Research one customer to the requested evidence standard (see :data:`EVIDENCE_STANDARDS`).

    ``customer``: dict/object with name, domain, country (city, kind, name_ar optional).
    ``provider``: a search provider (``ess.customers.search``) or ``None`` for own evidence only.
    ``own_evidence``: our e-mails with them (``[{text, source|url|id, date, subject}]``) or a dict with
    ``emails``/``projects``/``tags``/``opportunities``. ``fetcher`` (or ``provider.fetch_page``)
    overrides page downloads. Returns ``{customer, standard, sections{...}, gaps, met_standard,
    evidence_count, summary, identity, queries, errors, ran_at}``.
    """
    if standard not in EVIDENCE_STANDARDS:
        raise ValueError(f"unknown evidence standard {standard!r}; expected one of {list(EVIDENCE_STANDARDS)}")
    rules = EVIDENCE_STANDARDS[standard]
    now = now or datetime.now(timezone.utc)
    stamp = _iso_now(now)
    name = str(_get(customer, "name", default="") or "").strip()
    domain = str(_get(customer, "domain", default="") or "").lower().strip().removeprefix("www.")
    if domain in FREE_MAIL_DOMAINS:
        domain = ""
    country = str(_get(customer, "country", default="") or "").strip()
    info = {"name": name, "short": short_name(name), "domain": domain, "country": country,
            "country_name": _COUNTRY_NAMES.get(country.upper(), country), "city": _get(customer, "city"),
            "kind": _get(customer, "kind"), "name_ar": _get(customer, "name_ar")}
    variants = name_variants(name, domain)
    gaps: list[dict[str, Any]] = []
    errors: list[str] = []
    queries_run: list[dict[str, Any]] = []
    sources: list[_Source] = []
    news_searched = False
    window_start = now - timedelta(days=rules["news_window_days"]) if rules["news_window_days"] else None

    # ---- web search ------------------------------------------------------------------------------
    results: dict[str, tuple[SearchResult, dict[str, Any]]] = {}
    if provider is not None and (name or domain):
        for q in _queries(info, standard, now):
            try:
                found = [r for r in (_as_result(x) for x in _search(provider, q, max_results_per_query)) if r]
            except Exception as exc:  # one failing query never stops the profile
                errors.append(f"search failed for {q['q']!r}: {exc}")
                queries_run.append({**q, "results": 0, "error": str(exc)[:200]})
                continue
            queries_run.append({**{k: v for k, v in q.items()}, "results": len(found)})
            if q["kind"] == "news":
                news_searched = True
            for r in found:
                key = normalize_url(r.url)
                if key not in results:
                    results[key] = (r, q)
    elif provider is None:
        gaps.append({"section": None, "kind": "no_search_provider",
                     "message": "No web search is connected - the profile uses our own e-mails only."})

    # ---- fetch pages ------------------------------------------------------------------------------
    fetch = fetcher or getattr(provider, "fetch_page", None) or fetch_page_text
    plan: list[tuple[str, SearchResult | None, dict[str, Any] | None]] = []
    if domain and provider is not None:
        plan.append((f"https://{domain}", None, None))
    prio = {"official": 0, "registry": 1, "news": 2, "directory": 3, "other": 4}
    ranked = sorted(results.values(), key=lambda rq: (prio[_site_kind(rq[0].url, domain)],
                                                      0 if _mentions(f"{rq[0].title} {rq[0].snippet}", variants) else 1))
    for r, q in ranked:
        if normalize_url(r.url) not in {normalize_url(u) for u, _r, _q in plan}:
            plan.append((r.url, r, q))
    fetched: dict[str, PageText] = {}
    for url, r, q in plan:
        if len(fetched) >= rules["max_pages"]:
            break
        try:
            page = fetch(url)
        except Exception as exc:
            page = PageText(url=url, error=str(exc), fetched_at=stamp)
        if isinstance(page, str):
            page = page_from_html(page, url, now=now)
        fetched[normalize_url(url)] = page
        if page.error:
            errors.append(f"could not fetch {url}: {page.error}")
    for key, page in fetched.items():
        if not page.ok:
            continue
        r, q = results.get(key, (None, None))
        kind = _site_kind(page.final_url or page.url, domain)
        if kind == "other" and q is not None and q.get("kind") == "news":
            kind = "news"
        sources.append(_Source(url=page.url, title=page.title or (r.title if r else ""), kind=kind,
                               text=page.full_text(), verification="page",
                               published=page.published or (r.published if r else None),
                               retrieved_at=page.fetched_at or stamp, site=registrable_domain(page.url),
                               query=q["q"] if q else None))
    for key, (r, q) in results.items():
        page = fetched.get(key)
        if page is not None and page.ok:
            continue
        snippet_text = "\n".join(x for x in (r.title, r.snippet) if x)
        if not snippet_text.strip():
            continue
        kind = _site_kind(r.url, domain)
        if kind == "other" and q.get("kind") == "news":
            kind = "news"
        sources.append(_Source(url=r.url, title=r.title, kind=kind, text=snippet_text, verification="snippet",
                               published=r.published, retrieved_at=stamp, site=registrable_domain(r.url),
                               query=q["q"]))

    # ---- own evidence ---------------------------------------------------------------------------
    own_docs, extras = _own_docs(own_evidence)
    own_sources = [_Source(url=d["url"], title=d["title"], kind="own_email", text=d["text"], verification="own_email",
                           published=None, retrieved_at=stamp, site="own", date=d["date"]) for d in own_docs]

    # ---- identity -------------------------------------------------------------------------------
    identity_sources: list[dict[str, Any]] = []
    for src in sources + own_sources:
        if src.kind not in rules["identity_source_kinds"]:
            continue
        hay = src.text if src.kind != "official" else f"{src.title}\n{src.text[:4000]}"
        quote = None
        for v in variants:
            quote = find_verbatim(v, hay)
            if quote:
                break
        if quote is None and src.kind == "official" and src.title:
            quote = src.title  # the company's own domain: its title identifies the site
        if quote:
            line = next((ln.strip() for ln in hay.splitlines() if quote in ln and len(ln.strip()) <= 300), quote)
            identity_sources.append(src.ref(line))
    identity = {"confirmed": len(identity_sources) >= rules["identity_sources"],
                "sources": identity_sources[:4], "variants": variants}

    # ---- claims ---------------------------------------------------------------------------------
    claims: list[_Claim] = []
    engine_used = False
    if engine is not None and (sources or own_sources):
        payload = [{"url": s.url, "title": s.title, "snippet": "", "text": s.text[:6000]} for s in sources + own_sources]
        try:
            result = call_ai_task("research_customer", engine, {
                "customer": {"name": name, "domain": domain, "country": country, "city": info["city"],
                             "kind": info["kind"]},
                "search_results": payload, "standard": standard})
            claims.extend(_ai_claims(result, sources + own_sources, gaps))
            engine_used = True
        except AITaskUnavailable as exc:
            errors.append(f"AI research unavailable: {exc}")
        except Exception as exc:  # deterministic extraction still runs
            errors.append(f"AI research failed: {exc}")
    deterministic: list[_Claim] = []
    for src in sources:
        if src.kind == "news" or (src.query and "news" in src.query and src.published):
            _news_claims(src, variants, window_start, deterministic)
        _extract_from_source(src, variants, deterministic)
    if identity["confirmed"]:
        first = identity_sources[0]
        deterministic.insert(0, _Claim("overview", f"Identity confirmed: {first['quote'][:200]}", [first],
                                       fact="identity"))
    if engine_used:
        covered = {c.section for c in claims}
        claims.extend(c for c in deterministic if c.section not in covered or c.fact == "identity")
    else:
        claims.extend(deterministic)

    # own e-mails: relationship, people, the projects they asked us about
    if own_sources:
        dated = sorted((s for s in own_sources if _date(s.date)), key=lambda s: _date(s.date))
        first_line = lambda s: next((ln.strip() for ln in s.text.splitlines() if len(ln.strip()) >= 8), s.text[:120])
        if dated:
            a, b = dated[0], dated[-1]
            text = (f"{len(own_sources)} e-mail(s) with us between {_date(a.date).date().isoformat()} and "
                    f"{_date(b.date).date().isoformat()}.")
            rel = _Claim("relationship_with_us", text, [a.ref(first_line(a))])
            if b is not a:
                rel.add(b.ref(first_line(b)))
        else:
            rel = _Claim("relationship_with_us", f"{len(own_sources)} e-mail(s) with us on file.",
                         [own_sources[0].ref(first_line(own_sources[0]))])
        claims.append(rel)
        for src in own_sources:
            for text, quote in _signature_people({"text": src.text}):
                claims.append(_Claim("people", text, [src.ref(quote)]))
            for line in src.text.splitlines()[:12]:
                line = line.strip()
                if 12 <= len(line) <= 260 and _RFQ_LINE_RE.search(line) and _PROJECT_WORD_RE.search(line):
                    claims.append(_Claim("projects_current", line, [src.ref(line)]))
    for p in extras.get("projects") or []:
        pname = str(_get(p, "name", default="") or "")
        if pname:
            when = _get(p, "due_date", "received_at")
            src = _Source(url=f"project:{_get(p, 'ref', 'id', default=pname)}", title=pname, kind="own_email",
                          text=pname, verification="own_email", published=None, retrieved_at=stamp, site="own",
                          date=str(when) if when else None)
            claims.append(_Claim("relationship_with_us", f"Enquiry on file: {pname}", [src.ref(pname)]))
    for opp in list(opportunities or []) + list(extras.get("opportunities") or []):
        label = str(_get(opp, "label", "service_key", default="") or "")
        if not label:
            continue
        claim = _Claim("opportunities", f"{label}: {_get(opp, 'reason', default='')}".strip(": "), derived=True)
        for ev in _get(opp, "evidence", default=[]) or []:
            basis = ev.get("basis") if isinstance(ev, Mapping) else None
            for cand in (ev, basis):
                if isinstance(cand, Mapping) and cand.get("quote"):
                    src = _Source(url=str(cand.get("ref") or cand.get("source") or "internal:tags"),
                                  title="Customer tags", kind="own_email", text=str(cand["quote"]),
                                  verification="own_email", published=None, retrieved_at=stamp, site="own")
                    claim.add(src.ref(str(cand["quote"])))
        claims.append(claim)

    claims = _merge(claims)

    # ---- evaluate -------------------------------------------------------------------------------
    sections: dict[str, dict[str, Any]] = {s: {"status": "not_found", "claims": []} for s in SECTIONS}
    for c in claims:
        if not c.sources and not c.derived:
            continue
        ok, why = _meets(c, c.section, rules, standard) if c.sources else (False, "no quoted source")
        entry = {"text": c.text, "sources": c.sources, "confidence": _claim_confidence(c) if c.sources else 0.3,
                 "meets_standard": ok, "independent_sources": _independent(c.sources) if c.sources else 0}
        if c.fact:
            entry["fact"] = c.fact
        if c.derived:
            entry["derived"] = True
        if c.origin == "ai":
            entry["origin"] = "ai"
        if not ok:
            entry["needs"] = why
            gaps.append({"section": c.section, "kind": "below_standard", "claim": c.text[:160], "message": why})
        sections[c.section]["claims"].append(entry)
    for name_s, sec in sections.items():
        sec["claims"].sort(key=lambda e: (not e["meets_standard"], -e["confidence"]))
        sec["claims"] = sec["claims"][:12]
        if any(e["meets_standard"] for e in sec["claims"]):
            sec["status"] = "found"
        elif sec["claims"]:
            sec["status"] = "partial"
        else:
            searched = len(sources) + len(own_sources)
            gaps.append({"section": name_s, "kind": "not_found",
                         "message": f"No {SECTION_LABELS[name_s]} found in {searched} source(s) checked."})
    if not any(c.get("fact") == "size" for c in sections["overview"]["claims"]) and standard != "basic":
        gaps.append({"section": "overview", "kind": "not_found", "message": "Company size (staff, capital, revenue) "
                     "not found."})
    if not identity["confirmed"]:
        gaps.insert(0, {"section": None, "kind": "identity_unconfirmed",
                        "message": "No official site, registry entry or e-mail from this company confirms its "
                                   "identity yet."})
    if rules["news_search_required"] and not news_searched:
        gaps.insert(0, {"section": "news", "kind": "news_not_searched",
                        "message": "The news search for the last 12 months could not run."})
    for err in errors:
        gaps.append({"section": None, "kind": "source_error", "message": err[:300]})
    pairs = {(s["url"], s["quote"]) for sec in sections.values() for c in sec["claims"] for s in c["sources"]}
    evidence_count = len(pairs)
    met = identity["confirmed"] and (not rules["news_search_required"] or news_searched)
    summary = _summary(name or domain, sections, standard, met, evidence_count)
    return {
        "customer": {"name": name, "domain": domain or None, "country": country or None, "city": info["city"],
                     "kind": info["kind"]},
        "standard": standard,
        "rules": dict(rules),
        "identity": identity,
        "sections": sections,
        "gaps": gaps,
        "met_standard": met,
        "evidence_count": evidence_count,
        "summary": summary,
        "queries": queries_run,
        "news_searched": news_searched,
        "sources_checked": len(sources) + len(own_sources),
        "engine_used": engine_used,
        "errors": errors,
        "ran_at": stamp,
    }
