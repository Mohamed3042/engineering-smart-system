"""Service-gap opportunities: what else a customer probably needs that we can do.

``match_services`` compares a customer's tags (role, sectors, what they asked for) with OUR
services and the cross-sell rules (``cross_sell.json``: service adjacency, needs per customer
kind, needs per project type). It only ever suggests services that are in ``our_services`` and
that the customer has not asked us for yet. ``learn_cross_sell`` derives extra adjacency rules
from what customers actually ask for together, so the rules also fit companies outside the
curated data.
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from itertools import combinations
from typing import Any, Iterable, Mapping, Sequence

from ess.knowledge.base import coerce_cross_sell, is_catch_all_category, normalize_text

#: Our customer kinds -> keys used in ``cross_sell.customer_kind_needs``.
KIND_ALIASES: dict[str, list[str]] = {
    "government": ["government", "government_authority"],
    "developer": ["developer", "building_owner"],
    "facility_management": ["facility_management"],
    "main_contractor": ["main_contractor"],
    "subcontractor": ["subcontractor"],
    "consultant": ["consultant"],
    "supplier": ["supplier"],
}
#: Sector tag keys -> keys used in ``cross_sell.project_type_needs``.
SECTOR_PROJECT_TYPES: dict[str, list[str]] = {
    "hospital": ["hospital"], "school": ["school"], "university": ["university"], "mall": ["mall"],
    "tower": ["tower", "office_tower", "residential_tower"], "hotel": ["hotel"], "airport": ["airport"],
    "stadium": ["stadium"], "government_building": ["government_building", "government"],
    "oil_gas": ["refinery", "oil_gas", "industrial_plant"], "industrial_plant": ["industrial_plant", "industrial"],
    "power_plant": ["power_plant"], "marine": ["marine", "infrastructure"], "warehouse": ["warehouse"],
    "residential": ["residential", "residential_tower", "villa"], "infrastructure": ["infrastructure"],
    "place_of_worship": ["place_of_worship"], "car_park": ["car_park"], "petrol_station": ["petrol_station"],
}
W_ADJACENT = 0.45
W_ADJACENT_REVERSE = 0.2
W_KIND = 0.3
W_SECTOR = 0.3


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _services(our_services: Iterable[Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for s in our_services or []:
        key = _get(s, "key")
        if not key:
            continue
        if _get(s, "offered") is False or _get(s, "active") is False or _get(s, "status") == "rejected":
            continue
        out[str(key)] = str(_get(s, "label") or key)
    return out


def _tag_dicts(tags: Iterable[Any]) -> list[dict[str, Any]]:
    out = []
    for t in tags or []:
        if isinstance(t, Mapping):
            out.append(dict(t))
        elif isinstance(t, str):
            out.append({"tag": t})
        else:
            out.append({k: getattr(t, k, None) for k in ("tag", "kind", "key", "confidence", "evidence")})
    return out


def match_services(customer: Any, tags: Iterable[Any], our_services: Sequence[Any],
                   cross_sell: Any = None, *, limit: int = 5, min_score: float = 0.15) -> list[dict[str, Any]]:
    """Suggested services ``[{service_key, label, score 0..1, reason, evidence[], status: "suggested"}]``.

    Signals (combined as a noisy-or, so independent reasons reinforce each other):
    adjacency of services they already asked for, typical needs of their kind of company, and
    typical needs of the project types / sectors they work in. Never suggests a service that is
    not in ``our_services`` or that the customer already asked us for.
    """
    offered = _services(our_services)
    if not offered:
        return []
    rules = coerce_cross_sell(cross_sell)
    tag_list = _tag_dicts(tags)
    label_to_key = {normalize_text(v): k for k, v in offered.items()}

    asked: dict[str, float] = {}
    asked_ev: dict[str, Any] = {}
    roles: dict[str, float] = {}
    sectors: dict[str, float] = {}
    for t in tag_list:
        kind = t.get("kind")
        conf = float(t.get("confidence") or 0.6)
        key = t.get("service_key") or t.get("key")
        if kind == "need" and key:
            asked[str(key)] = max(asked.get(str(key), 0.0), conf)
            asked_ev.setdefault(str(key), (t.get("evidence") or [None])[0])
        elif kind == "role" and key:
            roles[str(key)] = max(roles.get(str(key), 0.0), conf)
        elif kind == "sector" and key:
            sectors[str(key)] = max(sectors.get(str(key), 0.0), conf)
        elif not kind and t.get("tag"):
            k = label_to_key.get(normalize_text(t["tag"])) or (t["tag"] if t["tag"] in offered else None)
            if k:
                asked[k] = max(asked.get(k, 0.0), 0.7)
    ckind = _get(customer, "kind")
    if ckind and ckind != "other" and ckind not in roles:
        roles[str(ckind)] = float(_get(customer, "kind_confidence") or 0.7)

    signals: dict[str, list[tuple[float, str, dict[str, Any]]]] = defaultdict(list)

    def offer(service: str, p: float, reason: str, evidence: dict[str, Any]) -> None:
        if service in offered and service not in asked and not is_catch_all_category(service) and p > 0:
            signals[service].append((p, reason, evidence))

    for rule in rules.get("service_adjacency") or []:
        src, dst = rule.get("from"), rule.get("to")
        reason = rule.get("reason") or ""
        if src in asked:
            offer(dst, W_ADJACENT * asked[src], reason or f"Often needed together with {offered.get(src, src)}.",
                  {"kind": "adjacency", "from": src, "reason": reason, "basis": asked_ev.get(src)})
        if dst in asked:
            offer(src, W_ADJACENT_REVERSE * asked[dst], reason or f"Often needed together with {offered.get(dst, dst)}.",
                  {"kind": "adjacency_reverse", "from": dst, "reason": reason, "basis": asked_ev.get(dst)})
    kind_needs = rules.get("customer_kind_needs") or {}
    for role, conf in roles.items():
        keys = KIND_ALIASES.get(role, [role])
        services = list(dict.fromkeys(s for k in keys for s in kind_needs.get(k, [])))
        for s in services:
            offer(s, W_KIND * conf, f"Typical need of a {role.replace('_', ' ')}.",
                  {"kind": "customer_kind", "customer_kind": role})
    type_needs = rules.get("project_type_needs") or {}
    for sector, conf in sectors.items():
        keys = SECTOR_PROJECT_TYPES.get(sector, [sector])
        services = list(dict.fromkeys(s for k in keys for s in type_needs.get(k, [])))
        for s in services:
            offer(s, W_SECTOR * conf, f"Common in {sector.replace('_', ' ')} projects.",
                  {"kind": "project_type", "sector": sector})

    out = []
    for service, sig in signals.items():
        best: dict[str, tuple[float, str, dict]] = {}
        for p, reason, ev in sig:  # one contribution per distinct source (rule / role / sector)
            src = f"{ev['kind']}:{ev.get('from') or ev.get('customer_kind') or ev.get('sector')}"
            if src not in best or p > best[src][0]:
                best[src] = (p, reason, ev)
        ps = sorted(best.values(), key=lambda x: -x[0])
        score = 1.0 - math.prod(1.0 - p for p, _r, _e in ps)
        score = round(min(0.95, score), 3)
        if score < min_score:
            continue
        reasons = list(dict.fromkeys(r for _p, r, _e in ps if r))[:2]
        out.append({"service_key": service, "label": offered[service], "score": score,
                    "reason": " ".join(reasons), "evidence": [e for _p, _r, e in ps][:5], "status": "suggested"})
    out.sort(key=lambda o: (-o["score"], o["service_key"]))
    return out[:limit] if limit else out


def learn_cross_sell(need_sets: Mapping[str, Iterable[str]] | Iterable[Iterable[str]], *, min_support: int = 3,
                     min_confidence: float = 0.3, min_lift: float = 1.2) -> dict[str, Any]:
    """Adjacency rules mined from what customers ask for together ("customers asking for A also
    asked for B": support, confidence P(B|A), lift). The result can be passed as ``cross_sell``."""
    sets = [set(s) for s in (need_sets.values() if isinstance(need_sets, Mapping) else need_sets)]
    sets = [s for s in sets if s]
    n = len(sets)
    single: Counter = Counter()
    pair: Counter = Counter()
    for s in sets:
        single.update(s)
        for a, b in combinations(sorted(s), 2):
            pair[(a, b)] += 1
    rules = []
    for (a, b), c in pair.items():
        if c < min_support:
            continue
        for x, y in ((a, b), (b, a)):
            conf = c / single[x]
            lift = conf / (single[y] / n) if n else 0.0
            if conf >= min_confidence and lift >= min_lift:
                rules.append({"from": x, "to": y, "reason": f"{c} customers who asked for {x} also asked for {y}.",
                              "support": c, "confidence": round(conf, 3), "lift": round(lift, 2)})
    rules.sort(key=lambda r: (-r["confidence"], -r["support"], r["from"], r["to"]))
    return {"version": 1, "service_adjacency": rules, "customer_kind_needs": {}, "project_type_needs": {}}


def merge_cross_sell(*sources: Any) -> dict[str, Any]:
    """Combine curated and learned rules (later sources add to earlier ones)."""
    out: dict[str, Any] = {"version": 1, "service_adjacency": [], "customer_kind_needs": {}, "project_type_needs": {}}
    seen: set[tuple[str, str]] = set()
    for src in sources:
        rules = coerce_cross_sell(src) if not isinstance(src, Mapping) or "service_adjacency" not in src else src
        for r in rules.get("service_adjacency") or []:
            k = (r.get("from"), r.get("to"))
            if k not in seen:
                seen.add(k)
                out["service_adjacency"].append(dict(r))
        for name in ("customer_kind_needs", "project_type_needs"):
            for k, lst in (rules.get(name) or {}).items():
                cur = out[name].setdefault(k, [])
                cur.extend(s for s in lst if s not in cur)
    return out
