"""App-owned research checkpoints survive a restart, key change or provider switch."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from .search import PageText, SearchResult, SearchUnavailable, fetch_page_text


class ResearchCheckpoint:
    def __init__(self, path: Path, inputs: dict, provider, reader=None):
        self.path, self.provider, self.reader = path, provider, reader
        self.name = provider.name
        self.blocked: dict[str, str] = {}
        digest = hashlib.sha256(json.dumps(inputs, sort_keys=True, default=str).encode()).hexdigest()
        self.data = {"version": 1, "inputs": digest, "searches": {}, "pages": {}}
        try:
            saved = json.loads(path.read_text())
            if saved.get("version") == 1 and saved.get("inputs") == digest:
                self.data = saved
        except (OSError, ValueError):
            pass

    @property
    def paused_reason(self):
        return next(iter(self.blocked.values()), None)

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = self.path.with_suffix(".tmp")
        with open(temp, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
            json.dump(self.data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        temp.replace(self.path)

    def _call(self, lane, fn, *args, **kwargs):
        if lane in self.blocked:
            raise SearchUnavailable(self.blocked[lane])
        try:
            return fn(*args, **kwargs)
        except SearchUnavailable as exc:
            self.blocked[lane] = str(exc)
            raise

    def search(self, query, **kwargs):
        key = json.dumps([query, kwargs], sort_keys=True)
        if key not in self.data["searches"]:
            found = self._call("search", self.provider.search, query, **kwargs)
            self.data["searches"][key] = [r.to_dict() for r in found]
            self._save()
        return [SearchResult(**row) for row in self.data["searches"][key]]

    def fetch_page(self, url):
        if url not in self.data["pages"]:
            owner = self.reader or self.provider
            fetch = getattr(owner, "fetch_page", None) or fetch_page_text
            lane = "reader" if self.reader else "search" if hasattr(owner, "fetch_page") else "direct"
            page = self._call(lane, fetch, url)
            if not page.ok:
                return page
            self.data["pages"][url] = page.to_dict()
            self._save()
        return PageText(**self.data["pages"][url])

    def close(self):
        for resource in (self.provider, self.reader):
            if callable(getattr(resource, "close", None)):
                resource.close()
