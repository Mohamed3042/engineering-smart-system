"""Live model listing per provider ("which models can this API key use?").

``list_remote_models`` returns plain IDs; ``list_remote_model_details`` also returns what the
provider reports about each model (context window, vision, structured output) so unknown IDs can
be classified with real data; ``available_models`` merges the live list with the curated registry
and the workspace policy – the list the Settings screen shows, refused models included (greyed out
with the reason), so nobody wonders why a model cannot be picked.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import httpx

from .errors import AIError, AuthError, ProviderError, QuotaError

OPENAI_BASE_URL = "https://api.openai.com/v1"
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com"
ANTHROPIC_VERSION = "2023-06-01"
AZURE_DEPLOYMENTS_API_VERSION = "2022-12-01"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
_MAX_PAGES = 20


def _get(client: httpx.Client, provider: str, url: str, **kwargs: Any) -> dict:
    host = urlparse(url).netloc or url
    try:
        resp = client.get(url, **kwargs)
    except httpx.TimeoutException as exc:
        raise ProviderError(f"{provider}: {host} did not answer in time ({exc.__class__.__name__}). "
                            "Check the network/proxy and the base URL.", provider=provider) from exc
    except httpx.HTTPError as exc:
        raise ProviderError(f"{provider}: cannot reach {host} ({exc.__class__.__name__}: {exc}). "
                            "Check the network/proxy and the base URL.", provider=provider) from exc
    if resp.status_code in (401, 403):
        raise AuthError(f"{provider}: the API key was rejected by {host} (HTTP {resp.status_code}).",
                        provider=provider, status_code=resp.status_code, details={"body": resp.text[:500]})
    if resp.status_code == 404:
        raise ProviderError(f"{provider}: {url} was not found (HTTP 404) - check the base URL / endpoint.",
                            provider=provider, status_code=404)
    if resp.status_code == 429:
        raise QuotaError(f"{provider}: rate limit or quota exceeded while listing models (HTTP 429).",
                         provider=provider, status_code=429)
    if resp.status_code >= 400:
        raise ProviderError(f"{provider}: listing models failed with HTTP {resp.status_code}: {resp.text[:300]}",
                            provider=provider, status_code=resp.status_code)
    try:
        data = resp.json()
    except ValueError as exc:
        raise ProviderError(f"{provider}: {host} returned a non-JSON answer to the model listing.",
                            provider=provider) from exc
    if not isinstance(data, dict):
        raise ProviderError(f"{provider}: unexpected model-listing format from {host}.", provider=provider)
    return data


def _need_key(provider: str, api_key: str | None) -> str:
    if not api_key:
        raise AuthError(f"{provider}: an API key is required to list models.", provider=provider)
    return api_key


def _openai_like(provider: str, base: str, headers: dict[str, str], client: httpx.Client) -> list[dict]:
    data = _get(client, provider, base.rstrip("/") + "/models", headers=headers)
    out = []
    for m in data.get("data") or []:
        if not isinstance(m, dict) or not m.get("id"):
            continue
        row: dict[str, Any] = {"id": m["id"], "owned_by": m.get("owned_by")}
        # OpenRouter-style metadata (other gateways simply omit it)
        if isinstance(m.get("context_length"), int):
            row["context_tokens"] = m["context_length"]
        arch = m.get("architecture") or {}
        mods = arch.get("input_modalities") if isinstance(arch, dict) else None
        if isinstance(mods, list):
            row["vision"] = "image" in mods
        params = m.get("supported_parameters")
        if isinstance(params, list):
            row["structured_output"] = "structured_outputs" in params or "response_format" in params
        if m.get("name"):
            row["display_name"] = m["name"]
        out.append(row)
    return out


def list_remote_model_details(provider: str, api_key: str | None, base_url: str | None = None,
                              extra: dict | None = None, *, client: httpx.Client | None = None) -> list[dict]:
    """``[{id, context_tokens?, vision?, structured_output?, display_name?, ...}]`` from the provider."""
    extra = extra or {}
    own = client is None
    client = client or httpx.Client(timeout=TIMEOUT, follow_redirects=True)
    try:
        if provider == "openai":
            headers = {"Authorization": f"Bearer {_need_key(provider, api_key)}"}
            if extra.get("organization"):
                headers["OpenAI-Organization"] = str(extra["organization"])
            if extra.get("project"):
                headers["OpenAI-Project"] = str(extra["project"])
            return _openai_like(provider, base_url or OPENAI_BASE_URL, headers, client)

        if provider == "openai_compatible":
            if not base_url:
                raise AIError("openai_compatible: base_url is required (e.g. https://openrouter.ai/api/v1).",
                              provider=provider)
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            headers.update({str(k): str(v) for k, v in (extra.get("headers") or {}).items()})
            return _openai_like(provider, base_url, headers, client)

        if provider == "anthropic":
            headers = {"x-api-key": _need_key(provider, api_key), "anthropic-version": ANTHROPIC_VERSION}
            url = (base_url or ANTHROPIC_BASE_URL).rstrip("/") + "/v1/models"
            out: list[dict] = []
            params: dict[str, Any] = {"limit": 1000}
            for _ in range(_MAX_PAGES):
                data = _get(client, provider, url, headers=headers, params=params)
                for m in data.get("data") or []:
                    if not isinstance(m, dict) or not m.get("id"):
                        continue
                    caps = m.get("capabilities") if isinstance(m.get("capabilities"), dict) else {}

                    def supported(name: str, caps: dict = caps) -> bool | None:
                        node = caps.get(name)
                        return bool(node.get("supported")) if isinstance(node, dict) and "supported" in node else None

                    out.append({"id": m["id"], "display_name": m.get("display_name"),
                                "context_tokens": m.get("max_input_tokens"), "max_output_tokens": m.get("max_tokens"),
                                "vision": supported("image_input"), "structured_output": supported("structured_outputs"),
                                "created_at": m.get("created_at")})
                if not data.get("has_more") or not data.get("last_id"):
                    break
                params = {"limit": 1000, "after_id": data["last_id"]}
            return out

        if provider == "google":
            headers = {"x-goog-api-key": _need_key(provider, api_key)}
            url = (base_url or GOOGLE_BASE_URL).rstrip("/") + "/v1beta/models"
            out = []
            params = {"pageSize": 1000}
            for _ in range(_MAX_PAGES):
                data = _get(client, provider, url, headers=headers, params=params)
                for m in data.get("models") or []:
                    if not isinstance(m, dict) or not m.get("name"):
                        continue
                    methods = m.get("supportedGenerationMethods") or []
                    if methods and "generateContent" not in methods:
                        continue  # embeddings, AQA, … cannot answer prompts
                    out.append({"id": str(m["name"]).removeprefix("models/"), "display_name": m.get("displayName"),
                                "context_tokens": m.get("inputTokenLimit"),
                                "max_output_tokens": m.get("outputTokenLimit"),
                                "description": m.get("description")})
                token = data.get("nextPageToken")
                if not token:
                    break
                params = {"pageSize": 1000, "pageToken": token}
            return out

        if provider == "azure_openai":
            if not base_url:
                raise AIError("azure_openai: base_url (https://<resource>.openai.azure.com) is required.",
                              provider=provider)
            headers = {"api-key": _need_key(provider, api_key)}
            version = extra.get("deployments_api_version") or AZURE_DEPLOYMENTS_API_VERSION
            url = base_url.rstrip("/") + "/openai/deployments"
            data = _get(client, provider, url, headers=headers, params={"api-version": version})
            out = []
            for d in data.get("data") or []:
                if isinstance(d, dict) and d.get("id"):
                    out.append({"id": d["id"], "deployment": d["id"], "model": d.get("model"),
                                "status": d.get("status")})
            from .registry import register_azure_deployments

            register_azure_deployments({d["id"]: d["model"] for d in out if d.get("model")})
            return out

        raise AIError(f"unknown provider {provider!r}", provider=provider)
    finally:
        if own:
            client.close()


def list_remote_models(provider: str, api_key: str | None, base_url: str | None = None,
                       extra: dict | None = None, *, client: httpx.Client | None = None) -> list[str]:
    """Model IDs the provider offers to this key (Azure: deployment names), sorted."""
    details = list_remote_model_details(provider, api_key, base_url, extra, client=client)
    return sorted({d["id"] for d in details})


def available_models(provider: str, api_key: str | None, base_url: str | None = None, extra: dict | None = None,
                     *, policy=None, exams: dict[str, dict] | None = None,
                     client: httpx.Client | None = None) -> list[dict]:
    """Live models merged with the curated registry and evaluated against the workspace policy.

    Each row: registry fields + ``eligibility`` (model-level status, reasons, allowed tasks) +
    ``remote`` (what the provider reported). For Azure the policy evaluates the deployment's
    underlying model, and ``deployment`` tells the UI what to call."""
    from .policy import eligibility_table
    from .registry import load_registry
    from .store import all_latest_exams, load_policy

    if policy is None:
        policy = load_policy()
    if exams is None:
        exams = all_latest_exams()
    registry = load_registry()
    details = list_remote_model_details(provider, api_key, base_url, extra, client=client)
    specs, remote_by_key = [], {}
    for d in details:  # Azure: d["id"] is the deployment; the registry resolves the model behind it
        spec = registry.spec_for(provider, d["id"], remote_info=d)
        specs.append(spec)
        remote_by_key[spec.key] = d
    rows = eligibility_table(specs, policy, exams)
    for row in rows:
        row["remote"] = remote_by_key.get(f"{row['provider']}:{row['model_id']}")
        if provider == "azure_openai" and row["remote"]:
            row["deployment"] = row["remote"].get("deployment")
    return rows
