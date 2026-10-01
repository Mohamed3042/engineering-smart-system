"""Deterministic mail classifier that works with no AI at all.

``RuleClassifier().classify(email)`` scores keyword sets per category (English and Arabic, with
Arabic spelling variants and attached prefixes tolerated), weights the subject above the body,
discounts quoted history, applies sender rules (own domains → internal, no-reply → notifications,
marketplaces → promotions) and treats a ``List-Unsubscribe`` header as promotions unless the mail
carries strong work + request signals. Evidence quotes are cut verbatim out of the email.

Keywords from ``ess/knowledge/data/default_categories.json`` (written by the knowledge module) and
from the ``categories`` argument are merged into the built-in sets.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .guards import normalize_text, normalize_with_map

DEFAULT_CATEGORIES: list[dict[str, str]] = [
    {"key": "bmu", "label": "Building Maintenance Units", "group": "work"},
    {"key": "wce", "label": "Window Cleaning Equipment (monorails, davits, façade cleaning systems, cradles for cleaning)",
     "group": "work"},
    {"key": "cradle", "label": "Suspended platforms / temporary cradles", "group": "work"},
    {"key": "hoist", "label": "Construction hoists & personnel lifts", "group": "work"},
    {"key": "crane", "label": "Cranes & lifting", "group": "work"},
    {"key": "access_rental", "label": "Man-lifts, scissor lifts, boom rental", "group": "work"},
    {"key": "scaffolding", "label": "Scaffolding", "group": "work"},
    {"key": "space_frame", "label": "Space frames & shades", "group": "work"},
    {"key": "other_work", "label": "Other work requests", "group": "work"},
    {"key": "vendor_offer", "label": "Supplier & OEM offers", "group": "other"},
    {"key": "bills", "label": "Bills, invoices, payments", "group": "bills"},
    {"key": "promotions", "label": "Newsletters, ads, marketplaces", "group": "promotions"},
    {"key": "internal", "label": "Internal / colleagues", "group": "other"},
    {"key": "notifications", "label": "System notifications", "group": "other"},
    {"key": "other", "label": "Everything else", "group": "other"},
]
CATEGORIES_JSON = Path(__file__).resolve().parents[1] / "knowledge" / "data" / "default_categories.json"

# (phrase, weight). Phrases are normalised like the text (casefold, Arabic variants, hyphens → spaces).
# A phrase starting with "re:" is a raw regular expression applied to the normalised text.
_KEYWORDS: dict[str, dict[str, list[tuple[str, float]]]] = {
    "bmu": {
        "en": [("building maintenance unit", 5), ("bmu", 5), ("b.m.u", 5), ("gondola", 3), ("roof car", 4),
               ("roof trolley", 3), ("telescopic jib", 4), ("slewing jib", 3), ("maintenance unit", 1.5)],
        "ar": [("وحدة صيانة المبنى", 5), ("وحدة صيانة المباني", 5), ("وحدات صيانة المباني", 5), ("جندولا", 3),
               ("جندول", 3)],
    },
    "wce": {
        "en": [("window cleaning", 4), ("window washing", 4), ("facade cleaning", 4), ("glass cleaning", 3),
               ("facade access", 2.5), ("monorail", 4), ("mono rail", 4), ("davit", 4), ("cleaning cradle", 5),
               ("cleaning gondola", 4), ("anchor point", 1.5), ("lifeline", 1.5), ("wcs", 2)],
        "ar": [("تنظيف الواجهات", 5), ("تنظيف الواجهة", 5), ("تنظيف النوافذ", 5), ("تنظيف الزجاج", 4),
               ("مونوريل", 4), ("مونو ريل", 4), ("دافيت", 4), ("عربة تنظيف", 4)],
    },
    "cradle": {
        "en": [("suspended platform", 5), ("suspended cradle", 5), ("temporary gondola", 5), ("temporary cradle", 5),
               ("cradle", 3), ("swing stage", 4), ("hanging platform", 4), ("gondola rental", 4)],
        "ar": [("سقالة معلقة", 5), ("منصة معلقة", 5), ("كريدل", 4), ("سلة معلقة", 4), ("جندولا مؤقتة", 5)],
    },
    "hoist": {
        "en": [("construction hoist", 5), ("passenger hoist", 5), ("material hoist", 5), ("rack and pinion", 4),
               ("builder hoist", 4), ("goods hoist", 4), ("personnel lift", 3), ("hoist", 2.5)],
        "ar": [("مصعد بناء", 5), ("مصعد إنشائي", 5), ("رافعة ركاب", 4), ("رافعة مواد", 4)],
    },
    "crane": {
        "en": [("tower crane", 5), ("mobile crane", 5), ("crawler crane", 5), ("overhead crane", 4),
               ("gantry crane", 4), ("crane", 3), ("rigging", 1.5), ("lifting", 1)],
        "ar": [("رافعة برجية", 5), ("رافعة متحركة", 5), ("كرين", 4), ("رافعة", 1.5)],
    },
    "access_rental": {
        "en": [("man lift", 5), ("manlift", 5), ("scissor lift", 5), ("boom lift", 5), ("cherry picker", 4),
               ("aerial work platform", 5), ("mewp", 4), ("awp", 3), ("telehandler", 4), ("spider lift", 4)],
        "ar": [("رافعة مقصية", 5), ("سلة رافعة", 4), ("منصة عمل هوائية", 5)],
    },
    "scaffolding": {
        "en": [("scaffolding", 5), ("scaffold", 4), ("cuplock", 4), ("ringlock", 4), ("kwikstage", 4),
               ("tube and clamp", 4), ("tube and coupler", 4)],
        "ar": [("سقالات", 5), ("سقالة", 4)],
    },
    "space_frame": {
        "en": [("space frame", 5), ("spaceframe", 5), ("shade structure", 4), ("tensile structure", 4),
               ("car park shade", 4), ("skylight", 2), ("pergola", 2), ("canopy", 1.5)],
        "ar": [("إطار فراغي", 5), ("هيكل فراغي", 5), ("جملون فراغي", 5), ("مظلات", 3), ("مظلة", 2.5)],
    },
    "vendor_offer": {
        "en": [("we are a manufacturer", 5), ("we are a leading manufacturer", 5), ("leading manufacturer", 4),
               ("we manufacture", 4), ("manufacturer of", 3), ("oem", 4), ("catalogue", 3), ("catalog", 3),
               ("special offer", 4), ("exclusive offer", 4), ("distributor", 3), ("distributorship", 4),
               ("exclusive agent", 4), ("dealer", 2), ("our product range", 4), ("our products", 2.5),
               ("price list", 3), ("product brochure", 3), ("we would like to introduce", 4),
               ("introduce our company", 4), ("factory direct", 4), ("partnership", 2)],
        "ar": [("نحن شركة مصنعة", 5), ("كتالوج", 3), ("كاتالوج", 3), ("عرض خاص", 4), ("موزع", 3),
               ("وكيل حصري", 4), ("قائمة الأسعار", 3), ("نود أن نعرفكم", 4)],
    },
    "bills": {
        "en": [("tax invoice", 5), ("invoice", 4), ("statement of account", 5), ("payment reminder", 5),
               ("overdue", 3), ("remittance", 4), ("payment receipt", 4), ("receipt no", 4), ("receipt", 1), ("outstanding balance", 4), ("amount due", 4),
               ("credit note", 4), ("debit note", 4), ("payment advice", 4), ("payment", 1.5)],
        "ar": [("فاتورة", 5), ("فواتير", 5), ("كشف حساب", 5), ("إيصال", 3), ("سداد", 3), ("دفعة", 2),
               ("مستحقات", 3), ("إشعار دائن", 4)],
    },
    "promotions": {
        "en": [("newsletter", 5), ("unsubscribe", 4), ("webinar", 4), ("re:\\d+ ?% off", 4), ("re:(?<![a-z0-9])(?:on )?sale(?![a-z0-9@.])", 2),
               ("limited time", 3), ("promo code", 4), ("promotion", 2), ("shop now", 4), ("register now", 3),
               ("free trial", 3), ("early bird", 3), ("new arrivals", 3), ("view in browser", 4),
               ("view this email in your browser", 5), ("marketplace", 2), ("deal", 1)],
        "ar": [("نشرة", 4), ("النشرة الإخبارية", 5), ("خصم", 3), ("عرض لفترة محدودة", 4), ("إلغاء الاشتراك", 5),
               ("سجل الآن", 3)],
    },
    "notifications": {
        "en": [("security alert", 5), ("new sign in", 5), ("sign in attempt", 5), ("verification code", 5),
               ("verify your", 3), ("password", 2.5), ("your account", 1.5), ("delivery status notification", 5),
               ("undeliverable", 5), ("mail delivery failed", 5), ("out of office", 4), ("automatic reply", 4),
               ("auto reply", 4), ("do not reply to this email", 4), ("this is an automated message", 4)],
        "ar": [("تنبيه أمني", 5), ("رمز التحقق", 5), ("كلمة المرور", 3), ("رد تلقائي", 4)],
    },
}
_SIGNALS: dict[str, dict[str, list[tuple[str, float]]]] = {
    "request": {
        "en": [("request for quotation", 4), ("request for quote", 4), ("rfq", 4), ("rfp", 3),
               ("request for proposal", 4), ("quotation request", 4), ("please quote", 4), ("kindly quote", 4),
               ("kindly submit your", 3), ("submit your quotation", 4), ("submit your best", 4),
               ("send your quotation", 4), ("send us your quotation", 4), ("send your offer", 3),
               ("your best offer", 3), ("your best price", 3), ("quotation for", 3), ("quote for", 2),
               ("enquiry", 3), ("inquiry", 3), ("tender", 3), ("bid", 2), ("bidding", 2), ("we require", 2.5),
               ("we need", 2), ("requirement for", 2), ("rental offer", 3), ("budgetary", 2), ("cost estimate", 2),
               ("invite you to quote", 4), ("invitation to tender", 4), ("kindly send", 2), ("kindly provide", 2),
               ("please send", 1.5), ("please advise", 1.5)],
        "ar": [("طلب عرض سعر", 5), ("عرض سعر", 4), ("عرض أسعار", 4), ("تسعير", 3), ("مناقصة", 3),
               ("نرجو تزويدنا", 4), ("يرجى تزويدنا", 4), ("الرجاء تزويدنا", 4), ("نحتاج", 2), ("مطلوب", 2),
               ("استفسار", 2.5)],
    },
    "tender": {"en": [("tender", 1), ("bidders", 1), ("bid", 1), ("bidding", 1), ("closing date", 1),
                      ("invitation to tender", 1)],
               "ar": [("مناقصة", 1), ("ممارسة", 1)]},
    "om": {"en": [("annual maintenance", 1), ("maintenance contract", 1), ("amc", 1), ("service contract", 1),
                  ("operation and maintenance", 1), ("preventive maintenance", 1)],
           "ar": [("عقد صيانة", 1), ("صيانة سنوية", 1)]},
    "revision": {"en": [("addendum", 1), ("amendment", 1), ("revised", 1), ("corrigendum", 1),
                        ("has been extended", 1), ("extension of", 1)],
                 "ar": [("ملحق", 1), ("تعديل", 1), ("تمديد", 1)]},
    "info": {"en": [("more information", 1), ("more details", 1), ("brochure", 1), ("technical details", 1)],
             "ar": [("معلومات", 1)]},
    "urgent": {"en": [("urgent", 1), ("asap", 1), ("as soon as possible", 1), ("immediately", 1)],
               "ar": [("عاجل", 1)]},
}
_NOREPLY_RE = re.compile(r"(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|alerts?|mailer-daemon|"
                         r"postmaster|bounces?)([._+-]|@)", re.IGNORECASE)
_MARKETPLACE_DOMAINS = ("alibaba.com", "made-in-china.com", "indiamart.com", "tradeindia.com", "globalsources.com",
                        "ec21.com", "aliexpress.com", "amazon.", "noon.com", "linkedin.com", "facebookmail.com",
                        "mailchimp", "sendgrid", "hubspot")
_SEP_TABLE = str.maketrans({"-": " ", "_": " ", "/": " ", "\\": " ", "|": " ", "–": " ", "—": " "})
_FIELD_WEIGHT = {"subject": 2.5, "attachments": 1.5, "body": 1.0, "quoted": 0.3, "from": 0.5}
MIN_CATEGORY_SCORE = 3.0  # below this nothing is decided: "other" (or "other_work" for a plain request)
_QUOTED_START = re.compile(r"^(>|-{2,}\s*original message|from:\s.+|on .+ wrote:|sent from my|من:\s|تم الإرسال)",
                           re.IGNORECASE)


@dataclass
class _Pattern:
    target: str  # category key or signal name
    phrase: str
    regex: re.Pattern[str]
    weight: float
    signal: bool = False


def _compile(phrase: str) -> re.Pattern[str]:
    if phrase.startswith("re:"):
        return re.compile(phrase[3:])
    norm = normalize_text(phrase.translate(_SEP_TABLE))
    if re.search(r"[؀-ۿ]", norm):  # Arabic: attached prefixes (و ب ل ف ك ال) and short suffixes allowed
        return re.compile(re.escape(norm) + r"[؀-ۿ]{0,3}(?![؀-ۿ])")
    return re.compile(r"(?<![a-z0-9])" + re.escape(norm) + r"(?:s|es)?(?![a-z0-9])")


def _split_quoted(body: str) -> tuple[str, str]:
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if i > 0 and _QUOTED_START.match(line.strip()):
            return "\n".join(lines[:i]), "\n".join(lines[i:])
    return body, ""


def _quote_window(text: str, start: int, end: int, radius: int = 40) -> str:
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    line_end = len(text) if line_end < 0 else line_end
    s, e = max(line_start, start - radius), min(line_end, end + radius)
    if s > line_start:
        while s < start and not text[s - 1].isspace():
            s += 1
    if e < line_end:
        while e > end and not text[e].isspace():
            e -= 1
    return text[s:e].strip() or text[start:end]


def _domain(addr: str | None) -> str:
    addr = (addr or "").strip().lower()
    if "<" in addr and ">" in addr:
        addr = addr[addr.find("<") + 1:addr.find(">")]
    return addr.rsplit("@", 1)[-1] if "@" in addr else ""


def load_category_file(path: Path = CATEGORIES_JSON) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    cats = data.get("categories") if isinstance(data, dict) else None
    return [c for c in cats or [] if isinstance(c, dict) and c.get("key")]


class RuleClassifier:
    """Keyword/header classifier. ``classify(email)`` returns
    ``{category, confidence, reason, evidence[{quote, source}], priority, is_customer_request,
    request_kind, scores, engine}``."""

    def __init__(self, categories: list[dict] | None = None, *, own_domains: list[str] | tuple[str, ...] = (),
                 categories_file: Path | None = CATEGORIES_JSON) -> None:
        merged: dict[str, dict[str, Any]] = {c["key"]: dict(c) for c in DEFAULT_CATEGORIES}
        keywords: dict[str, list[tuple[str, float]]] = {k: [] for k in merged}
        negatives: dict[str, list[tuple[str, float]]] = {k: [] for k in merged}
        for key, langs in _KEYWORDS.items():
            for lang_list in langs.values():
                keywords[key].extend(lang_list)
        signal_phrases = {normalize_text(p.translate(_SEP_TABLE)) for langs in _SIGNALS.values()
                          for lang_list in langs.values() for p, _ in lang_list}
        extra_sources = (load_category_file(categories_file) if categories_file else []) + list(categories or [])
        for cat in extra_sources:
            key = str(cat["key"])
            merged.setdefault(key, {"key": key, "label": cat.get("label") or key, "group": cat.get("group") or "other"})
            for field_name in ("label", "group"):
                if cat.get(field_name):
                    merged[key][field_name] = cat[field_name]
            keywords.setdefault(key, [])
            negatives.setdefault(key, [])
            known = {normalize_text(p.translate(_SEP_TABLE)) for p, _ in keywords[key]}
            for lang_list in (cat.get("keywords") or {}).values():
                for phrase in lang_list or []:
                    if not isinstance(phrase, str) or not phrase.strip():
                        continue
                    norm = normalize_text(phrase.translate(_SEP_TABLE))
                    if norm in known:
                        continue
                    if key == "other_work":
                        # residual bucket: generic request wording (RFQ, tender…) is a *signal*, not a
                        # category - it must not outscore the specific product categories
                        if norm in signal_phrases:
                            continue
                        weight = 1.0
                    else:
                        weight = 3.0 if " " in norm else 2.0
                    known.add(norm)
                    keywords[key].append((phrase, weight))
            for lang_list in (cat.get("negative_keywords") or {}).values():
                for phrase in lang_list or []:
                    if isinstance(phrase, str) and phrase.strip():
                        negatives[key].append((phrase, 3.0))
        allowed = [str(c["key"]) for c in categories] if categories else list(merged)
        self.categories = {k: merged[k] for k in allowed if k in merged}
        self.work_keys = {k for k, c in self.categories.items() if c.get("group") == "work"}
        self.own_domains = tuple(d.lower().lstrip("@") for d in own_domains if d)
        self._patterns = [_Pattern(k, p, _compile(p), w) for k in self.categories for p, w in keywords.get(k, [])]
        self._negatives = [_Pattern(k, p, _compile(p), w) for k in self.categories for p, w in negatives.get(k, [])]
        self._signals = [_Pattern(name, p, _compile(p), w, signal=True)
                         for name, langs in _SIGNALS.items() for lang_list in langs.values() for p, w in lang_list]

    # ------------------------------------------------------------------ matching
    @staticmethod
    def _prep(text: str) -> tuple[str, list[int]]:
        return normalize_with_map((text or "").translate(_SEP_TABLE))

    def _scan(self, text: str, patterns: list[_Pattern], consume: bool) -> list[tuple[_Pattern, int, int]]:
        if not text:
            return []
        norm, index = self._prep(text)
        found: list[tuple[_Pattern, int, int]] = []
        for pat in patterns:
            m = pat.regex.search(norm)
            if m and m.end() > m.start():
                found.append((pat, m.start(), m.end()))
        if consume:  # longer phrases win: "temporary gondola" hides "gondola"
            found.sort(key=lambda t: (t[2] - t[1]), reverse=True)
            taken: list[tuple[int, int]] = []
            kept = []
            for pat, s, e in found:
                if any(s < te and ts < e for ts, te in taken):
                    continue
                taken.append((s, e))
                kept.append((pat, s, e))
            found = kept
        return [(pat, index[s], index[e - 1] + 1) for pat, s, e in found]

    # ------------------------------------------------------------------ classification
    def classify(self, email: dict[str, Any]) -> dict[str, Any]:
        subject = str(email.get("subject") or "")
        body = str(email.get("body_text") or email.get("body") or email.get("snippet") or "")
        fresh, quoted = _split_quoted(body)
        attachments = "\n".join(str(a.get("filename") or "") for a in email.get("attachments") or []
                                if isinstance(a, dict))
        from_email = str(email.get("from_email") or "")
        from_name = str(email.get("from_name") or "")
        fields = {"subject": subject, "body": fresh, "quoted": quoted, "attachments": attachments, "from": from_name}
        source_of = {"subject": "subject", "body": "body", "quoted": "body", "attachments": "attachments",
                     "from": "from"}

        scores = {k: 0.0 for k in self.categories}
        hits: dict[str, list[tuple[float, str, str]]] = {k: [] for k in self.categories}  # (score, quote, source)
        signals: dict[str, float] = {}
        signal_hits: list[tuple[float, str, str, str]] = []
        for fname, text in fields.items():
            if not text:
                continue
            fw = _FIELD_WEIGHT[fname]
            for pat, s, e in self._scan(text, self._patterns, consume=True):
                scores[pat.target] += pat.weight * fw
                hits[pat.target].append((pat.weight * fw, _quote_window(text, s, e), source_of[fname]))
            for pat, _s, _e in self._scan(text, self._negatives, consume=False):
                scores[pat.target] -= pat.weight * fw
            for pat, s, e in self._scan(text, self._signals, consume=False):
                signals[pat.target] = signals.get(pat.target, 0.0) + pat.weight * fw
                if pat.target == "request":
                    signal_hits.append((pat.weight * fw, _quote_window(text, s, e), source_of[fname], pat.phrase))

        request = signals.get("request", 0.0)
        work_scores = {k: v for k, v in scores.items() if k in self.work_keys}
        work_best = max(work_scores.values(), default=0.0)
        strong_work = work_best >= 6 and request >= 3
        notes: list[str] = []
        header_evidence: list[tuple[str, str]] = []

        domain = _domain(from_email)
        if "vendor_offer" in scores and scores["vendor_offer"] >= 5 and request < 6:
            for k in work_scores:
                scores[k] *= 0.4
            notes.append("supplier/OEM wording outweighs the product keywords")
        if "bills" in scores and scores["bills"] >= 4 and request < 3:
            for k in work_scores:
                scores[k] *= 0.5
        list_unsub = email.get("list_unsubscribe")
        if list_unsub and "promotions" in scores and not strong_work:
            scores["promotions"] += 5
            for k in work_scores:
                scores[k] *= 0.5
            notes.append("bulk mail (List-Unsubscribe header)")
            header_evidence.append((str(list_unsub), "headers"))
        if domain and any(m in domain for m in _MARKETPLACE_DOMAINS) and "promotions" in scores and not strong_work:
            scores["promotions"] += 8
            for k in work_scores:
                scores[k] *= 0.5
            notes.append(f"marketplace/bulk sender domain {domain}")
            header_evidence.append((from_email, "from"))
        if _NOREPLY_RE.search(from_email) and "notifications" in scores and not strong_work:
            scores["notifications"] += 4
            notes.append("automated sender address")
            header_evidence.append((from_email, "from"))
        if request >= 2 and work_best > 0:  # a real request (not just quoted history) favours the work category
            best_work = max(work_scores, key=lambda k: scores[k])
            scores[best_work] += min(request, 8) * 0.5
        own_domains = self.own_domains + tuple(str(d).lower().lstrip("@") for d in email.get("own_domains") or ()
                                               if d)
        own = bool(domain) and any(domain == d or domain.endswith("." + d) for d in own_domains)
        forwarded = bool(re.match(r"^\s*(fw|fwd|tr)\s*:", subject, re.IGNORECASE))
        if own and "internal" in scores and not (forwarded and strong_work):
            # colleagues talk about BMUs all day: our own domain decides, unless it forwards a request
            scores["internal"] = max(scores.values()) + 5
            notes.append(f"sent from our own domain {domain}")
            header_evidence.append((from_email, "from"))

        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        top, s1 = ranked[0] if ranked else ("other", 0.0)
        s2 = ranked[1][1] if len(ranked) > 1 else 0.0
        if s1 < MIN_CATEGORY_SCORE:
            if request >= 3 and "other_work" in self.categories:
                top, s1 = "other_work", request
                notes.append("customer request signals without a known product keyword")
            else:
                top = "other" if "other" in self.categories else top
        confidence = 0.3 if s1 <= 0 else 0.5 + 0.35 * max(0.0, s1 - max(s2, 0.0)) / s1 + min(0.1, s1 / 40)
        confidence = round(max(0.3, min(0.95, confidence)), 2)

        is_work = top in self.work_keys
        is_request = bool(is_work and request >= 2)
        request_kind = None
        if is_request:
            if signals.get("revision"):
                request_kind = "revision"
            elif signals.get("tender"):
                request_kind = "tender_rfq"
            elif signals.get("om"):
                request_kind = "o_and_m"
            elif signals.get("info") and request < 3:
                request_kind = "info_request"
            else:
                request_kind = "direct_rfq"
        if is_request:
            priority = "high"
        elif top in self.work_keys or top in ("bills", "internal"):
            priority = "normal"
        elif top == "notifications" and scores.get("notifications", 0) >= 9:
            priority = "normal"
        else:
            priority = "low"
        if signals.get("urgent") and top in self.work_keys:
            priority = "high"

        evidence: list[dict[str, str]] = []
        for _, quote, source in sorted(hits.get(top, []), key=lambda h: h[0], reverse=True):
            if quote and all(quote != ev["quote"] for ev in evidence):
                evidence.append({"quote": quote, "source": source})
            if len(evidence) >= 3:
                break
        if top in ("promotions", "notifications", "internal"):
            for quote, source in header_evidence:
                if quote and all(quote != ev["quote"] for ev in evidence):
                    evidence.append({"quote": quote, "source": source})
        if is_request:
            for _, quote, source, _phrase in sorted(signal_hits, key=lambda h: h[0], reverse=True)[:1]:
                if all(quote != ev["quote"] for ev in evidence):
                    evidence.append({"quote": quote, "source": source})

        label = self.categories.get(top, {}).get("label", top)
        matched = ", ".join(f"'{ev['quote'][:60]}' ({ev['source']})" for ev in evidence[:3]) or "no keyword matched"
        reason = f"Rules: {label} - {matched}"
        if notes:
            reason += "; " + "; ".join(notes)
        if is_request:
            reason += "; customer request wording found"
        return {
            "category": top, "confidence": confidence, "reason": reason, "evidence": evidence,
            "priority": priority, "is_customer_request": is_request, "request_kind": request_kind,
            "scores": {k: round(v, 2) for k, v in ranked[:5] if v > 0}, "engine": "rules",
        }

    def classify_many(self, emails: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [self.classify(e) for e in emails]
