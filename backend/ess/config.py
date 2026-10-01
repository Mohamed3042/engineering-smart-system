"""Runtime settings. Every path the app writes to lives under DATA_DIR (git-ignored)."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings:
    def __init__(self) -> None:
        self.data_dir = Path(os.environ.get("ESS_DATA_DIR", REPO_ROOT / "data")).resolve()
        self.host = os.environ.get("ESS_HOST", "127.0.0.1")
        self.port = int(os.environ.get("ESS_PORT", "8765"))
        self.frontend_dist = Path(os.environ.get("ESS_FRONTEND_DIST", REPO_ROOT / "frontend" / "dist"))
        self.chromium_path = os.environ.get("ESS_CHROMIUM_PATH")

    # Layout inside data_dir -------------------------------------------------
    @property
    def db_path(self) -> Path:
        return self.data_dir / "ess.sqlite3"

    @property
    def files_dir(self) -> Path:
        """Project inputs: attachments, downloads, extracted text, page renders."""
        return self.data_dir / "files"

    @property
    def quotations_dir(self) -> Path:
        return self.data_dir / "quotations"

    @property
    def private_dir(self) -> Path:
        """Company-private assets (letterhead, stamp, signatures). Never committed."""
        return self.data_dir / "private"

    @property
    def secrets_path(self) -> Path:
        return self.data_dir / "secrets.enc.json"

    @property
    def secret_key_path(self) -> Path:
        return self.data_dir / ".secret.key"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.files_dir, self.quotations_dir, self.private_dir):
            p.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s
