"""Tiny background job runner (thread pool). Async callables get their own event loop."""
from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable

log = logging.getLogger("ess.jobs")
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ess-job")
_running: dict[str, Future] = {}
_lock = threading.Lock()


def _call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        if inspect.iscoroutinefunction(fn):
            return asyncio.run(fn(*args, **kwargs))
        result = fn(*args, **kwargs)
        if inspect.iscoroutine(result):
            return asyncio.run(result)
        return result
    except Exception:  # surfaced through the job's own status record
        log.error("background job failed:\n%s", traceback.format_exc())
        raise


def submit(key: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> bool:
    """Run fn in the background unless a job with the same key is still running."""
    with _lock:
        fut = _running.get(key)
        if fut is not None and not fut.done():
            return False
        _running[key] = _pool.submit(_call, fn, *args, **kwargs)
        return True


def is_running(key: str) -> bool:
    fut = _running.get(key)
    return fut is not None and not fut.done()


def running_keys(prefix: str = "") -> list[str]:
    """Keys of jobs still running (optionally only those starting with ``prefix``)."""
    with _lock:
        return [k for k, fut in _running.items() if k.startswith(prefix) and not fut.done()]


def wait(key: str, timeout: float | None = None) -> Any:
    fut = _running.get(key)
    return fut.result(timeout=timeout) if fut else None
