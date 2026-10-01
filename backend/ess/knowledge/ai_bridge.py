"""Lazy, signature-tolerant calls into ``ess.ai.tasks`` (another package).

The knowledge and customer modules work without AI. When an engine is given they call
``ess.ai.tasks.<name>`` if it exists, filling its parameters by name from a payload, so small
signature differences do not break the deterministic pipeline. Whatever comes back is treated as
untrusted: callers verify every quote against the source text themselves.
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import threading
from typing import Any

log = logging.getLogger(__name__)


class AITaskUnavailable(RuntimeError):
    """The AI task module/function is missing or cannot be called with what we have."""


_PARAM_ALIASES = {
    "ai": "engine", "llm": "engine", "client": "engine", "ai_engine": "engine",
    "docs": "documents", "corpus": "documents", "samples": "documents", "sources": "documents",
    "texts": "documents", "excerpts": "documents", "corpus_docs": "documents",
    "deterministic": "hints", "known": "hints", "draft": "hints", "drafts": "hints", "items": "hints",
    "existing": "hints", "seed": "hints", "candidates": "hints", "findings": "hints", "draft_items": "hints",
    "vocabulary": "region_terms", "regional_terms": "region_terms",
    "web_pages": "pages", "fetched_pages": "pages", "search_results": "results",
    "emails": "own_evidence", "own": "own_evidence", "internal_evidence": "own_evidence",
    "evidence_standard": "standard", "level": "standard",
    "company": "customer", "profile": "customer",
}


def _resolve(result: Any) -> Any:
    if not inspect.isawaitable(result):
        return result
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_await(result))
    box: dict[str, Any] = {}

    def runner() -> None:
        try:
            box["value"] = asyncio.run(_await(result))
        except BaseException as exc:  # pragma: no cover - re-raised below
            box["error"] = exc

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box.get("value")


async def _await(aw: Any) -> Any:
    return await aw


def get_task(name: str):
    try:
        tasks = importlib.import_module("ess.ai.tasks")
    except Exception as exc:
        raise AITaskUnavailable(f"ess.ai.tasks is not available ({exc})") from exc
    fn = getattr(tasks, name, None)
    if not callable(fn):
        raise AITaskUnavailable(f"ess.ai.tasks.{name} is not available")
    return fn


def call_ai_task(name: str, engine: Any, payload: dict[str, Any]) -> Any:
    """Call ``ess.ai.tasks.<name>`` filling parameters by name (with aliases) from ``payload``."""
    fn = get_task(name)
    data = {"engine": engine, **payload}
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return _resolve(fn(engine, **payload))
    args: list[Any] = []
    kwargs: dict[str, Any] = {}
    for pname, p in sig.parameters.items():
        if p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
            continue
        src = pname if pname in data else _PARAM_ALIASES.get(pname)
        if src is None or src not in data:
            if p.default is p.empty:
                raise AITaskUnavailable(f"cannot supply parameter {pname!r} of ess.ai.tasks.{name}")
            continue
        if p.kind is p.POSITIONAL_ONLY:
            args.append(data[src])
        else:
            kwargs[pname] = data[src]
    return _resolve(fn(*args, **kwargs))


def as_plain(value: Any) -> Any:
    """pydantic models / dataclasses -> plain dicts (recursively for lists)."""
    if hasattr(value, "model_dump"):
        try:
            return value.model_dump()
        except Exception:
            pass
    if hasattr(value, "__dataclass_fields__"):
        from dataclasses import asdict

        try:
            return asdict(value)
        except Exception:
            pass
    if isinstance(value, list):
        return [as_plain(v) for v in value]
    return value
