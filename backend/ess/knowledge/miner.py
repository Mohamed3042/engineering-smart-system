"""Business-identity mining: learn what a company does, how it names things, which standards and
business conventions it uses - from its own quotations, documents and mailbox, with online pages
as context only.

Deterministic first (works with no AI at all):

(a) regional concept terms (``region_terms.json``) -> service families, work types and which
    regional variants the company itself uses vs. its customers;
(b) offering phrases ("supply and installation of X") -> service families that are not in the
    curated data (so the app works for any company, not only access-equipment firms);
(c) n-gram TF-IDF of the company's own text vs. inbound mail -> company-specific terms;
(d) standards by pattern (EN/BS/ISO/ANSI/OSHA/ASME/GOST/SP...) + the standards library;
(e) conventions: reference-number format, signature block / legal identity, language mix,
    currency, date format, commercial terms.

Evidence rules: every finding carries exact sentence quotes from its sources. Confidence is
computed from the evidence only - own quotations weigh most, inbound mail shows market demand,
and web pages are context: an item backed only by web evidence never exceeds 0.3 and is never
``delivered_work``. Optional AI refinement (``ess.ai.tasks.discover_business``) is merged in only
where its quotes are found verbatim in the corpus; the AI can name and describe, not inflate.
"""
from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field

from ess.knowledge.ai_bridge import AITaskUnavailable, as_plain, call_ai_task
from ess.knowledge.base import (
    WORK_TYPES,
    TermEntry,
    TermIndex,
    Token,
    build_term_index,
    coerce_categories,
    coerce_region_terms,
    coerce_standards,
    detect_language,
    gaps_ok,
    is_catch_all_category,
    is_neutral_region,
    make_entry,
    normalize_text,
    region_labels,
    script_counts,
    slugify,
    tokenize,
    work_type_of,
)
from ess.knowledge.corpus import (
    CUSTOMER_SOURCE_TYPES,
    DELIVERED_SOURCE_TYPES,
    OWN_SOURCE_TYPES,
    SOURCE_WEIGHTS,
    CorpusDoc,
)
from ess.knowledge.text import (
    ADDRESS_RE,
    CLOSING_RE,
    EMAIL_RE,
    LEGAL_SUFFIX_RE,
    PHONE_INTL_RE,
    PHONE_LABELED_RE,
    WEBSITE_RE,
    SentenceIndex,
    email_domain,
    extract_signature,
    find_phones,
    find_verbatim,
    is_contact_line,
    quoted_cut,
    registrable_domain,
    squash,
)

log = logging.getLogger(__name__)

Kind = Literal["service_family", "work_type", "term", "standard", "convention", "identity"]
ClaimBasis = Literal["delivered_work", "catalogue_claim", "market_vocabulary"]
KINDS: tuple[str, ...] = ("service_family", "work_type", "term", "standard", "convention", "identity")
_KIND_ORDER = {k: i for i, k in enumerate(("identity", "service_family", "work_type", "standard", "convention",
                                           "term"))}
_SIDE = {"own_quotation": "company", "company_doc": "company", "sent_email": "company",
         "inbound_email": "customers", "web": "web"}
WEB_ONLY_CAP = 0.3  # confidence ceiling for anything only seen online
DEMAND_ONLY_CAP = 0.45  # a service only customers mention is demand, not capability
CONFIRMED_STATUSES = frozenset({"owner_confirmed", "confirmed"})

# --------------------------------------------------------------------------------------------
# Public models
# --------------------------------------------------------------------------------------------


class Evidence(BaseModel):
    model_config = ConfigDict(extra="allow")

    quote: str  # exact substring of the source text
    source_type: str
    source_id: str
    source_label: str = ""
    weight: float = 0.0
    date: str | None = None


class KnowledgeItemDraft(BaseModel):
    """A suggested piece of business knowledge (stored as ``KnowledgeItem`` after review)."""

    model_config = ConfigDict(extra="allow")

    kind: Kind
    key: str
    label: str
    label_ar: str = ""
    description: str = ""
    synonyms: list[str] = Field(default_factory=list)
    region: str | None = None
    language: str | None = None
    claim_basis: ClaimBasis = "market_vocabulary"
    evidence: list[Evidence] = Field(default_factory=list)
    score: float = 0.0
    confidence: float = 0.0
    status: str = "suggested"
    value: Any = None  # structured value for identity / convention items
    meta: dict[str, Any] = Field(default_factory=dict)  # counts, regional usage, origins

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump()


# --------------------------------------------------------------------------------------------
# Internal structures
# --------------------------------------------------------------------------------------------

_EXCLUSION_RE = re.compile(
    r"(?i)\b(?:excluded|exclusions?|not\s+included|not\s+in\s+(?:our|the)\s+scope|by\s+others|"
    r"by\s+(?:the\s+)?(?:client|main\s+contractor|customer)|not\s+(?:part\s+of|covered)|"
    r"we\s+do\s+not\s+(?:supply|offer|provide|deal)|we\s+don'?t\s+(?:supply|offer|provide|deal)|regret)\b"
    r"|غير\s+مشمول|مستثنى|باستثناء|لا\s+يشمل|исключ")


@dataclass(eq=False)
class _Doc:
    doc: CorpusDoc
    order: int
    stype: str
    side: str
    weight: float
    limit: int
    tokens: list[Token]
    gaps: list[bool]
    sents: SentenceIndex
    year: int | None
    skip: list[tuple[int, int]] = field(default_factory=list)

    @property
    def sid(self) -> str:
        return self.doc.source_id

    @property
    def text(self) -> str:
        return self.doc.text

    def quote(self, start: int, end: int) -> str:
        return self.sents.quote(start, end)

    def sentence(self, pos: int) -> str:
        s, e = self.sents.span_at(pos)
        return self.doc.text[s:e]


@dataclass(eq=False)
class _Hit:
    stype: str
    mentions: int = 0
    affirmed: int = 0


@dataclass(eq=False)
class _Cand:
    quote: str
    stype: str
    sid: str
    label: str
    weight: float
    affirmed: bool
    order: int
    date: str | None


class _Acc:
    """Accumulates evidence for one (kind, key) during mining."""

    def __init__(self, kind: str, key: str) -> None:
        self.kind = kind
        self.key = key
        self.fresh = True
        self.label = ""
        self.label_ar = ""
        self.description = ""
        self.region: str | None = None
        self.language: str | None = None
        self.value: Any = None
        self.surfaces: Counter = Counter()
        self.extra_synonyms: list[str] = []
        self.side_terms: dict[str, Counter] = {"company": Counter(), "customers": Counter()}
        self.regions: set[str] = set()
        self.meta: dict[str, Any] = {}
        self.docs: dict[str, _Hit] = {}
        self.cands: dict[str, _Cand] = {}
        self.cand_per_type: Counter = Counter()
        self.origins: set[str] = set()
        self.preset: tuple[float, set[str]] | None = None  # (weighted support, source types) override

    def hit(self, d: _Doc, start: int, end: int, *, affirmed: bool = True, surface: str | None = None,
            quote: str | None = None, cap: int = 6) -> None:
        h = self.docs.get(d.sid)
        if h is None:
            h = self.docs[d.sid] = _Hit(d.stype)
        h.mentions += 1
        if affirmed:
            h.affirmed += 1
        if surface:
            s = surface.strip()
            if s:
                self.surfaces[s] += 1
                if d.side in self.side_terms:
                    self.side_terms[d.side][s] += 1
        c = self.cands.get(d.sid)
        if c is None:
            if self.cand_per_type[d.stype] >= cap:
                return
            self.cand_per_type[d.stype] += 1
        elif c.affirmed or not affirmed:
            return
        q = quote if quote is not None else d.quote(start, end)
        if q:
            self.cands[d.sid] = _Cand(q, d.stype, d.sid, d.doc.label, d.weight, affirmed, d.order, d.doc.date)


class _Registry:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], _Acc] = {}

    def get(self, kind: str, key: str) -> _Acc:
        acc = self.items.get((kind, key))
        if acc is None:
            acc = self.items[(kind, key)] = _Acc(kind, key)
        return acc

    def find(self, kind: str, key: str) -> _Acc | None:
        return self.items.get((kind, key))

    def of_kind(self, kind: str) -> list[_Acc]:
        return [a for (k, _), a in self.items.items() if k == kind]


_FAMILY_CATEGORY_HINTS = frozenset({"service_family", "service", "services", "equipment", "product", "products",
                                    "offering"})


class _Ctx:
    def __init__(self, region_terms: Mapping[str, Any], categories: list[dict], index: TermIndex) -> None:
        self.region_terms = region_terms
        self.categories = categories
        self.cat_by_key = {c["key"]: c for c in categories}
        self.work_cats = {c["key"] for c in categories if c.get("is_work_type") and not is_catch_all_category(c["key"])}
        self.catch_all = {c["key"] for c in categories if is_catch_all_category(c["key"])}
        self.concepts = {c["key"]: c for c in region_terms.get("concepts") or []}
        self.region_labels = region_labels(region_terms)
        self.index = index
        self._roles: dict[TermEntry, tuple[str | None, str | None, str]] = {}
        self._term_keys: dict[TermEntry, str] = {}
        negatives = {c["key"]: [w for lst in (c.get("negative_keywords") or {}).values() for w in lst or []]
                     for c in categories}
        self.neg_index = TermIndex.from_phrases({k: v for k, v in negatives.items() if v}, origin="negative")
        self.concept_terms: dict[str, list[str]] = defaultdict(list)
        for c in region_terms.get("concepts") or []:
            for t in c.get("terms") or []:
                if t["term"] not in self.concept_terms[c["key"]]:
                    self.concept_terms[c["key"]].append(t["term"])

    def resolve(self, e: TermEntry) -> tuple[str | None, str | None, str]:
        """(service family, work type, group) for an index entry."""
        hit = self._roles.get(e)
        if hit is not None:
            return hit
        family = wt = None
        if e.origin == "work_type":
            wt = e.concept
        elif e.origin == "category":
            family = e.category if e.category in self.work_cats else None
        else:
            cat = e.category
            if cat in self.work_cats:
                family = cat
            elif cat in self.catch_all or cat in _FAMILY_CATEGORY_HINTS:
                family = e.concept  # a service the defaults lump into "other": learn it by name
            else:
                wt = work_type_of(e.concept, cat)
        res = (family, wt, family or wt or e.concept)
        self._roles[e] = res
        return res

    def term_key(self, e: TermEntry, group: str) -> str:
        key = self._term_keys.get(e)
        if key is None:
            key = self._term_keys[e] = f"{group}:{slugify(e.key if e.key.isascii() else e.term)}"
        return key

    def negative_hits(self, d: "_Doc") -> list[tuple[int, set[str]]]:
        """(offset, categories) of negative keywords in a document - matched once per document."""
        if not len(self.neg_index):
            return []
        return [(m.start, {e.concept for e in m.entries}) for m in self.neg_index.find_tokens(d.tokens, d.text, d.gaps)]

    def family_label(self, key: str, fallback: str = "") -> tuple[str, str, str]:
        cat = self.cat_by_key.get(key)
        if cat:
            return cat.get("label") or key, cat.get("label_ar") or "", cat.get("description") or ""
        concept = self.concepts.get(key)
        if concept:
            return concept.get("canonical") or key, "", (concept.get("notes") or "")[:400]
        return fallback or key.replace("_", " ").title(), "", ""


# --------------------------------------------------------------------------------------------
# Corpus preparation
# --------------------------------------------------------------------------------------------


def _coerce_doc(d: Any) -> CorpusDoc | None:
    if isinstance(d, CorpusDoc):
        return d
    if isinstance(d, dict):
        try:
            return CorpusDoc(**{k: d[k] for k in ("source_type", "source_id", "label", "text", "date", "language",
                                                  "meta") if k in d})
        except (TypeError, ValueError):
            return None
    return None


def _year(date: str | None) -> int | None:
    m = re.match(r"\s*(\d{4})", date or "")
    return int(m.group(1)) if m else None


def _prepare(docs: Iterable[Any], max_docs_per_type: int | None) -> tuple[list[_Doc], dict[str, int]]:
    groups: dict[str, list[tuple[int, CorpusDoc]]] = defaultdict(list)
    for i, raw in enumerate(docs or []):
        d = _coerce_doc(raw)
        if d is None or not d.text.strip():
            continue
        groups[d.source_type].append((i, d))
    dropped: dict[str, int] = {}
    selected: list[tuple[int, CorpusDoc]] = []
    for stype, lst in groups.items():
        if max_docs_per_type and len(lst) > max_docs_per_type:
            step = len(lst) / max_docs_per_type
            dropped[stype] = len(lst) - max_docs_per_type
            lst = [lst[int(k * step)] for k in range(max_docs_per_type)]
        selected.extend(lst)
    selected.sort(key=lambda x: x[0])
    out: list[_Doc] = []
    for order, d in selected:
        text = d.text
        limit = len(text)
        if d.source_type == "sent_email":
            limit = quoted_cut(text, "all")
        elif d.source_type == "inbound_email":
            limit = quoted_cut(text, "reply")
        if not text[:limit].strip():
            continue
        tokens = tokenize(text, 0, limit)
        out.append(_Doc(doc=d, order=order, stype=d.source_type, side=_SIDE[d.source_type],
                        weight=SOURCE_WEIGHTS[d.source_type], limit=limit, tokens=tokens, gaps=gaps_ok(text, tokens),
                        sents=SentenceIndex(text[:limit]), year=_year(d.date)))
    return out, dropped


