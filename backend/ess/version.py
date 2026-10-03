"""Release identity for the running engine; no local paths enter the public health response."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

VERSION = "0.3.0"


def get_build_commit(checkout: Path | None = None) -> str:
    """Read this checkout's actual HEAD, or report unknown for an unversioned install."""
    root = checkout or Path(__file__).resolve().parents[2]
    # A portable copy must not accidentally report an unrelated parent repository's HEAD.
    if not (root / ".git").exists():
        return "unknown"
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"], cwd=root,
            capture_output=True, text=True, check=True, timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    commit = result.stdout.strip().lower()
    return commit if re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", commit) else "unknown"
