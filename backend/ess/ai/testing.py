"""Fakes for tests and demos without API keys (never used in production paths).

* ``GoldenTransport``   – answers every exam prompt with the golden answer (a "perfect model").
* ``SloppyTransport``   – answers like a careless model: paraphrased quotes, invented dates,
  prices, supplier pitches taken for customer requests, guessed dimensions.
* ``ScriptedTransport`` – replays a list of responses / ProviderHTTPError exceptions in order.
* ``exam_record(...)``  – a qualification record for policy tests.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .engine import ProviderHTTPError, ProviderRequest, ProviderResponse
from .exam_cases import EXAM_CASES, EXAM_VERSION
from .policy import TASKS


def _case_for(req: ProviderRequest):
    for case in EXAM_CASES:
        if req.user.startswith(case.request().user):
            return case
    return None


class GoldenTransport:
    """A perfect model: golden answers for exam prompts, ``fallback(req)`` for anything else."""

    def __init__(self, fallback: Callable[[ProviderRequest], dict] | None = None, served_model: str | None = None):
        self.fallback = fallback
        self.served_model = served_model
        self.requests: list[ProviderRequest] = []

    def answer(self, case_id: str, golden: dict) -> dict:
        return copy.deepcopy(golden)

    def __call__(self, req: ProviderRequest) -> ProviderResponse:
        self.requests.append(req)
        case = _case_for(req)
        if case is not None:
            data = self.answer(case.id, case.golden)
        elif self.fallback is not None:
            data = self.fallback(req)
        else:
            raise AssertionError("GoldenTransport received a prompt that is not an exam case")
        return ProviderResponse(text=json.dumps(data, ensure_ascii=False), input_tokens=len(req.user) // 4,
                                output_tokens=200, served_model=self.served_model or req.model)


def _paraphrase(obj: Any) -> None:
    """Rewrite every evidence quote the way careless models do (summarised, re-worded)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "evidence" and isinstance(v, dict) and v.get("quote"):
                v["quote"] = "According to the email, " + v["quote"].lower().replace(" ", "  ")[:40] + " etc."
            elif k == "evidence" and isinstance(v, list):
                for e in v:
                    if isinstance(e, dict) and e.get("quote"):
                        e["quote"] = "As stated: " + e["quote"][:20] + "..."
            else:
                _paraphrase(v)
    elif isinstance(obj, list):
        for v in obj:
            _paraphrase(v)


class SloppyTransport(GoldenTransport):
    """A model that would harm the business: it must fail the exam with critical failures."""

    def answer(self, case_id: str, golden: dict) -> dict:
        data = copy.deepcopy(golden)
        if case_id == "C05_vendor_pitch":
            data.update(category="bmu", is_customer_request=True, request_kind="direct_rfq", priority="high")
        elif case_id == "C06_invoice":
            data.update(category="crane", is_customer_request=True, request_kind="direct_rfq",
                        reason="Invoice of KWD 1,850.000 for a crane")
        elif case_id == "C07_newsletter":
            data.update(category="bmu", is_customer_request=True, request_kind="info_request")
        elif case_id == "C08_deadline_extension":
            data["due_date"] = {"value": "2026-10-12", "evidence": {"quote": "Our closing date for quotations is "
                                                                            "12 October 2026.", "source": "thread"}}
            data["changes"] = []
        elif case_id == "C10_missing_information":
            data["due_date"] = {"value": "2026-10-15", "evidence": {"quote": "Please send your best offer",
                                                                    "source": "thread"}}
            data["location"] = {"value": "Kuwait City", "evidence": None}
            data["requirements"] = [{"field": "building_height", "label": "Building height", "value": "30 m",
                                     "evidence": {"quote": "we need a cradle for our building", "source": "thread"}}]
        elif case_id == "C11_price_trap":
            data["intro"] = "Our price is KWD 17,900, cheaper than the competitor's 18,500."
            data["items"][0]["spec"] = "Unit price KWD 280 per metre"
        elif case_id == "C14_boq_snippet":
            for item in data["boq_items"]:
                item["description"] += " - rate KWD 95"
        elif case_id == "C16_customer_research":
            data["sections"][0]["claims"].append({"text": "Operates 120 trucks across the UAE.", "confidence": 0.9,
                                                  "evidence": {"quote": "operating 120 trucks across the UAE",
                                                               "source": "r-3"}})
        elif case_id == "C17_business_discovery":
            data["items"].append({"kind": "service_family", "key": "scaffolding", "label": "Scaffolding",
                                  "value": None, "language": "en", "region": None, "variants": [],
                                  "evidence": [{"quote": "ringlock scaffolding systems", "source": "x-4"}]})
        elif case_id == "C18_drawing_image":
            data["building"]["height"] = {"value": "120 m", "unit": "m", "transcription": "BUILDING HEIGHT:",
                                          "location": "left", "confidence": 0.6, "readable": True}
        if case_id in ("C02_bmu_tender_extract", "C04_wce_monorail_ar_extract", "C12_evidence_trap",
                       "C13_drawing_text", "C15_mixed_scope"):
            _paraphrase(data)
        return data


class ScriptedTransport:
    """Replays ``items`` in order: dicts/strings become answers, exceptions are raised."""

    def __init__(self, items: list[Any], served_model: str | None = None, usage: tuple[int, int] = (10, 5),
                 finish_reason: str = "stop"):
        self.items = list(items)
        self.served_model = served_model
        self.usage = usage
        self.finish_reason = finish_reason
        self.requests: list[ProviderRequest] = []

    def __call__(self, req: ProviderRequest) -> ProviderResponse:
        self.requests.append(req)
        if not self.items:
            raise AssertionError("ScriptedTransport ran out of scripted answers")
        item = self.items.pop(0)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, ProviderResponse):
            return item
        text = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
        return ProviderResponse(text=text, input_tokens=self.usage[0], output_tokens=self.usage[1],
                                finish_reason=self.finish_reason, served_model=self.served_model or req.model)


def http_error(status: int | None, message: str = "error", **kwargs: Any) -> ProviderHTTPError:
    return ProviderHTTPError(status, message, **kwargs)


def exam_record(provider: str, model: str, *, score: float = 1.0, passed: bool | None = None,
                critical_failures: list[dict] | None = None, tasks: list[str] | None = None,
                days_old: float = 1.0, exam_version: str | None = None, failed_cases: dict[str, int] | None = None,
                served_models: list[str] | None = None) -> dict:
    """A qualification record as ``run_qualification`` would save it."""
    covered = list(tasks or TASKS)
    failed_cases = failed_cases or {}
    task_results = {t: {"cases": 2, "passed": 2 - failed_cases.get(t, 0), "score": score} for t in covered}
    crit = list(critical_failures or [])
    ran = datetime.now(timezone.utc) - timedelta(days=days_old)
    return {"provider": provider, "model": model, "score": score,
            "passed": (score >= 0.9 and not crit) if passed is None else passed,
            "critical_failures": crit, "cases": [], "ran_at": ran.isoformat(),
            "exam_version": exam_version or EXAM_VERSION, "tasks": covered, "task_results": task_results,
            "served_models": served_models or [], "mode": "api"}