def _line_spans(text: str, start: int, end: int) -> list[tuple[int, int]]:
    out = []
    pos = start
    for line in text[start:end].splitlines(keepends=True):
        s = pos
        e = pos + len(line.rstrip("\r\n"))
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        if e > s:
            out.append((s, e))
        pos += len(line)
    return out


_NAME_LINE_RE = re.compile(r"(?i)^\s*(?:to|attn|attention|dear|m/s|messrs|client|customer|project|your\s+ref|"
                           r"consultant|owner|main\s+contractor|إلى|الى|السادة|مشروع)\b")


def _mark_boilerplate(company_docs: list[_Doc]) -> None:
    """Signature blocks, contact lines and letterhead lines repeated across own documents are not
    vocabulary: they are skipped by the n-gram miner."""
    line_docs: Counter = Counter()
    lines_of: dict[int, list[tuple[int, int, str]]] = {}
    for d in company_docs:
        lines = []
        for s, e in _line_spans(d.text, 0, d.limit):
            norm = squash(d.text[s:e])
            if len(norm) >= 6:
                lines.append((s, e, norm))
        lines_of[id(d)] = lines
        for norm in {n for _, _, n in lines}:
            line_docs[norm] += 1
    threshold = max(3, math.ceil(0.5 * len(company_docs))) if len(company_docs) >= 4 else None
    for d in company_docs:
        ranges: list[tuple[int, int]] = []
        sig = extract_signature(d.text[:d.limit])
        if sig:
            ranges.append(sig)
        for s, e, norm in lines_of[id(d)]:
            line = d.text[s:e]
            if is_contact_line(line) or _NAME_LINE_RE.match(line) or (
                    threshold is not None and line_docs[norm] >= threshold):
                ranges.append((s, e))
        d.skip = sorted(ranges)


def _skip_flags(d: _Doc) -> list[bool]:
    flags = [False] * len(d.tokens)
    if not d.skip:
        return flags
    j = 0
    ranges = d.skip
    for i, t in enumerate(d.tokens):
        while j < len(ranges) and ranges[j][1] <= t.start:
            j += 1
        k = j
        while k < len(ranges) and ranges[k][0] <= t.start:
            if ranges[k][0] <= t.start < ranges[k][1]:
                flags[i] = True
                break
            k += 1
    return flags


# --------------------------------------------------------------------------------------------
# (a) Regional concepts -> service families, work types, vocabulary
# --------------------------------------------------------------------------------------------


def _mine_concepts(docs: list[_Doc], ctx: _Ctx, reg: _Registry) -> None:
    for d in docs:
        if not d.tokens:
            continue
        fams: set[str] = set()
        wts: set[str] = set()
        neg_hits = ctx.negative_hits(d)
        excl_cache: dict[tuple[int, int], bool] = {}
        for m in ctx.index.find_tokens(d.tokens, d.text, d.gaps):
            span = d.sents.span_at(m.start)
            if span not in excl_cache:
                excl_cache[span] = d.side == "company" and bool(_EXCLUSION_RE.search(d.text, span[0], span[1]))
            excluded = excl_cache[span]
            negated: set[str] = set()
            for pos, cats in neg_hits:
                if span[0] <= pos < span[1]:
                    negated |= cats
            has_rt = any(e.origin == "region_terms" for e in m.entries)
            done: set[tuple[str, str]] = set()
            for e in m.entries:
                family, wt, group = ctx.resolve(e)
                if (family and family in negated) or (e.category and e.category in negated):
                    continue
                roles: list[tuple[str, str]] = []
                if family:
                    roles.append(("service_family", family))
                elif wt:
                    roles.append(("work_type", wt))
                if e.origin in ("region_terms", "work_type"):
                    roles.append(("term", ctx.term_key(e, group)))
                for kind, key in roles:
                    acc = reg.get(kind, key)
                    if acc.fresh:
                        _init_concept_acc(acc, e, family, wt, group, ctx)
                    if kind == "term" and (e.origin == "region_terms" or not has_rt):
                        acc.regions.add(e.region)
                        if e.usage:
                            acc.meta.setdefault("usage", set()).add(e.usage)
                    if (kind, key) in done:
                        continue
                    done.add((kind, key))
                    acc.origins.add(e.origin)
                    acc.hit(d, m.start, m.end, affirmed=not excluded, surface=m.surface)
                    if not excluded and kind == "service_family":
                        fams.add(key)
                    elif not excluded and kind == "work_type":
                        wts.add(key)
        for f in fams:
            wt_counts = reg.get("service_family", f).meta.setdefault("work_types", Counter())
            for w in wts:
                wt_counts[w] += 1


def _init_concept_acc(acc: _Acc, e: TermEntry, family: str | None, wt: str | None, group: str, ctx: _Ctx) -> None:
    acc.fresh = False
    if acc.kind == "service_family":
        label, label_ar, desc = ctx.family_label(acc.key, e.canonical)
        acc.label, acc.label_ar, acc.description = label, label_ar, desc
    elif acc.kind == "work_type":
        info = WORK_TYPES.get(acc.key, {})
        acc.label = info.get("label") or acc.key.replace("_", " ").title()
        acc.label_ar = info.get("label_ar", "")
        acc.description = f"Why customers write: {acc.label.lower()}."
    else:
        acc.label = e.term
        acc.language = e.language
        acc.meta.update({"concept": e.concept, "canonical": e.canonical, "group": group,
                         "category": family or wt or e.category or None})
        acc.extra_synonyms = [t for t in ctx.concept_terms.get(e.concept, []) if t != e.term][:8]
        if not acc.extra_synonyms and e.origin == "work_type":
            from ess.knowledge.base import WORK_TYPE_PHRASES

            acc.extra_synonyms = [t for t, _r, _l in WORK_TYPE_PHRASES.get(e.concept, []) if t != e.term][:8]


# --------------------------------------------------------------------------------------------
# (b) Offering phrases -> service families outside the curated vocabulary
# --------------------------------------------------------------------------------------------

_V = (r"(?:design(?:ing)?|suppl(?:y|ying)|furnish(?:ing)?|deliver(?:y|ing)?|install(?:ation|ing)?|"
      r"erect(?:ion|ing)?|fabricat(?:ion|ing)|commission(?:ing)?|rent(?:al|ing)?|hir(?:e|ing)|leas(?:e|ing)|"
      r"maint(?:enance|aining)|servic(?:e|ing)|repair(?:s|ing)?|inspect(?:ion|ing)|testing|"
      r"certif(?:ication|ying)|sale|selling|provision|providing|moderni[sz](?:ation|ing)|refurbish(?:ment|ing)|"
      r"replac(?:ement|ing)|upgrad(?:e|ing)|dismantl(?:ing|e))")
_OFFER_RE = re.compile(rf"\b(?P<verbs>{_V}(?:\s*(?:,|&|\band\b|/|\+)\s*{_V})*)\s+(?:of|for)\s+"
                       rf"(?P<obj>[^\n;:()\[\]]{{2,120}})", re.I)
_OFFER_AR_RE = re.compile(r"(?P<verbs>توريد\s*و\s*تركيب|توريد|تركيب|تأجير|تاجير|ايجار|إيجار|صيانة|اصلاح|إصلاح|فحص)"
                          r"\s+(?P<obj>[^\n.،,؛:()]{2,80})")
_OBJ_END_RE = re.compile(r"(?<!\bno)(?<!\bnos)(?<!\bqty)(?<!\bapprox)\.(?:\s|$)", re.I)
_OBJ_STOP = frozenset(
    {"at", "for", "in", "to", "on", "as", "with", "per", "including", "include", "includes", "included", "located",
     "from", "under", "within", "according", "during", "by", "which", "that", "is", "are", "was", "were", "will",
     "shall", "be", "being", "inside", "into", "onto", "via", "plus", "inclusive", "excluding", "except", "vide",
     "dated", "valid", "price", "prices", "rate", "rates", "cost", "total", "amount", "and", "or", "&", "where",
     "when", "if", "please", "kindly", "we", "you", "our", "your", "مشروع", "لمشروع", "بمشروع", "في", "من", "علي",
     "الي", "مع", "حسب", "وفق", "لصالح", "عن", "داخل", "او", "و"})
_OBJ_FILLERS = frozenset(
    {"the", "a", "an", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "complete",
     "completed", "new", "nos", "no", "nr", "pcs", "pc", "set", "sets", "pair", "pairs", "lot", "lots", "of",
     "said", "above", "below", "following", "required", "proposed", "various", "all", "each", "any", "existing",
     "additional", "qty", "quantity", "m", "mm", "cm", "meter", "meters", "metre", "metres", "mtr", "mtrs", "kg",
     "ton", "tons", "tonne", "tonnes", "x", "unit", "units", "عدد"})
_OBJ_TRAILING = frozenset({"complete", "only", "etc", "nos", "no", "items", "item"})
_GENERIC_HEADS = frozenset(
    {"work", "service", "item", "material", "equipment", "system", "product", "good", "job", "task", "scope",
     "project", "requirement", "document", "drawing", "quotation", "offer", "price", "order", "site", "building",
     "tender", "package", "part", "following", "above", "same", "month", "week", "day", "year", "period",
     "duration", "time", "basis", "rate", "cost", "amount", "value", "you", "us", "them", "it", "company",
     "client", "customer", "request", "enquiry", "inquiry", "rfq", "contract", "agreement", "purpose", "use",
     "area", "location", "floor", "level", "attached", "mentioned", "subject", "reference", "detail", "information"})


def _verbs_work_type(verbs: str) -> str | None:
    v = verbs.lower()
    if re.search(r"rent|hir|leas|تأجير|تاجير|ايجار|إيجار", v):
        return "equipment_rental"
    if re.search(r"install|erect|commission|تركيب", v):
        return "supply_installation"
    if re.search(r"maint|صيانة", v):
        return "annual_maintenance"
    if re.search(r"repair|servic|replac|refurb|moderni|upgrad|dismantl|اصلاح|إصلاح", v):
        return "service_repair"
    if re.search(r"inspect|test|certif|فحص", v):
        return "inspection_certification"
    if re.search(r"suppl|sale|sell|furnish|deliver|provi|design|fabricat|توريد", v):
        return "supply_only"
    return None


def _object_chunks(d: _Doc, start: int, end: int) -> list[list[Token]]:
    toks = tokenize(d.text, start, end)
    chunks: list[list[Token]] = []
    cur: list[Token] = []
    for i, t in enumerate(toks):
        if i and not gaps_ok(d.text, [toks[i - 1], t])[0]:
            if "," in d.text[toks[i - 1].end:t.start] and cur:
                chunks.append(cur)
                cur = []
                continue
            break
        if t.norm in _OBJ_STOP:
            if t.norm in ("and", "&", "و", "or", "او") and cur:
                chunks.append(cur)
                cur = []
                continue
            if cur:
                break
            continue
        cur.append(t)
    if cur:
        chunks.append(cur)
    out = []
    for c in chunks:
        while c and (c[0].norm in _OBJ_FILLERS or any(ch.isdigit() for ch in c[0].norm) or len(c[0].norm) < 2):
            c = c[1:]
        while c and (c[-1].norm in _OBJ_TRAILING or any(ch.isdigit() for ch in c[-1].norm)):
            c = c[:-1]
        if c and len(c) <= 6 and c[-1].key not in _GENERIC_HEADS and any(len(t.norm) >= 3 for t in c):
            out.append(c)
    return out


