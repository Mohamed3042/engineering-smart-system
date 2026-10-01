"""Local persistence for the workspace AI policy and qualification exam results.

Files live under ``<data_dir>/ai/`` (git-ignored): ``policy.json`` and ``qualifications.json``.
The engine reads both on every call, so a policy change or a new exam takes effect immediately for
the UI, the REST API and the MCP server alike.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from .policy import DEFAULT_POLICY, Policy

log = logging.getLogger(__name__)
_LOCK = threading.RLock()
HISTORY_PER_MODEL = 10


def ai_dir() -> Path:
    from ..config import get_settings

    path = get_settings().data_dir / "ai"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_json(path: Path, data: Any) -> None:
    fd, tmp = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2, default=str)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _read_json(path: Path, default: Any) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as exc:
        log.warning("cannot read %s (%s); using defaults", path, exc)
        return default


# ------------------------------------------------------------------ policy

def load_policy() -> Policy:
    """The workspace policy (DEFAULT_POLICY when none is saved). A damaged file falls back to the
    default, which *is* the hard floor – so failure never loosens anything."""
    with _LOCK:
        data = _read_json(ai_dir() / "policy.json", None)
    if not isinstance(data, dict):
        return DEFAULT_POLICY
    try:
        return Policy.from_dict(data, strict=False)
    except (TypeError, ValueError) as exc:
        log.warning("invalid policy.json (%s); using the default policy", exc)
        return DEFAULT_POLICY


def save_policy(policy: Policy | dict[str, Any]) -> Policy:
    """Validate (strictly – weakening raises PolicyError) and save the workspace policy."""
    data = policy.to_dict() if isinstance(policy, Policy) else dict(policy)
    pol = Policy.from_dict(data, strict=True)
    with _LOCK:
        _write_json(ai_dir() / "policy.json", pol.to_dict())
    return pol


# ------------------------------------------------------------------ exams

def _key(provider: str, model: str) -> str:
    return f"{provider}:{model}"


def save_exam(result: dict[str, Any]) -> None:
    key = _key(result["provider"], result["model"])
    with _LOCK:
        path = ai_dir() / "qualifications.json"
        data = _read_json(path, {})
        if not isinstance(data, dict):
            data = {}
        history = [r for r in data.get(key, []) if isinstance(r, dict)]
        history.append(result)
        data[key] = history[-HISTORY_PER_MODEL:]
        _write_json(path, data)


def exam_history(provider: str, model: str) -> list[dict[str, Any]]:
    with _LOCK:
        data = _read_json(ai_dir() / "qualifications.json", {})
    rows = data.get(_key(provider, model), []) if isinstance(data, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def latest_exam(provider: str, model: str) -> dict[str, Any] | None:
    history = exam_history(provider, model)
    return history[-1] if history else None


def all_latest_exams() -> dict[str, dict[str, Any]]:
    with _LOCK:
        data = _read_json(ai_dir() / "qualifications.json", {})
    if not isinstance(data, dict):
        return {}
    return {k: v[-1] for k, v in data.items() if isinstance(v, list) and v and isinstance(v[-1], dict)}
