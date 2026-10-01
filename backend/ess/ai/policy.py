"""Model eligibility policy: which models may run which task.

A model is **eligible** for a task only when *all* of these hold:

1. It is not refused: tier is not ``light``/``refused``, it is not deprecated, it matches no
   refusal rule (non-chat modality, moving alias, router, free/online gateway variant, …), no
   workspace-blocked pattern and no blocked provider.
2. It has the required capabilities: structured output (always), vision for ``analyze_drawing``,
   a context window of at least 128k tokens.
3. Its tier is allowed for the task: critical tasks (extraction, documents, drawings, quotations,
   business discovery, customer research) accept **frontier** models only; ``classify_email``
   accepts frontier or standard.
4. It passed the qualification exam on this workspace: score ≥ 0.90, zero critical failures, every
   case of that task passed, exam younger than 30 days and taken with the current exam suite.

The numbers above are the **hard floor**. A workspace policy (``Policy``) may only tighten it –
add blocked patterns/providers, raise ``min_score``, shorten the exam validity, require more
capabilities or narrow allowed tiers. Weakening attempts are reported by ``Policy.violations()``,
rejected by ``Policy.from_dict(..., strict=True)`` and, whatever happens, neutralised by
``Policy.effective()``, which :func:`evaluate_model` always applies. There is no bypass flag.

The only loosening an admin can make is ``promoted_models``: a *rules-classified standard* model
(e.g. a new flagship the catalogue does not know yet) may be treated as frontier after it passed
the **full** exam with score ≥ 0.95. Light and refused models can never be promoted.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .errors import PolicyError
from .registry import ModelSpec, base_model_id, hard_refusal

TASKS = ("classify_email", "extract_request", "analyze_document", "analyze_drawing", "draft_quotation",
         "discover_business", "research_customer")
CRITICAL_TASKS = frozenset(t for t in TASKS if t != "classify_email")
STATUSES = ("eligible", "refused", "needs_evaluation", "failed_evaluation")
CAPABILITY_NAMES = ("structured_output", "vision", "tool_use", "pdf_input")

# ------------------------------------------------------------------ hard floor (code, not config)
MIN_SCORE_FLOOR = 0.90
MAX_CRITICAL_FAILURES = 0
MAX_EXAM_AGE_CEILING_DAYS = 30
MIN_CONTEXT_FLOOR = 128_000
PROMOTION_MIN_SCORE = 0.95
MANDATORY_CAPABILITIES = frozenset({"structured_output"})
MANDATORY_TASK_CAPABILITIES: dict[str, frozenset[str]] = {"analyze_drawing": frozenset({"vision"})}
MAX_TIERS: dict[str, frozenset[str]] = {
    **{t: frozenset({"frontier"}) for t in CRITICAL_TASKS},
    "classify_email": frozenset({"frontier", "standard"}),
}
NEVER_TIERS = frozenset({"light", "refused"})
UNKNOWN_TASK_TIERS = frozenset({"frontier"})  # a task name we do not know is treated as critical


def _now() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@dataclass
class Policy:
    version: int = 1
    min_score: float = MIN_SCORE_FLOOR
    max_exam_age_days: int = MAX_EXAM_AGE_CEILING_DAYS
    min_context_tokens: int = MIN_CONTEXT_FLOOR
    required_capabilities: list[str] = field(default_factory=lambda: sorted(MANDATORY_CAPABILITIES))
    task_capabilities: dict[str, list[str]] = field(
        default_factory=lambda: {t: sorted(c) for t, c in MANDATORY_TASK_CAPABILITIES.items()})
    allowed_tiers: dict[str, list[str]] = field(default_factory=lambda: {t: sorted(MAX_TIERS[t]) for t in TASKS})
    blocked_patterns: list[str] = field(default_factory=list)
    blocked_providers: list[str] = field(default_factory=list)
    promoted_models: list[str] = field(default_factory=list)
    notes: str = ""

    # ---------------------------------------------------------------- floor enforcement
    def violations(self) -> list[str]:
        """Every setting that tries to weaken the hard floor (empty list = acceptable policy)."""
        v: list[str] = []
        try:
            if float(self.min_score) < MIN_SCORE_FLOOR:
                v.append(f"min_score {self.min_score} is below the hard floor {MIN_SCORE_FLOOR:.2f}")
            if float(self.min_score) > 1:
                v.append("min_score cannot exceed 1.0")
        except (TypeError, ValueError):
            v.append(f"min_score {self.min_score!r} is not a number")
        try:
            if int(self.max_exam_age_days) > MAX_EXAM_AGE_CEILING_DAYS:
                v.append(f"max_exam_age_days {self.max_exam_age_days} exceeds the hard ceiling "
                         f"{MAX_EXAM_AGE_CEILING_DAYS} days")
            if int(self.max_exam_age_days) < 1:
                v.append("max_exam_age_days must be at least 1")
        except (TypeError, ValueError):
            v.append(f"max_exam_age_days {self.max_exam_age_days!r} is not a number")
        try:
            if int(self.min_context_tokens) < MIN_CONTEXT_FLOOR:
                v.append(f"min_context_tokens {self.min_context_tokens} is below the hard floor {MIN_CONTEXT_FLOOR}")
        except (TypeError, ValueError):
            v.append(f"min_context_tokens {self.min_context_tokens!r} is not a number")
        caps = set(self.required_capabilities or [])
        for missing in sorted(MANDATORY_CAPABILITIES - caps):
            v.append(f"required capability '{missing}' cannot be removed")
        for unknown in sorted(caps - set(CAPABILITY_NAMES)):
            v.append(f"unknown capability '{unknown}'")
        for task, mandatory in MANDATORY_TASK_CAPABILITIES.items():
            for missing in sorted(mandatory - set((self.task_capabilities or {}).get(task, []))):
                v.append(f"task '{task}' must keep capability '{missing}'")
        for task, tiers in (self.allowed_tiers or {}).items():
            if task not in MAX_TIERS:
                v.append(f"allowed_tiers: unknown task '{task}'")
                continue
            for tier in tiers:
                if tier in NEVER_TIERS:
                    v.append(f"allowed_tiers[{task}]: tier '{tier}' can never be allowed")
                elif tier not in MAX_TIERS[task]:
                    kind = "critical task" if task in CRITICAL_TASKS else "task"
                    v.append(f"allowed_tiers[{task}]: tier '{tier}' is not allowed for {kind} '{task}' "
                             f"(maximum: {', '.join(sorted(MAX_TIERS[task]))})")
        for pat in self.blocked_patterns or []:
            if not isinstance(pat, str) or not pat.strip():
                v.append(f"blocked pattern {pat!r} is empty")
            elif pat.startswith("re:"):
                try:
                    re.compile(pat[3:])
                except re.error as exc:
                    v.append(f"blocked pattern {pat!r} is not a valid regex: {exc}")
        for key in self.promoted_models or []:
            if not isinstance(key, str) or ":" not in key:
                v.append(f"promoted model {key!r} must look like 'provider:model_id'")
        return v

    def effective(self) -> "Policy":
        """A copy clamped to the hard floor. Used by every evaluation, so a weakened policy –
        whether loaded from disk, posted to the API or built in code – can never take effect."""
        def num(value: Any, default: float) -> float:
            try:
                return float(value)
            except (TypeError, ValueError):
                return default

        tiers: dict[str, list[str]] = {}
        for task in TASKS:
            requested = (self.allowed_tiers or {}).get(task, sorted(MAX_TIERS[task]))
            tiers[task] = sorted((set(requested) & MAX_TIERS[task]) - NEVER_TIERS)
        task_caps: dict[str, list[str]] = {}
        for task in TASKS:
            wanted = set((self.task_capabilities or {}).get(task, [])) & set(CAPABILITY_NAMES)
            wanted |= MANDATORY_TASK_CAPABILITIES.get(task, frozenset())
            if wanted:
                task_caps[task] = sorted(wanted)
        valid_patterns: list[str] = []
        for pat in self.blocked_patterns or []:
            if not isinstance(pat, str) or not pat.strip():
                continue
            if pat.startswith("re:"):
                try:
                    re.compile(pat[3:])
                except re.error:
                    continue
            valid_patterns.append(pat.strip())
        return Policy(
            version=int(num(self.version, 1)),
            min_score=min(1.0, max(MIN_SCORE_FLOOR, num(self.min_score, MIN_SCORE_FLOOR))),
            max_exam_age_days=int(max(1, min(MAX_EXAM_AGE_CEILING_DAYS,
                                              num(self.max_exam_age_days, MAX_EXAM_AGE_CEILING_DAYS)))),
            min_context_tokens=int(max(MIN_CONTEXT_FLOOR, num(self.min_context_tokens, MIN_CONTEXT_FLOOR))),
            required_capabilities=sorted((set(self.required_capabilities or []) & set(CAPABILITY_NAMES))
                                         | MANDATORY_CAPABILITIES),
            task_capabilities=task_caps,
            allowed_tiers=tiers,
            blocked_patterns=valid_patterns,
            blocked_providers=sorted({str(p).strip() for p in self.blocked_providers or [] if str(p).strip()}),
            promoted_models=sorted({str(k).strip() for k in self.promoted_models or [] if ":" in str(k)}),
            notes=str(self.notes or ""),
        )

    # ---------------------------------------------------------------- helpers
    def tiers_for(self, task: str | None) -> frozenset[str]:
        if task in TASKS:
            return frozenset(self.effective().allowed_tiers.get(task, []))
        return UNKNOWN_TASK_TIERS

    def blocked_by(self, spec: ModelSpec) -> str | None:
        names = {f"{spec.provider}:{spec.model_id}".lower(), spec.model_id.lower(), base_model_id(spec.model_id)}
        if spec.canonical_id:
            names |= {spec.canonical_id.lower(), f"{spec.provider}:{spec.canonical_id}".lower()}
        for pat in self.blocked_patterns or []:
            if pat.startswith("re:"):
                rx = re.compile(pat[3:], re.IGNORECASE)
                if any(rx.search(n) for n in names):
                    return pat
            elif any(fnmatch.fnmatchcase(n, pat.lower()) for n in names):
                return pat
        return None

    def is_promoted(self, spec: ModelSpec) -> bool:
        keys = {f"{spec.provider}:{spec.model_id}".lower()}
        return any(k.lower() in keys for k in self.promoted_models or [])

    # ---------------------------------------------------------------- (de)serialisation
    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version, "min_score": self.min_score, "max_exam_age_days": self.max_exam_age_days,
            "min_context_tokens": self.min_context_tokens,
            "required_capabilities": list(self.required_capabilities),
            "task_capabilities": {k: list(v) for k, v in (self.task_capabilities or {}).items()},
            "allowed_tiers": {k: list(v) for k, v in (self.allowed_tiers or {}).items()},
            "blocked_patterns": list(self.blocked_patterns), "blocked_providers": list(self.blocked_providers),
            "promoted_models": list(self.promoted_models), "notes": self.notes,
            "max_critical_failures": MAX_CRITICAL_FAILURES,  # informational: fixed in code
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None, *, strict: bool = False) -> "Policy":
        """Build a policy from JSON. With ``strict=True`` any attempt to weaken the hard floor (or an
        unknown key) raises :class:`PolicyError`; otherwise the values are kept as given and
        ``effective()`` clamps them at evaluation time."""
        data = dict(data or {})
        known = set(cls.__dataclass_fields__)
        problems: list[str] = []
        if "max_critical_failures" in data:
            try:
                if int(data.pop("max_critical_failures")) != MAX_CRITICAL_FAILURES:
                    problems.append("max_critical_failures is fixed at 0")
            except (TypeError, ValueError):
                problems.append("max_critical_failures is fixed at 0")
        for key in sorted(set(data) - known):
            problems.append(f"unknown policy key '{key}'")
            data.pop(key)
        policy = cls(**data)
        problems += policy.violations()
        if strict and problems:
            raise PolicyError("policy would weaken the hard floor: " + "; ".join(problems),
                              details={"violations": problems})
        return policy


DEFAULT_POLICY = Policy()


@dataclass
class EligibilityResult:
    status: str  # eligible | refused | needs_evaluation | failed_evaluation
    reasons: list[str]
    warnings: list[str] = field(default_factory=list)
    provider: str = ""
    model: str = ""
    task: str | None = None
    tier: str | None = None
    allowed_tasks: list[str] = field(default_factory=list)
    exam: dict[str, Any] | None = None

    @property
    def eligible(self) -> bool:
        return self.status == "eligible"

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "reasons": list(self.reasons), "warnings": list(self.warnings),
                "provider": self.provider, "model": self.model, "task": self.task, "tier": self.tier,
                "allowed_tasks": list(self.allowed_tasks), "exam": self.exam}


# ------------------------------------------------------------------ exam checks

def _current_exam_version() -> str:
    from .exam_cases import EXAM_VERSION  # lazy: exam_cases imports the task prompts

    return EXAM_VERSION


def exam_summary(exam: dict | None, policy: Policy) -> dict[str, Any] | None:
    if not exam:
        return None
    ran = parse_time(exam.get("ran_at"))
    return {
        "score": exam.get("score"), "passed": exam.get("passed"), "ran_at": exam.get("ran_at"),
        "expires_at": (ran + timedelta(days=policy.max_exam_age_days)).isoformat() if ran else None,
        "exam_version": exam.get("exam_version"), "tasks": list(exam.get("tasks") or []),
        "critical_failures": len(exam.get("critical_failures") or []),
    }


def exam_state(spec: ModelSpec, exam: dict | None, policy: Policy, *, now: datetime | None = None,
               exam_version: str | None = None) -> tuple[str, list[str]]:
    """('passed'|'missing'|'stale'|'failed', reasons) for the exam record of ``spec``."""
    pol = policy.effective()
    now = now or _now()
    if not exam:
        return "missing", ["qualification exam not taken yet (Settings → AI → Run qualification)"]
    if exam.get("provider") != spec.provider or exam.get("model") != spec.model_id:
        return "missing", [f"the exam on record belongs to {exam.get('provider')}:{exam.get('model')}, "
                           f"not {spec.provider}:{spec.model_id}"]
    version = exam_version or _current_exam_version()
    if exam.get("exam_version") != version:
        return "stale", [f"the exam suite changed ({exam.get('exam_version')} → {version}); re-run the exam"]
    ran = parse_time(exam.get("ran_at"))
    if ran is None:
        return "stale", ["exam record has no valid date; re-run the exam"]
    if ran > now + timedelta(minutes=5):
        return "stale", ["exam date lies in the future; re-run the exam"]
    age = now - ran
    if age > timedelta(days=pol.max_exam_age_days):
        return "stale", [f"last exam is {age.days} days old (maximum {pol.max_exam_age_days} days); re-run it"]
    reasons: list[str] = []
    crit = exam.get("critical_failures") or []
    if len(crit) > MAX_CRITICAL_FAILURES:
        sample = "; ".join(f"{c.get('case')}: {c.get('check')}" for c in crit[:3] if isinstance(c, dict))
        reasons.append(f"{len(crit)} critical failure(s) in the exam ({sample})")
    try:
        score = float(exam.get("score"))
    except (TypeError, ValueError):
        score = 0.0
    if score < pol.min_score:
        reasons.append(f"exam score {score:.2f} is below the required {pol.min_score:.2f}")
    if exam.get("passed") is not True and not reasons:
        reasons.append("the exam was not passed")
    return ("failed", reasons) if reasons else ("passed", [])


def _task_passed(exam: dict, task: str) -> tuple[bool, str]:
    covered = set(exam.get("tasks") or [])
    if task not in covered:
        return False, f"the exam did not cover task '{task}'"
    tr = (exam.get("task_results") or {}).get(task)
    if isinstance(tr, dict) and tr.get("passed", 0) < tr.get("cases", 0):
        return False, f"{tr.get('cases', 0) - tr.get('passed', 0)} exam case(s) of '{task}' failed"
    return True, ""


def _promotion_ok(spec: ModelSpec, exam: dict | None, pol: Policy, now: datetime,
                  exam_version: str | None) -> tuple[bool, str]:
    state, why = exam_state(spec, exam, pol, now=now, exam_version=exam_version)
    if state != "passed":
        return False, "; ".join(why)
    assert exam is not None
    if float(exam.get("score") or 0) < PROMOTION_MIN_SCORE:
        return False, f"promotion needs an exam score of at least {PROMOTION_MIN_SCORE:.2f}"
    missing = sorted(CRITICAL_TASKS - set(exam.get("tasks") or []))
    if missing:
        return False, f"promotion needs the full exam (missing: {', '.join(missing)})"
    for task in sorted(CRITICAL_TASKS):
        ok, why_task = _task_passed(exam, task)
        if not ok:
            return False, why_task
    return True, ""


# ------------------------------------------------------------------ evaluation

def evaluate_model(spec: ModelSpec, policy: Policy | None = None, exam: dict | None = None,
                   task: str | None = None, *, now: datetime | None = None,
                   exam_version: str | None = None) -> EligibilityResult:
    """Decide whether ``spec`` may run ``task`` (or, with ``task=None``, whether it can be selected
    at all and for which tasks). Always applies the hard floor."""
    pol = (policy or DEFAULT_POLICY).effective()
    now = now or _now()
    warnings: list[str] = []
    hard: list[str] = []
    caps = spec.capabilities

    if spec.provider in pol.blocked_providers:
        hard.append(f"provider '{spec.provider}' is blocked by the workspace policy")
    rule = hard_refusal(spec.model_id, spec.provider)
    if rule:
        hard.append(f"refused by rule '{rule[0]}': {rule[1]}")
    pattern = pol.blocked_by(spec)
    if pattern:
        hard.append(f"blocked by the workspace pattern {pattern!r}")
    if spec.tier == "refused":
        hard.append(f"tier 'refused': {spec.notes or 'not allowed in this workspace'}")
    elif spec.tier == "light":
        hard.append("tier 'light': small/fast models are prone to lower the quality and are never allowed")
    elif spec.tier not in ("frontier", "standard"):
        hard.append(f"unknown tier {spec.tier!r}")
    if spec.deprecated:
        hard.append("deprecated by the provider: it may be retired in the middle of a project")
    for cap in pol.required_capabilities:
        value = getattr(caps, cap, None)
        if value is False:
            hard.append(f"missing required capability '{cap}'")
        elif value is None:
            warnings.append(f"capability '{cap}' is unverified: the qualification exam must prove it")
    if caps.context_tokens is not None and caps.context_tokens < pol.min_context_tokens:
        hard.append(f"context window {caps.context_tokens:,} tokens is below the minimum {pol.min_context_tokens:,}")
    elif caps.context_tokens is None:
        warnings.append("context window unknown: over-long inputs are rejected, never truncated")

    tier = spec.tier
    if not hard and pol.is_promoted(spec):
        if spec.source == "rules" and spec.tier == "standard":
            ok, why = _promotion_ok(spec, exam, pol, now, exam_version)
            if ok:
                tier = "frontier"
                warnings.append("treated as frontier: promoted by the workspace admin after a full exam "
                                f"with score ≥ {PROMOTION_MIN_SCORE:.2f}")
            else:
                warnings.append(f"promotion not applied: {why}")
        else:
            warnings.append("promotion ignored: only rules-classified standard models can be promoted")

    def task_blockers(t: str) -> list[str]:
        out: list[str] = []
        allowed = set(pol.allowed_tiers.get(t, [])) if t in TASKS else set(UNKNOWN_TASK_TIERS)
        if tier not in allowed:
            if t in CRITICAL_TASKS or t not in TASKS:
                out.append(f"tier '{tier}' is not allowed for critical task '{t}' (frontier models only)")
            else:
                out.append(f"tier '{tier}' is not allowed for task '{t}'")
        for cap in pol.task_capabilities.get(t, []):
            if getattr(caps, cap, None) is False:
                out.append(f"task '{t}' needs capability '{cap}'")
        return out

    if task is not None and task not in TASKS:
        warnings.append(f"unknown task '{task}' is treated as a critical task")

    summary = exam_summary(exam, pol)
    base = dict(provider=spec.provider, model=spec.model_id, task=task, tier=tier, exam=summary)

    if hard:
        return EligibilityResult("refused", hard, warnings, **base)
    if task is not None:
        blockers = task_blockers(task)
        if blockers:
            return EligibilityResult("refused", blockers, warnings, **base)
        candidate_tasks = [task]
    else:
        candidate_tasks = [t for t in TASKS if not task_blockers(t)]
        if not candidate_tasks:
            return EligibilityResult("refused", ["not allowed for any task"], warnings, **base)

    state, exam_reasons = exam_state(spec, exam, pol, now=now, exam_version=exam_version)
    if state != "passed":
        status = "failed_evaluation" if state == "failed" else "needs_evaluation"
        return EligibilityResult(status, exam_reasons, warnings, allowed_tasks=[], **base)

    assert exam is not None

    def task_qualified(t: str) -> tuple[bool, str]:
        if t in TASKS:
            return _task_passed(exam, t)
        for critical in sorted(CRITICAL_TASKS):  # unknown task: every critical task must be qualified
            ok, why = _task_passed(exam, critical)
            if not ok:
                return False, f"unknown task '{t}' needs every critical task qualified ({why})"
        return True, ""

    passed_tasks: list[str] = []
    not_qualified: dict[str, str] = {}
    for t in candidate_tasks:
        ok, why = task_qualified(t)
        if ok:
            passed_tasks.append(t)
        else:
            not_qualified[t] = why
    if not passed_tasks:
        return EligibilityResult("needs_evaluation", list(not_qualified.values()) or
                                 ["the exam covered no allowed task"], warnings, **base)
    if task is None:
        for t in TASKS:
            if t not in passed_tasks:
                why = "; ".join(task_blockers(t)) or not_qualified.get(t, "not qualified")
                warnings.append(f"not for '{t}': {why}")
    return EligibilityResult("eligible", [], warnings, allowed_tasks=passed_tasks, **base)


def eligibility_table(specs: list[ModelSpec], policy: Policy | None = None,
                      exams: dict[str, dict] | None = None) -> list[dict[str, Any]]:
    """Model-level eligibility for many specs (UI listing). ``exams`` maps ``provider:model`` → exam."""
    rows = []
    for spec in specs:
        res = evaluate_model(spec, policy, (exams or {}).get(spec.key))
        rows.append({**spec.to_dict(), "eligibility": res.to_dict()})
    order = {"eligible": 0, "needs_evaluation": 1, "failed_evaluation": 2, "refused": 3}
    tier_order = {"frontier": 0, "standard": 1, "light": 2, "refused": 3}
    rows.sort(key=lambda r: (order[r["eligibility"]["status"]], tier_order.get(r["tier"], 9), r["model_id"]))
    return rows