def _mine_offerings(docs: list[_Doc], ctx: _Ctx, reg: _Registry) -> None:
    support: dict[str, dict[str, Any]] = {}  # suffix key -> {"docs", "surfaces", "examples", "wts"}
    for d in docs:
        if d.side != "company":
            continue
        active = d.text[:d.limit]
        matches = list(_OFFER_RE.finditer(active)) + list(_OFFER_AR_RE.finditer(active))
        for m in matches:
            sentence = d.sentence(m.start())
            if _EXCLUSION_RE.search(sentence):
                continue
            o_start, o_end = m.start("obj"), m.end("obj")
            cut = _OBJ_END_RE.search(active, o_start, o_end)
            if cut:
                o_end = cut.start()
            wt = _verbs_work_type(m.group("verbs"))
            for chunk in _object_chunks(d, o_start, o_end):
                gaps = gaps_ok(d.text, chunk)
                known = [x for x in ctx.index.find_tokens(chunk, d.text, gaps)
                         if any(ctx.resolve(e)[0] for e in x.entries)]
                if known:
                    for x in known:
                        fam = next(ctx.resolve(e)[0] for e in x.entries if ctx.resolve(e)[0])
                        acc = reg.get("service_family", fam)
                        if acc.fresh:
                            acc.fresh = False
                            acc.label, acc.label_ar, acc.description = ctx.family_label(fam, x.surface)
                        acc.origins.add("offering_phrase")
                        acc.hit(d, x.start, x.end, surface=x.surface)
                        if wt:
                            acc.meta.setdefault("work_types", Counter())[wt] += 1
                    continue
                for n in range(1, min(3, len(chunk)) + 1):
                    suffix = chunk[-n:]
                    key = " ".join(t.key for t in suffix)
                    entry = support.setdefault(key, {"docs": {}, "surfaces": Counter(), "examples": [], "wts": Counter(),
                                                     "n": n, "head": suffix[-1].key})
                    entry["docs"].setdefault(d.sid, d.stype)
                    surf = d.text[suffix[0].start:suffix[-1].end]
                    entry["surfaces"][surf] += 1
                    if wt:
                        entry["wts"][wt] += 1
                    if len(entry["examples"]) < 8 and all(ex[0] is not d for ex in entry["examples"]):
                        entry["examples"].append((d, suffix[0].start, suffix[-1].end))
    if not support:
        return
    by_head: dict[str, list[str]] = defaultdict(list)
    for key, entry in support.items():
        by_head[entry["head"]].append(key)
    existing = {a.key: a for a in reg.of_kind("service_family")}
    for head, keys in by_head.items():
        def strength(k: str) -> float:
            e = support[k]
            return len(e["docs"]) * (1 + 0.35 * (e["n"] - 1))

        eligible = [k for k in keys if len(support[k]["docs"]) >= 2]
        if not eligible:
            continue
        best = max(eligible, key=lambda k: (strength(k), len(k)))
        entry = support[best]
        surface = entry["surfaces"].most_common(1)[0][0]
        target = _match_existing_family(surface, existing)
        if target is None:
            fkey = slugify(best) if best.isascii() else slugify(surface)
            if reg.find("service_family", fkey) is None and fkey in existing:
                target = existing[fkey]
            else:
                target = reg.get("service_family", fkey)
                if target.fresh:
                    target.fresh = False
                    target.label = surface[:1].upper() + surface[1:]
                    verbs = ", ".join(WORK_TYPES[w]["label"].lower() for w, _ in entry["wts"].most_common(2)
                                      if w in WORK_TYPES)
                    target.description = (f"Learned from {len(entry['docs'])} own documents"
                                          + (f" ({verbs})" if verbs else "") + ".")
                    existing[fkey] = target
        target.origins.add("offering_phrase")
        for s, _n in entry["surfaces"].most_common(6):
            if s not in target.extra_synonyms:
                target.extra_synonyms.append(s)
        for d, s, e in entry["examples"]:
            target.hit(d, s, e, surface=d.text[s:e])
        wt_counts = target.meta.setdefault("work_types", Counter())
        for w, c in entry["wts"].items():
            wt_counts[w] += c


def _match_existing_family(surface: str, existing: Mapping[str, _Acc]) -> _Acc | None:
    try:
        from rapidfuzz import fuzz
    except Exception:  # pragma: no cover - rapidfuzz is a dependency
        return None
    target = normalize_text(surface)
    for acc in existing.values():
        names = [acc.label, *acc.surfaces.keys(), *acc.extra_synonyms]
        for n in names:
            if n and fuzz.token_set_ratio(target, normalize_text(n)) >= 92:
                return acc
    return None


# --------------------------------------------------------------------------------------------
# (c) Company-specific terms: n-grams of own text vs inbound mail
# --------------------------------------------------------------------------------------------

_STOP_EN = frozenset(
    "a about above after again against all also am an and any are as at be because been before being below "
    "between both but by can could did do does doing down during each either etc few for from further had has "
    "have having he her here hers herself him himself his how however i if in into is it its itself just let me "
    "more most my myself no nor not now of off on once only or other ought our ours ourselves out over own per "
    "please same shall she should so some such than that the their theirs them themselves then there these they "
    "this those through thus to too under until up upon us very via was we were what when where which while who "
    "whom why will with within without would yet you your yours yourself yourselves kindly dear sir sirs madam "
    "regards thanks thank hi hello best kind warm sincerely faithfully truly may might must could cc re fw fwd "
    "dated date subject attn attention".split())
_STOP_AR = frozenset(normalize_text(w) for w in (
    "في من على إلى الى عن مع هذا هذه ذلك تلك التي الذي الذين او أو ثم كما قد لقد تم يتم كان كانت يكون ان أن إن "
    "لا ما لم لن هو هي هم نحن انا أنا انت أنت انتم أنتم كل بعض غير بين حتى اذا إذا عند عندما لدى لدي لكم لكن وقد "
    "وان وأن ايضا أيضا حيث منذ خلال ضمن حول نرجو يرجى الرجاء شكرا السيد السادة المحترمين تحية طيبة وبعد مرفق "
    "بخصوص الموضوع رقم تاريخ و ب ل").split())
_STOP_RU = frozenset(
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от "
    "меня еще нет о из ему для мы это при уважением".split())
_GENERIC_WORDS = frozenset(
    "quotation quote offer price prices total amount payment validity delivery company project projects item items "
    "qty quantity unit units nos number email mail phone tel fax mobile office address website www com http https "
    "day days week weeks month months year years time mr mrs ms eng engineer manager team dept department sales "
    "above below following mentioned same new good further regarding required requirement requirements details "
    "detail information info query queries request response reply soon asap today tomorrow yesterday greetings "
    "noted ok okay yes well much many more less including include includes according accordance basis based terms "
    "conditions note notes find attached attachment herewith enclosed reference ref subject kindly please thank "
    "thanks regards dear sir work works service services scope client customer site documents document drawings "
    "drawing copy best kind look forward hearing confirm confirmation receipt received send sent provide provided "
    "advise advice let know need needs us our we you your their".split())


_STD_TOKENS = frozenset({"bs", "en", "iso", "din", "ansi", "asme", "osha", "iec", "nfpa", "astm", "gost", "cfr"})


def _is_brand(text: str) -> bool:
    """``NorthStar``, ``ALIMAK``-style tokens: internal capitals or all caps (3+ letters)."""
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 3 or not all(c.isascii() for c in letters):
        return False
    if all(c.isupper() for c in letters):
        return True
    return text[:1].isupper() and any(c.isupper() for c in text[1:]) and any(c.islower() for c in text)


def _ngram_flags(tokens: list[Token]) -> list[bool]:
    """True for tokens that may appear inside an n-gram."""
    return [t.key.isalpha() and len(t.norm) >= 2 for t in tokens]


def _iter_ngrams(d: _Doc, ok: list[bool], skip: list[bool], max_n: int = 4, max_tokens: int = 4000):
    toks = d.tokens[:max_tokens]
    n = len(toks)
    for i in range(n):
        if skip[i] or not ok[i]:
            continue
        first = toks[i].norm
        if first in _STOP_EN or first in _STOP_AR or first in _STOP_RU:
            continue
        for length in range(1, max_n + 1):
            j = i + length - 1
            if j >= n or skip[j] or not ok[j]:
                break
            if length > 1 and not d.gaps[j - 1]:
                break
            last = toks[j].norm
            if last in _STOP_EN or last in _STOP_AR or last in _STOP_RU:
                continue
            if length == 1 and (first in _GENERIC_WORDS or len(first) < 4):
                continue
            window = toks[i:j + 1]
            if all(t.norm in _GENERIC_WORDS or t.norm in _STOP_EN for t in window):
                continue
            yield " ".join(t.key for t in window), i, j


def _known_parts(index: TermIndex) -> set[str]:
    parts: set[str] = set()
    for key in index:
        toks = key.split(" ")
        for a in range(len(toks)):
            for b in range(a + 1, len(toks) + 1):
                parts.add(" ".join(toks[a:b]))
    return parts


def _mine_ngrams(docs: list[_Doc], ctx: _Ctx, reg: _Registry, *, max_terms: int, max_docs: int = 1500) -> None:
    own = [d for d in docs if d.side == "company"]
    inbound = [d for d in docs if d.side == "customers"]
    if not own:
        return
    prio = {"own_quotation": 0, "company_doc": 1, "sent_email": 2}
    if len(own) > max_docs:
        own = sorted(own, key=lambda d: (prio.get(d.stype, 3), d.order))[:max_docs]
    if len(inbound) > max_docs:
        step = len(inbound) / max_docs
        inbound = [inbound[int(k * step)] for k in range(max_docs)]
    stats: dict[str, list] = {}  # key -> [docs, weight, tf, name-like occurrences, brand-like occurrences]
    flags = {id(d): (_ngram_flags(d.tokens), _skip_flags(d)) for d in own}
    for d in own:
        ok, skip = flags[id(d)]
        seen: set[str] = set()
        for key, i, j in _iter_ngrams(d, ok, skip):
            st = stats.get(key)
            if st is None:
                st = stats[key] = [0, 0.0, 0, 0, 0]
            st[2] += 1
            window = d.tokens[i:j + 1]
            if any(_is_brand(t.text) for t in window):
                st[4] += 1
            elif all(t.text[:1].isupper() for t in window):
                st[3] += 1
            if key not in seen:
                seen.add(key)
                st[0] += 1
                st[1] += d.weight
    min_support = 2 if len(own) >= 3 else 1
    uni_support = max(3, math.ceil(0.3 * len(own)))
    known_parts = _known_parts(ctx.index)
    cands = {}
    for k, st in stats.items():
        if st[0] < min_support or st[2] < 2 or k in known_parts:
            continue
        if st[3] >= 0.8 * st[2]:
            continue  # Title Case every time: a person, project, place or company name, not vocabulary
        if " " not in k and (st[4] < 0.5 * st[2] or st[0] < min(uni_support, 2)):
            continue  # single words count only when brand-like (NorthStar, ALIMAK); phrases carry vocabulary
        if any(t in _STD_TOKENS for t in k.split(" ")):
            continue  # standard-code fragments ("designed to BS EN") are mined as standards
        cands[k] = st
    stats.clear()
    if not cands:
        return
    in_df: Counter = Counter()
    for d in inbound:
        ok = _ngram_flags(d.tokens)
        skip = [False] * len(d.tokens)
        seen = set()
        for key, _i, _j in _iter_ngrams(d, ok, skip):
            if key in cands and key not in seen:
                seen.add(key)
                in_df[key] += 1
    n_in = len(inbound)
    boiler_ratio = 0.6 if len(own) >= 5 else 2.0
    scored = []
    for key, (n_docs, w, tf, _names, brands) in cands.items():
        if " " not in key and brands < 0.5 * tf and in_df[key] > 0:
            continue
        if n_docs / len(own) > boiler_ratio:
            continue
        spec = (math.log((n_in + 1) / (in_df[key] + 1)) + 1.0) if n_in else 1.0
        length = key.count(" ") + 1
        score = w * (1 + 0.3 * math.log(tf)) * spec * (1 + 0.15 * (length - 1))
        scored.append((score, key, n_docs))
    scored.sort(key=lambda x: (-x[0], x[1]))
    scored = scored[:max(60, max_terms * 4)]
    chosen: list[tuple[float, str, int]] = []
    for score, key, n_docs in scored:
        toks = key.split(" ")
        redundant = False
        for _s2, k2, n2 in chosen:
            t2 = k2.split(" ")
            if len(t2) > len(toks) and _contains(t2, toks) and n2 >= 0.8 * n_docs:
                redundant = True
                break
            if len(t2) < len(toks) and _contains(toks, t2) and n_docs >= 0.8 * n2:
                redundant = True  # keep the shorter, equally supported form
                break
        if not redundant:
            chosen.append((score, key, n_docs))
        if len(chosen) >= max_terms:
            break
    if not chosen:
        return
    wanted = {k for _s, k, _n in chosen}
    found: dict[str, list[tuple[_Doc, int, int]]] = defaultdict(list)
    for d in own:
        ok, skip = flags[id(d)]
        seen = set()
        for key, i, j in _iter_ngrams(d, ok, skip):
            if key in wanted and key not in seen:
                seen.add(key)
                found[key].append((d, d.tokens[i].start, d.tokens[j].end))
    for score, key, n_docs in chosen:
        occ = found.get(key)
        if not occ:
            continue
        acc = reg.get("term", f"ngram:{slugify(key)}")
        acc.fresh = False
        acc.origins.add("ngram")
        types = {d.stype for d, _s, _e in occ}
        for d, s, e in occ[:12]:
            acc.hit(d, s, e, surface=d.text[s:e])
        top_surface = acc.surfaces.most_common(1)[0][0]
        acc.label = top_surface
        acc.language = detect_language(top_surface) or "en"
        sub = ctx.index.find(top_surface)
        family = next((ctx.resolve(e)[0] for x in sub for e in x.entries if ctx.resolve(e)[0]), None)
        acc.meta.update({"origin": "ngram", "own_docs": n_docs, "inbound_docs": int(in_df[key]),
                         "category": family})
        acc.description = (f"Company-specific wording: used in {n_docs} of your own documents"
                           + (f", {in_df[key]} customer e-mails" if in_df[key] else ", not by customers") + ".")
        acc.preset = (sum(SOURCE_WEIGHTS[d.stype] for d, _s, _e in occ), types)


