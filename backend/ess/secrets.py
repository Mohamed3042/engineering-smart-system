"""Encrypted local secret store (API keys, OAuth tokens, IMAP passwords).

Values are encrypted with a Fernet key kept in data/.secret.key (mode 600). The API never
returns secret values — only whether a secret is set and a short hint.
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

_lock = threading.Lock()


def _fernet() -> Fernet:
    settings = get_settings()
    key_path = settings.secret_key_path
    if not key_path.exists():
        key_path.write_bytes(Fernet.generate_key())
        os.chmod(key_path, 0o600)
    return Fernet(key_path.read_bytes().strip())


def _load() -> dict[str, Any]:
    path = get_settings().secrets_path
    if not path.exists():
        return {}
    try:
        return json.loads(_fernet().decrypt(path.read_bytes()))
    except (InvalidToken, ValueError) as exc:  # key rotated or file damaged
        raise RuntimeError("Secret store cannot be decrypted with data/.secret.key") from exc


def _save(data: dict[str, Any]) -> None:
    path = get_settings().secrets_path
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(_fernet().encrypt(json.dumps(data).encode()))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def set_secret(name: str, value: Any) -> None:
    with _lock:
        data = _load()
        data[name] = value
        _save(data)


def get_secret(name: str, default: Any = None) -> Any:
    with _lock:
        return _load().get(name, default)


def delete_secret(name: str) -> None:
    with _lock:
        data = _load()
        if data.pop(name, None) is not None:
            _save(data)


def secret_hint(name: str) -> dict[str, Any]:
    value = get_secret(name)
    if value is None:
        return {"set": False, "hint": None}
    if isinstance(value, str) and len(value) > 8:
        return {"set": True, "hint": f"…{value[-4:]}"}
    return {"set": True, "hint": "stored"}
