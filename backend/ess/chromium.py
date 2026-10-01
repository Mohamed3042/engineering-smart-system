"""Shared Chromium launcher for PDF rendering and browser automation.

Playwright looks for the browser build that matches its own version. Machines
that already have a different Chromium build (CI images, cloud sandboxes) fail
that lookup, so we fall back to any known executable before giving up.
"""
from __future__ import annotations

import glob
import os
from typing import Any

from .config import get_settings

_FALLBACK_GLOBS = (
    "/opt/pw-browsers/chromium",
    "/opt/pw-browsers/chromium-*/chrome-linux/chrome",
    "/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell",
    os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"),
    os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
)


def candidate_executables() -> list[str]:
    found: list[str] = []
    configured = get_settings().chromium_path
    if configured:
        found.append(configured)
    for pattern in _FALLBACK_GLOBS:
        for path in sorted(glob.glob(pattern), reverse=True):
            if os.path.isfile(path) and os.access(path, os.X_OK) and path not in found:
                found.append(path)
    return found


async def launch_chromium(playwright: Any, **kwargs: Any) -> Any:
    """Launch Chromium with Playwright, trying fallbacks when the bundled build is missing."""
    errors: list[str] = []
    if not get_settings().chromium_path:
        try:
            return await playwright.chromium.launch(**kwargs)
        except Exception as exc:  # bundled build missing for this Playwright version
            errors.append(str(exc).splitlines()[0])
    for path in candidate_executables():
        try:
            return await playwright.chromium.launch(executable_path=path, **kwargs)
        except Exception as exc:
            errors.append(f"{path}: {str(exc).splitlines()[0]}")
    raise RuntimeError(
        "No usable Chromium found. Run `python -m playwright install chromium` "
        "or set ESS_CHROMIUM_PATH. Tried: " + " | ".join(errors)
    )