def _contains(big: list[str], small: list[str]) -> bool:
    n = len(small)
    return any(big[i:i + n] == small for i in range(len(big) - n + 1))


# --------------------------------------------------------------------------------------------
# (d) Standards
# --------------------------------------------------------------------------------------------

_STD_PATTERNS: list[re.Pattern] = [
    re.compile(r"\b(?:(?:BS|DIN|NF|UNI|SS|NS|DS|ÖNORM|OENORM|PN|CSN|SN|I\.S\.)\s+)?EN(?:\s+ISO)?\s?\d{2,5}(?:-\d{1,3})*"
               r"(?::\s?(?:19|20)\d{2}(?:\+A\d{1,2}:(?:19|20)\d{2})*)?"),
    re.compile(r"\bCEN/TS\s?\d{3,5}(?:-\d{1,3})*"),
    re.compile(r"\bBS\s?(?!EN\b)(?:ISO\s)?\d{3,5}(?:-\d{1,3})*(?::\s?(?:19|20)\d{2})?"),
    re.compile(r"\bISO(?:/IEC)?\s?\d{3,5}(?:-\d{1,3})*(?::\s?(?:19|20)\d{2})?"),
    re.compile(r"\bIEC\s?\d{3,5}(?:-\d{1,3})*(?::\s?(?:19|20)\d{2})?"),
    re.compile(r"\bDIN\s?(?!EN\b)\d{3,5}(?:-\d{1,3})*"),
    re.compile(r"\bANSI(?:/[A-Z]{2,6})?\s?[A-Z]{0,2}-?\d{1,4}(?:\.\d{1,3})*(?:-(?:19|20)\d{2})?"),
    re.compile(r"\bASME\s?[A-Z]{1,2}\d{1,4}(?:\.\d{1,3})*(?:-(?:19|20)\d{2})?"),
    re.compile(r"\b(?:OSHA\s?(?:29\s?CFR\s?)?|29\s?CFR\s?)(?:Part\s)?\d{4}(?:\.\d{1,4})?"),
    re.compile(r"\bAS(?:/NZS)?\s\d{4}(?:\.\d{1,2})*(?::\s?(?:19|20)\d{2})?"),
    re.compile(r"\bNFPA\s?\d{1,4}[A-Z]?"),
    re.compile(r"\bAISC\s?\d{3}"),
    re.compile(r"(?:\bGOST|ГОСТ)\s?(?:R\s|Р\s)?(?:ISO\s?|ИСО\s?|EN\s?|ЕН\s?)?\d{1,5}(?:[.\-]\d{1,5})*"),
    re.compile(r"(?:\bSP|СП)\s?\d{1,3}\.\d{5}(?:\.(?:19|20)\d{2})?"),
    re.compile(r"(?:\bSNiP|СНиП)\s?\d{1,2}[.\-]\d{2}[.\-]\d{2,4}(?:-\d{2,4})?"),
]
_STD_REGION = {"EN": "UK_EU", "CEN/TS": "UK_EU", "BS": "UK_EU", "DIN": "UK_EU", "ISO": "global", "IEC": "global",
               "ANSI": "US", "ASME": "US", "OSHA": "US", "NFPA": "US", "AISC": "US", "AS": "global",
               "AS/NZS": "global", "GOST": "RU_CIS", "SP": "RU_CIS", "SNIP": "RU_CIS", "IS": "SOUTH_ASIA"}
_GENERIC_STD_PREFIXES = frozenset({"ANSI", "ASME", "OSHA", "GOST", "ISO", "IEC", "DIN", "ASTM", "AISC", "NFPA",
                                   "ASSP", "SAIA", "IWCA", "CEN", "BS", "EN", "SP", "IS"})
_CYR_PREFIX = {"ГОСТ": "GOST", "СНИП": "SNIP", "СП": "SP", "ИСО": "ISO", "ЕН": "EN", "Р": "R"}


def canonical_standard(code: str) -> tuple[str, str | None]:
    """``"BS EN 1808:2015"`` -> ``("EN 1808", "2015")``; ``"29 CFR 1910.66"`` -> ``("OSHA 1910.66", None)``."""
    c = re.sub(r"\s+", " ", (code or "").strip()).upper()
    for cyr, lat in _CYR_PREFIX.items():
        c = re.sub(rf"(?<![\w]){cyr}(?![\w])", lat, c)
    c = c.replace("СНИП", "SNIP")
    c = re.sub(r"^([A-Z]+(?:/[A-Z]+)?)(\d)", r"\1 \2", c)
    year = None
    m = re.search(r":\s?((?:19|20)\d{2})(?:\+A\d+:(?:19|20)\d{2})*$", c)
    if m:
        year = m.group(1)
        c = c[:m.start()].strip()
    else:
        m = re.search(r"(?<=\d)-((?:19|20)\d{2})$", c)
        if m and "." in c[:m.start()]:
            year = m.group(1)
            c = c[:m.start()].strip()
    c = re.sub(r"^(?:BS|DIN|NF|UNI|SS|NS|DS|ÖNORM|OENORM|PN|CSN|SN|I\.S\.)\s+(?=EN\b)", "", c)
    c = re.sub(r"^(?:EN|BS|DIN)\s+ISO\b", "ISO", c)
    c = re.sub(r"^(?:OSHA\s*)?29\s?CFR\s?(?:PART\s)?", "OSHA ", c)
    c = re.sub(r"^OSHA\s+29\s?CFR\s?", "OSHA ", c)
    c = re.sub(r"^ANSI/[A-Z]+\s", "ANSI ", c)
    c = re.sub(r"\s*\(.*?\)\s*", " ", c).strip()
    return re.sub(r"\s+", " ", c), year


def _std_base(code: str) -> str:
    c = re.sub(r"[.:\-]\s?(?:19|20)\d{2}$", "", code)
    c = re.sub(r"-\d{1,3}$", "", c)
    return c


def _std_family(code: str) -> str:
    return code.split(" ", 1)[0]


def _mine_standards(docs: list[_Doc], standards: list[dict], reg: _Registry) -> None:
    known: dict[str, dict] = {}
    by_base: dict[str, list[dict]] = defaultdict(list)
    lit_entries = []
    for s in standards:
        canon, _y = canonical_standard(s["code"])
        known.setdefault(canon, s)
        by_base[_std_base(canon)].append(s)
        terms = {s["code"], re.sub(r"\s*\(.*?\)", "", s["code"]).strip()}
        no_year = re.sub(r"\s+(?:19|20)\d{2}$", "", s["code"]).strip()
        terms.add(no_year)
        first = s["code"].split(" ", 1)[0]
        if " " in s["code"] and first.isalpha() and first.isupper() and len(first) >= 4 and \
                first not in _GENERIC_STD_PREFIXES:
            terms.add(first)
        for t in terms:
            e = make_entry(t, concept=canon, canonical=s["code"], category="standard", origin="standard")
            if e is not None:
                lit_entries.append(e)
    lit_index = TermIndex(lit_entries)
    for d in docs:
        active = d.text[:d.limit]
        spans: list[tuple[int, int, str]] = []
        for rx in _STD_PATTERNS:
            for m in rx.finditer(active):
                spans.append((m.start(), m.end(), m.group(0)))
        for m in lit_index.find_tokens(d.tokens, d.text, d.gaps):
            spans.append((m.start, m.end, "\x00" + m.entries[0].concept))
        spans.sort(key=lambda x: (x[0], -(x[1] - x[0])))
        taken_end = -1
        for s, e, raw in spans:
            if s < taken_end:
                continue
            taken_end = e
            if raw.startswith("\x00"):
                canon, year = raw[1:], None
                surface = d.text[s:e]
            else:
                surface = raw.strip()
                canon, year = canonical_standard(surface)
            if not re.search(r"\d", canon) and canon not in known:
                continue
            info = known.get(canon)
            if info is None:
                cands = by_base.get(_std_base(canon)) or []
                if not cands:
                    for b, lst in by_base.items():
                        if canon.startswith(b + ".") or canon.startswith(b + "-"):
                            cands = lst
                            break
                info = cands[0] if cands else None
            key = slugify(canon)
            acc = reg.get("standard", key)
            if acc.fresh:
                acc.fresh = False
                fam = _std_family(canon)
                regions = list(info["region"]) if info else [_STD_REGION.get(fam, "global")]
                acc.region = next((r for r in regions if not is_neutral_region(r)), regions[0] if regions else None)
                acc.description = info["title"] if info else ""
                acc.value = canon
                acc.meta.update({"code": canon, "title": info["title"] if info else "",
                                 "library_code": info["code"] if info else None,
                                 "applies_to": list(info["applies_to"]) if info else [], "regions": regions,
                                 "known": info is not None, "years": set()})
            if year:
                acc.meta["years"].add(year)
            if surface.upper().startswith("BS EN"):
                acc.meta["naming"] = "UK_EU"
            acc.origins.add("pattern")
            acc.hit(d, s, e, surface=surface)
    for acc in reg.of_kind("standard"):
        acc.label = acc.surfaces.most_common(1)[0][0] if acc.surfaces else acc.meta.get("code", acc.key)


# --------------------------------------------------------------------------------------------
# (e) Conventions and identity
# --------------------------------------------------------------------------------------------

_REF_LABELED_RE = re.compile(
    r"(?i)\b(?:our\s+ref(?:erence)?|ref(?:erence)?(?:\s*(?:no|number|#))?|quotation\s*(?:no|number|ref(?:erence)?|#)?"
    r"|quote\s*(?:no|ref)|offer\s*(?:no|ref)|proposal\s*no|رقم\s+المرجع|المرجع|رقم\s+العرض)\s*\.?\s*[:#]?\s*"
    r"(?P<ref>[A-Za-z0-9][A-Za-z0-9]*(?:[/\-_.][A-Za-z0-9]+){1,5})")
_REF_SHAPE_RE = re.compile(r"\b[A-Z]{1,5}(?:[/\-][A-Z]{0,4}\d{1,6}){2,4}\b")
_DATE_LIKE_RE = re.compile(r"^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$")


def _ref_candidates(d: _Doc) -> list[tuple[str, int, int]]:
    active = d.text[:d.limit]
    out: dict[str, tuple[str, int, int]] = {}
    for m in _REF_LABELED_RE.finditer(active):
        before = active[max(0, m.start() - 8):m.start()].lower()
        if "your" in before:
            continue
        ref = m.group("ref").rstrip(".")
        if _DATE_LIKE_RE.match(ref) or not re.search(r"\d", ref) or len(ref) < 5 or "@" in ref:
            continue
        out.setdefault(ref.upper(), (ref, m.start("ref"), m.start("ref") + len(ref)))
    for m in _REF_SHAPE_RE.finditer(active):
        ref = m.group(0)
        before = active[max(0, m.start() - 20):m.start()].lower()
        if "your" in before:
            continue
        out.setdefault(ref.upper(), (ref, m.start(), m.end()))
    return list(out.values())


def _ref_segments(ref: str) -> tuple[list[str], list[str]]:
    parts = re.split(r"([/\-_.])", ref.upper())
    return parts[0::2], parts[1::2]


def _mine_references(docs: list[_Doc], reg: _Registry) -> None:
    groups: dict[str, list[tuple[str, _Doc, int, int]]] = defaultdict(list)
    for d in docs:
        if d.side != "company":
            continue
        for ref, s, e in _ref_candidates(d):
            shape = re.sub(r"\d", "9", re.sub(r"[A-Za-z]", "A", ref.upper()))
            groups[shape].append((ref, d, s, e))
    ranked = []
    for shape, lst in groups.items():
        docs_all = {d.sid for _r, d, _s, _e in lst}
        docs_q = {d.sid for _r, d, _s, _e in lst if d.stype == "own_quotation"}
        if len(docs_all) < 2 and not docs_q:
            continue
        ranked.append((len(docs_q), len(docs_all), shape))
    ranked.sort(reverse=True)
    for rank, (_nq, n_docs, shape) in enumerate(ranked[:2]):
        lst = groups[shape]
        segs = [_ref_segments(r) for r, _d, _s, _e in lst]
        n_seg = len(segs[0][0])
        if any(len(s[0]) != n_seg for s in segs):
            continue
        seps = segs[0][1]
        parts: list[dict[str, Any]] = []  # typed: literal | letters | year | sequence | code
        years = [d.year for _r, d, _s, _e in lst]
        for i in range(n_seg):
            values = [s[0][i] for s in segs]
            ln = len(values[0])
            if all(v.isalpha() for v in values):
                parts.append({"type": "literal", "value": values[0]} if len(set(values)) == 1
                             else {"type": "letters", "length": ln})
            elif all(v.isdigit() for v in values):
                ints = [int(v) for v in values]
                if ln == 4 and all(1990 <= x <= 2100 for x in ints):
                    parts.append({"type": "year", "digits": 4})
                elif ln == 2 and i < n_seg - 1 and (
                        all(y is not None and abs((y % 100) - x) <= 1 for x, y in zip(ints, years))
                        or (all(15 <= x <= 45 for x in ints) and len(set(ints)) <= 3)):
                    parts.append({"type": "year", "digits": 2})
                elif len(set(values)) == 1 and i < n_seg - 1:
                    parts.append({"type": "literal", "value": values[0]})
                else:
                    parts.append({"type": "sequence", "digits": ln})
            else:
                parts.append({"type": "code", "length": ln})

        def show(p: dict) -> str:
            return {"literal": lambda: p.get("value", ""), "letters": lambda: "A" * p["length"],
                    "year": lambda: "Y" * p["digits"], "sequence": lambda: "N" * p["digits"],
                    "code": lambda: "X" * p["length"]}[p["type"]]()

        def rx_of(p: dict) -> str:
            return {"literal": lambda: re.escape(p.get("value", "")), "letters": lambda: f"[A-Z]{{{p['length']}}}",
                    "year": lambda: rf"\d{{{p['digits']}}}", "sequence": lambda: rf"\d{{{p['digits']}}}",
                    "code": lambda: f"[A-Z0-9]{{{p['length']}}}"}[p["type"]]()

        pattern = "".join(show(p) + (seps[i] if i < len(seps) else "") for i, p in enumerate(parts))
        rx = r"\b" + "".join(rx_of(p) + (re.escape(seps[i]) if i < len(seps) else "")
                             for i, p in enumerate(parts)) + r"\b"
        examples = list(dict.fromkeys(r for r, _d, _s, _e in lst))
        latest = max(examples, key=lambda r: [int(x) if x.isdigit() else 0 for x in _ref_segments(r)[0]])
        seq_idx = max((i for i, p in enumerate(parts) if p["type"] == "sequence"), default=None)
        nxt = None
        if seq_idx is not None:
            latest_parts, latest_seps = _ref_segments(latest)
            digits = parts[seq_idx]["digits"]
            latest_parts[seq_idx] = str(int(latest_parts[seq_idx]) + 1).zfill(digits)
            nxt = "".join(p + (latest_seps[i] if i < len(latest_seps) else "") for i, p in enumerate(latest_parts))
        key = "reference_format" if rank == 0 else "reference_format_2"
        acc = reg.get("convention", key)
        acc.fresh = False
        acc.origins.add("pattern")
        acc.label = f"Reference format {pattern}"
        acc.description = (f"Quotation/reference numbers follow {pattern} "
                           f"(seen in {n_docs} own documents, e.g. {', '.join(examples[:3])}).")
        year_part = next((p for p in parts if p["type"] == "year"), None)
        acc.value = {"pattern": pattern, "regex": rx, "parts": parts, "separator": seps[0] if seps else "",
                     "prefix": next((p["value"] for p in parts if p["type"] == "literal" and p["value"].isalpha()),
                                    None),
                     "year_format": ("Y" * year_part["digits"]) if year_part else None,
                     "sequence_digits": parts[seq_idx]["digits"] if seq_idx is not None else None,
                     "examples": examples[:6], "latest": latest, "next": nxt}
        for r, d, s, e in lst:
            acc.hit(d, s, e, surface=r)


_CURRENCY_PATTERNS: dict[str, list[str]] = {
    "KWD": [r"\bKWD\b", r"\bK\.\s?D\b\.?", r"\bKD\b", r"د\.\s?ك"],
    "AED": [r"\bAED\b", r"\bDhs\b\.?", r"د\.\s?إ"],
    "SAR": [r"\bSAR\b", r"\bS\.R\b\.?", r"ر\.\s?س"],
    "QAR": [r"\bQAR\b", r"\bQR\b"],
    "BHD": [r"\bBHD\b", r"\bB\.D\b\.?"],
    "OMR": [r"\bOMR\b", r"\bR\.O\b\.?"],
    "USD": [r"\bUSD\b", r"\bUS\s?\$", r"(?<![A-Z])\$\s?\d"],
    "EUR": [r"\bEUR\b", r"€"],
    "GBP": [r"\bGBP\b", r"£"],
    "RUB": [r"\bRUB\b", r"₽", r"(?i)\bруб\b\.?"],
    "EGP": [r"\bEGP\b", r"\bL\.E\b\.?"],
    "INR": [r"\bINR\b", r"₹"],
    "JOD": [r"\bJOD\b"],
}
_CURRENCY_RES = {code: [re.compile(p) for p in pats] for code, pats in _CURRENCY_PATTERNS.items()}
_AMOUNT_RE = re.compile(r"(?<![\d.])\d{1,3}(?:[,\s]\d{3})*(?:\.(\d{1,3}))?(?![\d])|(?<![\d.])\d+\.(\d{1,3})(?!\d)")


def _mine_currency(docs: list[_Doc], reg: _Registry) -> None:
    scores: Counter = Counter()
    hits: dict[str, list[tuple[_Doc, int, int, str]]] = defaultdict(list)
    decimals: dict[str, Counter] = defaultdict(Counter)
    symbols: dict[str, Counter] = defaultdict(Counter)
    for d in docs:
        if d.side != "company":
            continue
        active = d.text[:d.limit]
        for code, rxs in _CURRENCY_RES.items():
            found = False
            for rx in rxs:
                for m in rx.finditer(active):
                    found = True
                    sym = m.group(0).strip()
                    symbols[code][re.sub(r"\s?\d$", "", sym)] += 1
                    if len(hits[code]) < 40:
                        hits[code].append((d, m.start(), m.end(), sym))
                    window = active[max(0, m.start() - 24):m.end() + 24]
                    for am in _AMOUNT_RE.finditer(window):
                        dec = am.group(1) or am.group(2)
                        if dec:
                            decimals[code][len(dec)] += 1
            if found:
                scores[code] += d.weight
    if not scores:
        return
    code, score = scores.most_common(1)[0]
    docs_with = {h[0].sid for h in hits[code]}
    if len(docs_with) < 2 and not any(h[0].stype == "own_quotation" for h in hits[code]):
        return
    dec = decimals[code].most_common(1)[0][0] if decimals[code] else None
    acc = reg.get("convention", "currency")
    acc.fresh = False
    acc.origins.add("pattern")
    acc.label = f"Currency {code}" + (f" ({dec} decimals)" if dec is not None else "")
    acc.description = f"Prices are written in {code}" + (f" with {dec} decimals" if dec is not None else "") + "."
    others = {c: round(s, 2) for c, s in scores.items() if c != code}
    acc.value = {"code": code, "decimals": dec, "symbols": [s for s, _ in symbols[code].most_common(4)],
                 "other_currencies": others}
    for d, s, e, sym in hits[code]:
        acc.hit(d, s, e, surface=sym)


_DATE_NUM_RE = re.compile(r"(?<![\d/.\-])(\d{1,2})([/.\-])(\d{1,2})\2(\d{4}|\d{2})(?![\d/.\-])")
_DATE_ISO_RE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")
_MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_DATE_DMY_TEXT_RE = re.compile(rf"(?i)\b\d{{1,2}}(?:st|nd|rd|th)?[\s\-]+{_MONTHS},?[\s\-]+\d{{4}}\b")
_DATE_MDY_TEXT_RE = re.compile(rf"(?i)\b{_MONTHS}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}\b")


def _mine_date_format(docs: list[_Doc], reg: _Registry) -> None:
    votes: Counter = Counter()
    seps: Counter = Counter()
    year_len: Counter = Counter()
    examples: dict[str, list[tuple[_Doc, int, int]]] = defaultdict(list)
    for d in docs:
        if d.side != "company":
            continue
        active = d.text[:d.limit]
        for m in _DATE_NUM_RE.finditer(active):
            a, b = int(m.group(1)), int(m.group(3))
            if not (1 <= a <= 31 and 1 <= b <= 31):
                continue
            seps[m.group(2)] += 1
            year_len[len(m.group(4))] += 1
            if a > 12 and b <= 12:
                kind = "dmy"
            elif b > 12 and a <= 12:
                kind = "mdy"
            else:
                kind = "num_ambiguous"
            votes[kind] += 1
            examples[kind].append((d, m.start(), m.end()))
        for rx, kind in ((_DATE_ISO_RE, "iso"), (_DATE_DMY_TEXT_RE, "dmy_text"), (_DATE_MDY_TEXT_RE, "mdy_text")):
            for m in rx.finditer(active):
                votes[kind] += 1
                examples[kind].append((d, m.start(), m.end()))
    if not votes:
        return
    sep = seps.most_common(1)[0][0] if seps else "/"
    yl = "YYYY" if (year_len.most_common(1)[0][0] if year_len else 4) == 4 else "YY"
    dmy = votes["dmy"] + 0.5 * votes["dmy_text"]
    mdy = votes["mdy"] + 0.5 * votes["mdy_text"]
    if votes["iso"] > max(dmy, mdy, votes["num_ambiguous"]):
        fmt, kinds = "YYYY-MM-DD", ["iso"]
    elif dmy > mdy:
        fmt, kinds = f"DD{sep}MM{sep}{yl}", ["dmy", "num_ambiguous", "dmy_text"]
    elif mdy > dmy:
        fmt, kinds = f"MM{sep}DD{sep}{yl}", ["mdy", "num_ambiguous", "mdy_text"]
    else:
        return  # numeric dates only and nothing tells day-first from month-first
    acc = reg.get("convention", "date_format")
    acc.fresh = False
    acc.origins.add("pattern")
    acc.label = f"Date format {fmt}"
    acc.description = f"Dates are written {fmt}."
    exs = [ex for k in kinds for ex in examples.get(k, [])]
    acc.value = {"format": fmt, "examples": list(dict.fromkeys(d.text[s:e] for d, s, e in exs))[:5]}
    for d, s, e in exs[:30]:
        acc.hit(d, s, e, surface=d.text[s:e])


def _mine_language_mix(docs: list[_Doc], reg: _Registry) -> None:
    own = [d for d in docs if d.side == "company"]
    if not own:
        return
    weights: Counter = Counter()
    bilingual = 0
    first_of: dict[str, _Doc] = {}
    for d in own:
        active = d.text[:d.limit]
        c = script_counts(active)
        total = sum(c.values()) or 1
        lang = d.doc.language or detect_language(active) or "en"
        weights[lang] += d.weight
        first_of.setdefault(lang, d)
        if c["arabic"] / total >= 0.15 and c["latin"] / total >= 0.15:
            bilingual += 1
    total_w = sum(weights.values()) or 1.0
    shares = {k: round(v / total_w, 3) for k, v in weights.most_common()}
    acc = reg.get("convention", "language_mix")
    acc.fresh = False
    acc.origins.add("statistics")
    acc.preset = (sum(d.weight for d in own), {d.stype for d in own})
    main = ", ".join(f"{k} {round(100 * v)}%" for k, v in shares.items())
    acc.label = f"Languages: {main}"
    acc.description = f"Own documents by language: {main}; bilingual documents: {bilingual}."
    acc.value = {"shares": shares, "bilingual_docs": bilingual, "documents": len(own)}
    for lang, d in first_of.items():
        if d.sents.spans:
            s, e = d.sents.spans[0]
            acc.hit(d, s, e)


_TERM_LABELS: dict[str, str] = {
    "payment": r"payment(?:\s+terms?)?|terms\s+of\s+payment|شروط\s+الدفع|الدفع",
    "validity": r"(?:offer\s+)?validity|validity\s+of\s+(?:the\s+)?offer|صلاحية\s+العرض|الصلاحية",
    "delivery": r"delivery(?:\s+(?:period|time|terms))?|supply\s*/\s*delivery|lead\s+time|completion(?:\s+period)?|"
                r"مدة\s+التوريد|التسليم",
    "warranty": r"warranty|guarantee|الضمان|الكفالة",
    "exclusions": r"exclusions?|الاستثناءات",
    "price_basis": r"price\s+basis|prices?\s+(?:are|basis)|incoterms?",
}
_TERM_LABEL_NAMES = {"payment": "Payment terms", "validity": "Offer validity", "delivery": "Delivery",
                     "warranty": "Warranty", "exclusions": "Exclusions", "price_basis": "Price basis"}
_TERM_SEG_RE = re.compile(
    r"(?im)(?:^|\t| {2,})[ \t•\-*]*(?P<label>" + "|".join(f"(?:{v})" for v in _TERM_LABELS.values()) +
    r")\s*[:\-–]\s*(?P<value>[^\t\n]+?)(?=\t| {2,}|$)")


def _mine_commercial_terms(docs: list[_Doc], reg: _Registry) -> None:
    found: dict[str, list[tuple[_Doc, int, int, str]]] = defaultdict(list)
    for d in docs:
        if d.stype not in ("own_quotation", "company_doc"):
            continue
        active = d.text[:d.limit]
        for m in _TERM_SEG_RE.finditer(active):
            label_text = m.group("label")
            value = m.group("value").strip()
            if len(value) < 2 or len(value) > 220:
                continue
            key = next((k for k, rx in _TERM_LABELS.items() if re.fullmatch(rx, label_text, re.I)), None)
            if key is None:
                continue
            found[key].append((d, m.start("label"), m.end("value"), value))
    for key, lst in found.items():
        variants = Counter(squash(v) for *_x, v in lst)
        top_norm, _c = variants.most_common(1)[0]
        text = next(v for *_x, v in lst if squash(v) == top_norm)
        acc = reg.get("convention", f"commercial_terms.{key}")
        acc.fresh = False
        acc.origins.add("pattern")
        acc.label = f"{_TERM_LABEL_NAMES[key]}: {text}"[:160]
        acc.description = f"{_TERM_LABEL_NAMES[key]} as written in own quotations."
        acc.value = {"label": _TERM_LABEL_NAMES[key], "text": text,
                     "variants": [next(v for *_x, v in lst if squash(v) == n) for n, _ in variants.most_common(4)]}
        for d, s, e, v in lst[:20]:
            acc.hit(d, s, e, surface=v)


_ADDRESSEE_RE = re.compile(r"(?i)^\s*(?:to|attn|attention|dear|m/s|messrs|client|customer|project|subject|re|"
                           r"your\s+ref|our\s+client|consultant|owner|إلى|الى|السادة|المحترمين|مشروع)\b")
_SEGMENT_SPLIT_RE = re.compile(r"\s*(?:\||•|·|\s-\s|\s–\s|\s—\s)\s*")


def _segments(text: str, s: int, e: int) -> list[tuple[int, int]]:
    out = []
    pos = s
    for m in _SEGMENT_SPLIT_RE.finditer(text, s, e):
        if m.start() > pos:
            out.append((pos, m.start()))
        pos = m.end()
    if e > pos:
        out.append((pos, e))
    return [(a, b) for a, b in out if b > a]


def _identity_lines(d: _Doc) -> list[tuple[int, int]]:
    lines = _line_spans(d.text, 0, d.limit)
    picked: dict[tuple[int, int], None] = {}
    sig = extract_signature(d.text[:d.limit])
    if sig:
        for ln in lines:
            if sig[0] <= ln[0] < sig[1]:
                picked[ln] = None
    if d.stype in ("own_quotation", "company_doc"):
        for ln in lines[:8] + lines[-12:]:
            picked[ln] = None
    return list(picked)


def _mine_identity(docs: list[_Doc], reg: _Registry) -> None:
    own = [d for d in docs if d.side == "company"]
    if not own:
        return
    cls_docs: dict[str, dict[str, dict]] = {"legal_name": {}, "address": {}, "website": {}, "email": {}}
    phones: dict[str, dict] = {}
    closings: Counter = Counter()
    own_domains: Counter = Counter()
    for d in own:
        dom = email_domain((d.doc.meta or {}).get("from_email"))
        if dom:
            own_domains[dom] += 1
    domain_tokens = {t for dom in own_domains for t in re.split(r"[\W_]+", dom.split(".")[0]) if len(t) >= 3}

    def add(cls: str, norm: str, d: _Doc, s: int, e: int) -> None:
        slot = cls_docs[cls].setdefault(norm, {"docs": {}, "hits": [], "surfaces": Counter()})
        slot["docs"].setdefault(d.sid, d.stype)
        slot["surfaces"][d.text[s:e]] += 1
        if len(slot["hits"]) < 24:
            slot["hits"].append((d, s, e))

    for d in own:
        active = d.text[:d.limit]
        for m in CLOSING_RE.finditer(active):
            closings[m.group(0).strip().rstrip(",")] += 1
        for ls, le in _identity_lines(d):
            line = d.text[ls:le]
            if len(line) > 200:
                continue
            for m in WEBSITE_RE.finditer(line):
                norm = re.sub(r"^(?:https?://)?(?:www\.)?", "", m.group(0).lower()).rstrip("/")
                add("website", norm, d, ls + m.start(), ls + m.end())
            for m in EMAIL_RE.finditer(line):
                add("email", m.group(0).lower(), d, ls + m.start(), ls + m.end())
            for kind, num, s, e in find_phones(line):
                slot = phones.setdefault(num, {"docs": {}, "hits": [], "kind": Counter()})
                slot["docs"].setdefault(d.sid, d.stype)
                slot["kind"][kind] += 1
                if len(slot["hits"]) < 12:
                    slot["hits"].append((d, ls + s, ls + e))
            if _ADDRESSEE_RE.match(line):
                continue
            contact = [m.start() for rx in (PHONE_LABELED_RE, PHONE_INTL_RE, EMAIL_RE, WEBSITE_RE)
                       for m in [rx.search(line)] if m]
            head = line[:min(contact)] if contact else line
            head = head.rstrip(" -|,;:(\u2013\u2014")
            if head and ADDRESS_RE.search(head) and not LEGAL_SUFFIX_RE.search(head) and \
                    2 <= len(head.split()) <= 25 and len(head) >= 10:
                add("address", squash(head), d, ls, ls + len(head))
                continue
            for s, e in _segments(d.text, ls, le):
                part = d.text[s:e].strip(" ,;:")
                if not part:
                    continue
                s2 = d.text.find(part, s, e)
                e2 = s2 + len(part)
                words = len(part.split())
                if EMAIL_RE.search(part) or WEBSITE_RE.search(part) or find_phones(part):
                    continue
                if LEGAL_SUFFIX_RE.search(part) and 2 <= words <= 12 and not re.search(r"\d{3,}", part):
                    add("legal_name", squash(part), d, s2, e2)
                elif ADDRESS_RE.search(part) and 2 <= words <= 25 and len(part) >= 10:
                    add("address", squash(part), d, s2, e2)

    n_own = len(own)
    need = 1 if n_own == 1 else 2

    def best(cls: str, bonus=None) -> tuple[str, dict] | None:
        options = []
        for norm, slot in cls_docs[cls].items():
            nd = len(slot["docs"])
            if nd < need:
                continue
            score = nd + 0.5 * sum(1 for t in slot["docs"].values() if t == "own_quotation")
            if bonus:
                score += bonus(norm)
            options.append((score, len(norm), norm))
        if not options:
            return None
        options.sort(reverse=True)
        norm = options[0][2]
        return norm, cls_docs[cls][norm]

    def emit(key: str, label: str, value: Any, desc: str, slot: dict, *, kind: str = "identity") -> _Acc:
        acc = reg.get(kind, key)
        acc.fresh = False
        acc.origins.add("signature")
        acc.label = label
        acc.value = value
        acc.description = desc
        for d, s, e in slot["hits"]:
            acc.hit(d, s, e, surface=d.text[s:e])
        return acc

    legal = best("legal_name", bonus=lambda n: 2.0 if domain_tokens & set(n.split()) else 0.0)
    address = best("address")
    website = best("website")
    values: dict[str, Any] = {}
    if legal:
        norm, slot = legal
        surface = slot["surfaces"].most_common(1)[0][0].strip(" ,;:")
        values["legal_name"] = surface
        acc = emit("legal_name", surface, surface, "Company name as written in own letterheads and signatures.", slot)
        acc.extra_synonyms = [s for s, _ in slot["surfaces"].most_common(4) if s != surface]
    if address:
        norm, slot = address
        surface = slot["surfaces"].most_common(1)[0][0].strip(" ,;:")
        values["address"] = surface
        emit("address", surface, surface, "Address used in own letterheads and signatures.", slot)
    if website:
        norm, slot = website
        values["website"] = norm
        emit("website", norm, norm, "Company website named in own documents.", slot)
    phone_list = []
    for num, slot in sorted(phones.items(), key=lambda kv: (-len(kv[1]["docs"]), kv[0])):
        if len(slot["docs"]) >= need and len(phone_list) < 4:
            phone_list.append({"kind": slot["kind"].most_common(1)[0][0], "number": num})
    if phone_list:
        hits = [h for num in (p["number"] for p in phone_list) for h in phones[num]["hits"]]
        values["phones"] = phone_list
        emit("phones", ", ".join(p["number"] for p in phone_list), phone_list,
             "Phone and fax numbers repeated in own signatures.", {"hits": hits})
    email_slots = [(norm, slot) for norm, slot in cls_docs["email"].items() if len(slot["docs"]) >= need]
    domains = Counter()
    for norm, slot in email_slots:
        domains[norm.split("@", 1)[1]] += len(slot["docs"])
    for dom, c in own_domains.items():
        domains[dom] += c
    if email_slots:
        dom_list = [dmn for dmn, _ in domains.most_common(3)]
        role = sorted({n for n, _s in email_slots if n.split("@", 1)[1] in dom_list},
                      key=lambda n: (-len(cls_docs["email"][n]["docs"]), n))[:4]
        hits = [h for n in role for h in cls_docs["email"][n]["hits"]][:12]
        if hits:
            values["email_domains"] = dom_list
            values["emails"] = role
            emit("email_domains", ", ".join(dom_list), {"domains": dom_list, "addresses": role},
                 "E-mail domains the company writes from.", {"hits": hits})
    if values:
        slot_hits = []
        for k in ("legal_name", "address"):
            a = reg.find("identity", k)
            if a is not None:
                slot_hits.extend((c.sid, c) for c in a.cands.values())
        acc = reg.get("convention", "signature_block")
        acc.fresh = False
        acc.origins.add("signature")
        closing = closings.most_common(1)[0][0] if closings else None
        acc.value = {"closing": closing, **{k: values.get(k) for k in ("legal_name", "address", "phones", "website")}}
        acc.label = "Signature block" + (f": {values['legal_name']}" if values.get("legal_name") else "")
        acc.description = "How own letters and e-mails are signed off" + (f" ('{closing}')" if closing else "") + "."
        for k in ("legal_name", "address", "phones", "website"):
            a = reg.find("identity", k)
            if a is None:
                continue
            for sid, h in a.docs.items():
                acc.docs.setdefault(sid, _Hit(h.stype, h.mentions, h.affirmed))
            for sid, c in a.cands.items():
                acc.cands.setdefault(sid, c)


# --------------------------------------------------------------------------------------------
# Optional AI refinement
# --------------------------------------------------------------------------------------------

_AI_LIST_KINDS = {"service_families": "service_family", "services": "service_family", "families": "service_family",
                  "work_types": "work_type", "terms": "term", "vocabulary": "term", "standards": "standard",
                  "conventions": "convention"}
_AI_KIND_ALIASES = {"product": "term", "brand": "term", "family": "service_family", "service": "service_family"}


def _ai_items(result: Any) -> list[dict]:
    result = as_plain(result)
    if result is None:
        return []
    if isinstance(result, list):
        return [as_plain(x) for x in result if isinstance(as_plain(x), dict)]
    if not isinstance(result, dict):
        return []
    out: list[dict] = []
    for k in ("items", "knowledge", "findings"):
        if isinstance(result.get(k), list):
            out += [dict(as_plain(x)) for x in result[k] if isinstance(as_plain(x), dict)]
    for k, kind in _AI_LIST_KINDS.items():
        v = result.get(k)
        if isinstance(v, list):
            for x in v:
                x = as_plain(x)
                if isinstance(x, dict):
                    out.append({"kind": kind, **x})
    return out


def _ai_evidence(item: dict) -> list[tuple[str, str | None]]:
    raw = item.get("evidence") or item.get("quotes") or []
    if isinstance(raw, (str, dict)):
        raw = [raw]
    out = []
    for ev in raw:
        ev = as_plain(ev)
        if isinstance(ev, str):
            out.append((ev, None))
        elif isinstance(ev, dict):
            q = ev.get("quote") or ev.get("text")
            if q:
                out.append((str(q), ev.get("source_id") or ev.get("source") or ev.get("doc_id")))
    if item.get("quote"):
        out.append((str(item["quote"]), item.get("source_id")))
    return out


def _ai_refine(docs: list[_Doc], reg: _Registry, engine: Any, region_terms: Mapping[str, Any]) -> dict[str, Any]:
    report: dict[str, Any] = {"used": False, "accepted": 0, "dropped": 0}
    prio = {"own_quotation": 0, "company_doc": 1, "sent_email": 2, "inbound_email": 3, "web": 4}
    budget = 60_000
    payload_docs = []
    for d in sorted(docs, key=lambda x: (prio[x.stype], x.order)):
        if budget <= 0:
            break
        text = d.text[:min(d.limit, 4000)]
        budget -= len(text)
        payload_docs.append({"source_id": d.sid, "source_type": d.stype, "label": d.doc.label, "text": text})
    hints = [{"kind": a.kind, "key": a.key, "label": a.label or a.key,
              "synonyms": [s for s, _ in a.surfaces.most_common(5)]}
             for a in reg.items.values() if a.kind in ("service_family", "work_type", "standard")][:60]
    legal = reg.find("identity", "legal_name")
    knowledge = {"company_name": legal.label if legal else None, "deterministic_findings": hints,
                 "note": "Findings mined deterministically from the same corpus; confirm, name or extend them."}
    compact_terms = []
    budget_terms = 5500
    for c in region_terms.get("concepts") or []:
        entry = {"concept": c["key"], "category": c.get("category") or None,
                 "terms": [f"{t['term']} ({t['region']})" for t in c.get("terms") or []][:10]}
        budget_terms -= len(str(entry))
        if budget_terms < 0:
            break
        compact_terms.append(entry)
    try:
        result = call_ai_task("discover_business", engine, {"documents": payload_docs, "hints": hints,
                                                            "region_terms": compact_terms, "knowledge": knowledge})
    except AITaskUnavailable as exc:
        log.info("AI refinement skipped: %s", exc)
        report["error"] = str(exc)
        return report
    except Exception as exc:  # the deterministic result stands on its own
        log.warning("AI refinement failed: %s", exc)
        report["error"] = str(exc)
        return report
    report["used"] = True
    by_id = {d.sid: d for d in docs}
    for item in _ai_items(result):
        kind = _AI_KIND_ALIASES.get(str(item.get("kind") or ""), item.get("kind"))
        label = str(item.get("label") or item.get("name") or "").strip()
        if kind not in KINDS or not label:
            report["dropped"] += 1
            continue
        key = str(item.get("key") or slugify(label))
        verified: list[tuple[_Doc, str]] = []
        for quote, sid in _ai_evidence(item):
            targets = [by_id[sid]] if sid in by_id else docs
            for d in targets:
                found = find_verbatim(quote, d.text[:d.limit])
                if found:
                    verified.append((d, found))
                    break
        if not verified:
            report["dropped"] += 1
            continue
        acc = reg.find(kind, key)
        if acc is None and kind in ("service_family", "work_type", "standard"):
            acc = _match_existing_family(label, {a.key: a for a in reg.of_kind(kind)})
        if acc is None:
            acc = reg.get(kind, key)
            acc.fresh = False
            acc.label = label
        acc.origins.add("ai")
        if item.get("description") and not acc.description:
            acc.description = str(item["description"])[:500]
        for syn in item.get("synonyms") or item.get("aliases") or item.get("variants") or []:
            if isinstance(syn, str) and syn not in acc.extra_synonyms:
                acc.extra_synonyms.append(syn)
        if item.get("region") and not acc.region:
            acc.region = str(item["region"])
        if item.get("language") and not acc.language:
            acc.language = str(item["language"])
        if kind in ("identity", "convention") and item.get("value") is not None and acc.value is None:
            acc.value = item["value"]
        for d, quote in verified:
            pos = d.text.find(quote)
            acc.hit(d, pos, pos + len(quote), quote=quote)
        report["accepted"] += 1
    return report


# --------------------------------------------------------------------------------------------
# Finalisation: evidence -> score, confidence, claim basis
# --------------------------------------------------------------------------------------------


def claim_basis_for(source_types: Iterable[str]) -> str:
    """``delivered_work`` (own quotations / sent mail) > ``catalogue_claim`` (company documents,
    online pages about the company) > ``market_vocabulary`` (only customers say it)."""
    types = set(source_types)
    if types & DELIVERED_SOURCE_TYPES:
        return "delivered_work"
    if types & {"company_doc", "web"}:
        return "catalogue_claim"
    return "market_vocabulary"


def confidence_for(weighted_support: float, source_types: Iterable[str], kind: str = "service_family") -> float:
    """Evidence -> confidence: ``1 - exp(-W/1.6)`` where W sums source weights (own quotation 1.0
    ... web 0.2). Web-only stays <= 0.3; customer-only services stay <= 0.45 (demand, not capability)."""
    if weighted_support <= 0:
        return 0.0
    types = set(source_types)
    c = 1.0 - math.exp(-weighted_support / 1.6)
    real = types - {"web"}
    if len(real) >= 2:
        c += 0.05
    if not real:
        c = min(c, WEB_ONLY_CAP)
    elif kind in ("service_family", "work_type", "standard") and real <= CUSTOMER_SOURCE_TYPES:
        c = min(c, DEMAND_ONLY_CAP)
    return round(max(0.0, min(c, 0.97)), 3)


def _select_evidence(cands: Iterable[_Cand], max_n: int) -> list[Evidence]:
    ordered = sorted(cands, key=lambda c: (-c.weight, not c.affirmed, c.order))
    chosen: list[_Cand] = []
    used: set[str] = set()
    for c in ordered:
        if c.stype not in used:
            chosen.append(c)
            used.add(c.stype)
        if len(chosen) >= max_n:
            break
    for c in ordered:
        if len(chosen) >= max_n:
            break
        if c not in chosen:
            chosen.append(c)
    chosen.sort(key=lambda c: (-c.weight, not c.affirmed, c.order))
    out = []
    for c in chosen:
        extra = {} if c.affirmed else {"note": "mentioned as excluded / not in scope"}
        out.append(Evidence(quote=c.quote, source_type=c.stype, source_id=c.sid, source_label=c.label,
                            weight=c.weight, date=c.date, **extra))
    return out


def _plain(value: Any) -> Any:
    if isinstance(value, Counter):
        return dict(value.most_common())
    if isinstance(value, set):
        return sorted(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _dedupe(names: Iterable[str], exclude: Iterable[str] = ()) -> list[str]:
    seen = {normalize_text(x) for x in exclude if x}
    out = []
    for n in names:
        if not n:
            continue
        k = normalize_text(n)
        if k and k not in seen:
            seen.add(k)
            out.append(n)
    return out


def _finalize(acc: _Acc, ctx: _Ctx, max_evidence: int) -> KnowledgeItemDraft | None:
    if acc.preset is not None:
        weighted, types = acc.preset
    else:
        weighted = 0.0
        types = set()
        for h in acc.docs.values():
            w = SOURCE_WEIGHTS.get(h.stype, 0.2)
            weighted += w * (1.0 if h.affirmed else 0.3) * (1 + 0.25 * math.log(max(1, h.mentions)))
            if h.affirmed:
                types.add(h.stype)
    evidence = _select_evidence(acc.cands.values(), max_evidence)
    if not evidence:
        return None
    basis = claim_basis_for(types)
    conf = confidence_for(weighted, types, acc.kind)
    label = acc.label or (acc.surfaces.most_common(1)[0][0] if acc.surfaces else acc.key)
    synonyms = _dedupe([s for s, _ in acc.surfaces.most_common(12)] + acc.extra_synonyms, exclude=[label])[:12]
    doc_counts = Counter(h.stype for h in acc.docs.values())
    meta = dict(acc.meta)
    meta.update({"doc_counts": dict(doc_counts), "mentions": sum(h.mentions for h in acc.docs.values()),
                 "origins": sorted(acc.origins), "weighted_support": round(weighted, 3)})
    excluded_docs = sum(1 for h in acc.docs.values() if not h.affirmed)
    if excluded_docs:
        meta["excluded_mentions_docs"] = excluded_docs
    if acc.kind in ("service_family", "work_type"):
        meta["terms_company"] = [s for s, _ in acc.side_terms["company"].most_common(8)]
        meta["terms_customers"] = [s for s, _ in acc.side_terms["customers"].most_common(8)]
    region = acc.region
    if acc.kind == "term":
        regions = sorted(acc.regions) or [region or "global"]
        meta["regions"] = regions
        company_w = sum(SOURCE_WEIGHTS[h.stype] for h in acc.docs.values() if _SIDE.get(h.stype) == "company")
        customer_w = sum(SOURCE_WEIGHTS[h.stype] for h in acc.docs.values() if _SIDE.get(h.stype) == "customers")
        meta["company_weight"] = round(company_w, 3)
        meta["customer_weight"] = round(customer_w, 3)
        meta["used_by"] = ("both" if company_w and customer_w else "company" if company_w
                           else "customers" if customer_w else "web")
        region = region or next((r for r in regions if not is_neutral_region(r)), regions[0])
        if not acc.description and meta.get("canonical"):
            rl = ctx.region_labels.get(region, region) if not is_neutral_region(region) else "international"
            who = {"company": "used by you", "customers": "used by your customers", "both": "used by you and your "
                   "customers", "web": "seen online"}[meta["used_by"]]
            acc.description = f"{meta['canonical']} - {rl} wording, {who}."
    return KnowledgeItemDraft(
        kind=acc.kind, key=acc.key, label=str(label)[:200], label_ar=acc.label_ar, description=acc.description,
        synonyms=synonyms, region=region, language=acc.language, claim_basis=basis, evidence=evidence,
        score=round(weighted, 3), confidence=conf, status="suggested", value=_plain(acc.value), meta=_plain(meta))


# --------------------------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------------------------


def mine_corpus(docs: Sequence[CorpusDoc] | Iterable[Any], engine: Any = None, region_terms: Any = None, *,
                categories: Any = None, standards: Any = None, max_terms: int = 40, max_evidence: int = 6,
                max_docs_per_type: int | None = 5000) -> list[KnowledgeItemDraft]:
    """Mine a corpus into suggested knowledge items (all ``status="suggested"``).

    ``region_terms``/``categories``/``standards`` default to the shipped data files (an in-memory
    document or a path may be passed instead). ``engine`` enables the optional AI refinement.
    Items are ordered identity, service families, work types, standards, conventions, terms -
    each group by descending score.
    """
    rt = coerce_region_terms(region_terms)
    cats = coerce_categories(categories)
    stds = coerce_standards(standards)
    prepared, dropped = _prepare(docs, max_docs_per_type)
    if not prepared:
        return []
    index = build_term_index(rt, cats)
    ctx = _Ctx(rt, cats, index)
    reg = _Registry()
    _mine_concepts(prepared, ctx, reg)
    _mine_offerings(prepared, ctx, reg)
    _mark_boilerplate([d for d in prepared if d.side == "company"])
    _mine_ngrams(prepared, ctx, reg, max_terms=max_terms)
    _mine_standards(prepared, stds, reg)
    _mine_references(prepared, reg)
    _mine_currency(prepared, reg)
    _mine_date_format(prepared, reg)
    _mine_language_mix(prepared, reg)
    _mine_commercial_terms(prepared, reg)
    _mine_identity(prepared, reg)
    ai_report = _ai_refine(prepared, reg, engine, rt) if engine is not None else None
    items: list[KnowledgeItemDraft] = []
    for acc in reg.items.values():
        item = _finalize(acc, ctx, max_evidence)
        if item is None:
            continue
        if ai_report is not None and "ai" in acc.origins:
            item.meta["ai"] = True
        if dropped:
            item.meta["sampled_out"] = dropped
        items.append(item)
    items.sort(key=lambda i: (_KIND_ORDER.get(i.kind, 9), -i.score, -i.confidence, i.key))
    return items


def _get(item: Any, name: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(name, default)
    return getattr(item, name, default)


def _as_row(item: Any) -> dict[str, Any]:
    if hasattr(item, "model_dump") and not hasattr(item, "__table__"):
        try:
            return item.model_dump()
        except Exception:
            pass
    if isinstance(item, dict):
        return dict(item)
    keys = ("kind", "key", "label", "label_ar", "description", "synonyms", "region", "language", "claim_basis",
            "evidence", "score", "confidence", "status", "value", "meta")
    return {k: _get(item, k) for k in keys}


def _ev_count(row: dict) -> int:
    return sum(1 for e in row.get("evidence") or [] if isinstance(e, dict) and e.get("source_type") != "owner")


def _pack(row: dict) -> dict[str, Any]:
    meta = row.get("meta") or {}
    return {"key": row.get("key"), "label": row.get("label"), "label_ar": row.get("label_ar") or "",
            "description": row.get("description") or "", "synonyms": list(row.get("synonyms") or []),
            "claim_basis": row.get("claim_basis"), "confidence": float(row.get("confidence") or 0.0),
            "score": float(row.get("score") or 0.0), "status": row.get("status") or "suggested",
            "evidence_count": _ev_count(row), "terms_company": meta.get("terms_company") or [],
            "terms_customers": meta.get("terms_customers") or [],
            "work_types": meta.get("work_types") or {}, "origins": meta.get("origins") or []}


def _row_side_weights(row: dict) -> tuple[float, float]:
    meta = row.get("meta") or {}
    if "company_weight" in meta or "customer_weight" in meta:
        return float(meta.get("company_weight") or 0.0), float(meta.get("customer_weight") or 0.0)
    company = customer = 0.0
    for ev in row.get("evidence") or []:
        if not isinstance(ev, dict):
            continue
        side = _SIDE.get(ev.get("source_type") or "")
        w = float(ev.get("weight") or SOURCE_WEIGHTS.get(ev.get("source_type") or "", 0.0))
        if side == "company":
            company += w
        elif side == "customers":
            customer += w
    return company, customer


def _regions_vocab(term_rows: list[dict], labels: Mapping[str, str]) -> dict[str, Any]:
    company: Counter = Counter()
    customers: Counter = Counter()
    by_concept: dict[str, dict[str, Any]] = {}
    for row in term_rows:
        meta = row.get("meta") or {}
        regions = [r for r in (meta.get("regions") or [row.get("region")]) if r and not is_neutral_region(r)]
        cw, uw = _row_side_weights(row)
        group = meta.get("group") or meta.get("category") or (str(row.get("key") or "").split(":", 1)[0])
        if meta.get("origin") == "ngram":
            continue
        entry = by_concept.setdefault(group, {"canonical": meta.get("canonical") or group, "company_terms": [],
                                              "customer_terms": []})
        if cw:
            entry["company_terms"].append({"term": row.get("label"), "regions": regions})
        if uw:
            entry["customer_terms"].append({"term": row.get("label"), "regions": regions})
        if not regions:
            continue
        for r in regions:
            company[r] += cw / len(regions)
            customers[r] += uw / len(regions)

    def shares(c: Counter) -> dict[str, float]:
        total = sum(c.values())
        return {k: round(v / total, 3) for k, v in c.most_common() if v > 0} if total else {}

    comp, cust = shares(company), shares(customers)
    return {"company": comp, "customers": cust,
            "company_primary": next(iter(comp), None), "customers_primary": next(iter(cust), None),
            "labels": {k: labels.get(k, k) for k in set(comp) | set(cust)},
            "by_concept": {k: v for k, v in by_concept.items() if v["company_terms"] or v["customer_terms"]}}


def build_identity(items: Iterable[Any], *, region_terms: Any = None) -> dict[str, Any]:
    """Summarise knowledge items (drafts, dicts or stored ``KnowledgeItem`` rows) into the
    business identity: company details, service families, work types, regional vocabulary,
    languages, standards, conventions, an overall confidence and the gaps still open."""
    rows = [_as_row(i) for i in items or []]
    rows = [r for r in rows if r.get("status") != "rejected" and r.get("kind")]
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_kind[r["kind"]].append(r)
    for lst in by_kind.values():
        lst.sort(key=lambda r: (-(r.get("confidence") or 0.0), -(r.get("score") or 0.0)))

    def confirmed(r: dict) -> bool:
        return r.get("status") in CONFIRMED_STATUSES

    ident = {r.get("key"): r for r in by_kind.get("identity", [])}

    def ident_value(key: str) -> Any:
        r = ident.get(key)
        if r is None:
            return None
        return r.get("value") if r.get("value") not in (None, "", [], {}) else r.get("label")

    legal = ident_value("legal_name")
    email_dom = ident_value("email_domains")
    domains = email_dom.get("domains") if isinstance(email_dom, dict) else (
        [d.strip() for d in str(email_dom).split(",")] if email_dom else [])
    short = re.sub(r"(?i)[\s,]*(?:\b(?:ltd|limited|llc|l\.l\.c|w\.l\.l|wll|co|company|inc|gmbh|plc|k\.s\.c|"
                   r"general\s+trading(?:\s*(?:&|and)\s*contracting)?|trading|contracting)\b\.?[\s,]*)+$", "",
                   legal or "").strip(" ,.-") if legal else None
    phones = ident_value("phones")
    company = {"name": short or legal, "legal_name": legal, "address": ident_value("address"),
               "phones": phones if isinstance(phones, list) else ([{"kind": "phone", "number": p.strip()}
                                                                    for p in str(phones).split(",")] if phones else []),
               "website": ident_value("website"), "domains": domains or [],
               "emails": (email_dom.get("addresses") if isinstance(email_dom, dict) else []) or []}

    families = [_pack(r) for r in by_kind.get("service_family", [])
                if r.get("claim_basis") != "market_vocabulary" or confirmed(r)]
    demand = [r for r in by_kind.get("service_family", [])
              if r.get("claim_basis") == "market_vocabulary" and not confirmed(r)]
    work_types = [_pack(r) for r in by_kind.get("work_type", [])
                  if r.get("claim_basis") != "market_vocabulary" or confirmed(r)]
    rt = coerce_region_terms(region_terms)
    regions_vocab = _regions_vocab(by_kind.get("term", []), region_labels(rt))
    conventions: dict[str, Any] = {}
    for r in by_kind.get("convention", []):
        conventions[r.get("key")] = r.get("value") if r.get("value") is not None else r.get("label")
    lang_mix = conventions.get("language_mix")
    shares = lang_mix.get("shares") if isinstance(lang_mix, dict) else {}
    languages = [k for k, v in sorted((shares or {}).items(), key=lambda kv: -kv[1]) if v >= 0.05]
    standards = []
    for r in by_kind.get("standard", []):
        meta = r.get("meta") or {}
        standards.append({"code": meta.get("code") or r.get("value") or r.get("label"), "label": r.get("label"),
                          "title": meta.get("title") or r.get("description") or "", "region": r.get("region"),
                          "applies_to": meta.get("applies_to") or [], "confidence": float(r.get("confidence") or 0),
                          "claim_basis": r.get("claim_basis"), "evidence_count": _ev_count(r)})

    delivered = [f for f in families if f["claim_basis"] == "delivered_work" or f["status"] in CONFIRMED_STATUSES]
    top = sorted((f["confidence"] if f["status"] not in CONFIRMED_STATUSES else 1.0) for f in families)[::-1][:3]
    base_conf = sum(top) / len(top) if top else 0.0
    coverage = 1.0 if delivered else 0.5
    completeness = sum(1 for x in (legal, conventions.get("reference_format"), conventions.get("currency"),
                                   lang_mix) if x) / 4
    confidence = round(min(0.99, base_conf * coverage * 0.85 + 0.15 * completeness), 3)

    gaps: list[dict[str, str]] = []
    if not families:
        gaps.append({"key": "no_service_families", "message": "No service families found yet - add old quotations, "
                     "company profiles or more sent mail so the system can learn what you sell."})
    elif not delivered:
        gaps.append({"key": "no_delivered_work", "message": "Nothing is backed by your own quotations or sent mail "
                     "yet - add a folder of old quotations to confirm what you deliver."})
    for f in families:
        if f["claim_basis"] != "delivered_work" and f["status"] not in CONFIRMED_STATUSES:
            where = "online" if f["confidence"] <= WEB_ONLY_CAP else "in company documents"
            gaps.append({"key": f"unconfirmed:{f['key']}", "message": f"'{f['label']}' is only claimed {where} - "
                         "confirm whether you deliver it."})
    for r in demand[:8]:
        n = (r.get("meta") or {}).get("doc_counts", {}).get("inbound_email") or _ev_count(r)
        gaps.append({"key": f"customer_demand:{r.get('key')}", "message": f"Customers ask about '{r.get('label')}' "
                     f"({n} e-mails) but none of your own quotations mention it - a service you do not offer, or "
                     "one you have not quoted yet?"})
    if not legal:
        gaps.append({"key": "legal_name", "message": "Company legal name not found in own letterheads or signatures."})
    if not conventions.get("reference_format"):
        gaps.append({"key": "reference_format", "message": "No quotation reference format found - add old "
                     "quotations or set the numbering pattern by hand."})
    if not conventions.get("currency"):
        gaps.append({"key": "currency", "message": "Quotation currency not found in own documents."})
    if not standards:
        gaps.append({"key": "standards", "message": "No technical standards are cited in your own documents."})
    return {"company": company, "service_families": families, "work_types": work_types,
            "regions_vocab": regions_vocab, "languages": languages, "standards": standards,
            "conventions": conventions, "confidence": confidence, "gaps": gaps}


def _keywords_by_language(words: Iterable[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"en": [], "ar": []}
    seen: set[str] = set()
    for w in words:
        if not w or not isinstance(w, str):
            continue
        k = normalize_text(w)
        if not k or k in seen or len(k) < 2:
            continue
        seen.add(k)
        c = script_counts(w)
        lang = "ar" if c["arabic"] else "ru" if c["cyrillic"] else "en"
        out.setdefault(lang, []).append(w.strip())
    return out


def categories_from_identity(identity: Mapping[str, Any], defaults: Any = None, *, min_confidence: float = 0.35,
                             include_unlearned: bool = False) -> list[dict[str, Any]]:
    """Mail categories for this company: one work category per learned service family (merged
    with a default category of the same key: icon, Arabic label, negative keywords), the generic
    catch-all work category, then the non-work defaults (bills, promotions, internal, ...).

    Families claimed only online (confidence <= 0.3) or only by customers are left out unless the
    owner confirmed them. With no learned family at all the default work categories are kept.
    """
    cats = coerce_categories(defaults)
    by_key = {c["key"]: c for c in cats}
    out: list[dict[str, Any]] = []
    learned: set[str] = set()
    for fam in identity.get("service_families") or []:
        status = fam.get("status") or "suggested"
        conf = float(fam.get("confidence") or 0.0)
        if status == "rejected":
            continue
        if status not in CONFIRMED_STATUSES and (conf < min_confidence or fam.get("claim_basis") == "market_vocabulary"):
            continue
        key = fam["key"]
        base_cat = by_key.get(key) or {}
        words = [fam.get("label"), *(fam.get("synonyms") or []), *(fam.get("terms_company") or []),
                 *(fam.get("terms_customers") or [])]
        kw = _keywords_by_language([*(base_cat.get("keywords") or {}).get("en", []),
                                    *(base_cat.get("keywords") or {}).get("ar", []), *words])
        for lang, lst in (base_cat.get("keywords") or {}).items():
            if lang not in ("en", "ar"):
                kw.setdefault(lang, [])
                kw[lang] = list(dict.fromkeys([*kw[lang], *lst]))
        out.append({
            "key": key, "label": base_cat.get("label") or fam.get("label") or key,
            "label_ar": base_cat.get("label_ar") or fam.get("label_ar") or "", "group": "work",
            "icon": base_cat.get("icon") or "briefcase", "visible": True, "is_work_type": True,
            "keywords": {k: v[:40] for k, v in kw.items()},
            "negative_keywords": base_cat.get("negative_keywords") or {"en": [], "ar": []},
            "description": base_cat.get("description") or fam.get("description") or "",
            "source": "learned", "confidence": conf, "claim_basis": fam.get("claim_basis"),
        })
        learned.add(key)
    if not learned:
        for c in cats:
            if c.get("is_work_type") and not is_catch_all_category(c["key"]):
                out.append({**c, "source": "default"})
                learned.add(c["key"])
    for c in cats:
        if c.get("is_work_type") and is_catch_all_category(c["key"]) and c["key"] not in learned:
            out.append({**c, "source": "default"})
    if include_unlearned:
        for c in cats:
            if c.get("is_work_type") and c["key"] not in learned and not is_catch_all_category(c["key"]):
                out.append({**c, "visible": False, "source": "default"})
    for c in cats:
        if not c.get("is_work_type"):
            out.append({**c, "source": "default"})
    for order, c in enumerate(out):
        c["order"] = order
    return out


def learn_business(docs: Sequence[CorpusDoc], engine: Any = None, region_terms: Any = None, *,
                   defaults: Any = None) -> dict[str, Any]:
    """Convenience: mine -> identity -> categories, in one call."""
    items = mine_corpus(docs, engine=engine, region_terms=region_terms, categories=defaults)
    identity = build_identity(items, region_terms=region_terms)
    return {"items": items, "identity": identity, "categories": categories_from_identity(identity, defaults)}
