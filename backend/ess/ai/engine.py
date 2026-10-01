"""AIEngine: one provider-neutral way to get schema-valid JSON from an *approved* model.

```python
engine = AIEngine(provider="anthropic", model="claude-opus-5-5", api_key="sk-ant-...")
data = engine.complete_json(system, user, schema, images=[png_bytes], task="analyze_drawing")
```

Every call, in order:

1. **Policy gate** – ``evaluate_model`` (registry tier, capabilities, refusal rules, workspace
   policy, qualification exam) must say ``eligible`` for the task, otherwise
   :class:`RefusedByPolicy`. Models refused for every task cannot even be constructed. There is
   no bypass parameter; the only relaxation is the qualification exam itself, which may run a
   not-yet-qualified model on its own synthetic prompts (checked by hash) and nothing else.
2. **Request** – native structured output where the provider has it (OpenAI Responses
   ``text.format`` strict JSON schema, Anthropic ``output_config.format``, Gemini
   ``response_json_schema``, Chat Completions ``response_format``); JSON mode + schema in the
   prompt as fallback when an endpoint rejects the schema. Inputs are never truncated silently.
3. **Retries** – exponential back-off with jitter on 429/5xx/network errors (``Retry-After``
   honoured); quota/billing exhaustion, auth and unknown-model errors fail fast.
4. **Served-model check** – the model that answered must be the model that was qualified (no
   silent gateway re-routing, no unqualified snapshot swap).
5. **Validation** – JSON-schema validation; one automatic repair retry with the validation errors;
   :class:`InvalidOutput` if the second answer is still invalid.
6. **Usage accounting** – ``engine.usage`` (calls, input/output tokens, retries, repairs, failures).

Provider SDKs are imported lazily. Tests inject ``transport=`` (a callable taking a
:class:`ProviderRequest` and returning a :class:`ProviderResponse`) instead of calling any API.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import contextvars
import copy
import hashlib
import json
import logging
import random
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .errors import (AIError, AuthError, InputTooLarge, InvalidOutput, ModelDeclined, ModelNotFound,
                     ProviderError, QuotaError, RefusedByPolicy)
from .guards import validate_schema
from .policy import TASKS, EligibilityResult, Policy, evaluate_model
from .registry import PROVIDERS, load_registry

log = logging.getLogger(__name__)

DEFAULT_AZURE_API_VERSION = "2024-10-21"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGES = 20
MAX_OUTPUT_TOKENS = 64_000
IMAGE_TOKEN_ESTIMATE = 1_600
CONTEXT_SAFETY = 0.85
_USE_STORE = object()

OUTPUT_CONTRACT = (
    "OUTPUT CONTRACT: reply with exactly one JSON object that validates against the JSON schema of this "
    "request. No markdown fences and no text before or after the JSON. Use null for unknown values - "
    "never invent a value to satisfy the schema."
)

# Unsupported by one or more providers' strict structured-output modes. Still enforced locally.
_PROVIDER_SCHEMA_DROP = frozenset({
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern",
    "format", "minItems", "maxItems", "uniqueItems", "default", "examples", "$comment", "title", "multipleOf",
    "minProperties", "maxProperties", "$schema", "$id",
})
_SCHEMA_ERROR_RE = re.compile(r"json[_ ]?schema|response_format|output_config|response_schema|"
                              r"response_json_schema|structured output|schema", re.IGNORECASE)
_RETRYABLE_STATUS = frozenset({408, 409, 425, 500, 502, 503, 504, 520, 522, 524, 529})

# Exam mode: set only by ess.ai.qualification while it runs its synthetic cases.
_EXAM_CONTEXT: contextvars.ContextVar[dict | None] = contextvars.ContextVar("ess_ai_exam", default=None)


def _prompt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@contextlib.contextmanager
def exam_session(engine: "AIEngine", prompts: list[str]) -> Iterator[dict]:
    """Internal (used by ess.ai.qualification): let ``engine`` answer exactly these synthetic exam
    prompts even though it is not qualified yet. Hard refusals still apply; any other prompt goes
    through the normal policy gate."""
    ctx = {"engine": engine, "allowed": {_prompt_hash(p) for p in prompts}, "served_models": set()}
    token = _EXAM_CONTEXT.set(ctx)
    try:
        yield ctx
    finally:
        _EXAM_CONTEXT.reset(token)


@dataclass
class ProviderRequest:
    provider: str
    model: str  # what is sent as "model" (Azure: the deployment name)
    system: str
    user: str
    schema: dict | None  # provider-compatible schema; None in JSON mode
    schema_name: str
    images: list[tuple[bytes, str]] = field(default_factory=list)  # (bytes, mime)
    max_tokens: int = 4000
    temperature: float | None = None
    effort: str | None = None
    json_mode: bool = False
    hints: dict = field(default_factory=dict)


@dataclass
class ProviderResponse:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    finish_reason: str = "stop"  # stop | length | refusal | content_filter
    served_model: str | None = None
    refusal: str | None = None


class ProviderHTTPError(Exception):
    """Transport failure normalised from any SDK (fake transports raise it directly in tests)."""

    def __init__(self, status_code: int | None, message: str = "", *, code: str | None = None,
                 retry_after: float | None = None) -> None:
        super().__init__(f"HTTP {status_code}: {message}" if status_code else message)
        self.status_code = status_code
        self.message = message
        self.code = code
        self.retry_after = retry_after


class _SchemaRejected(Exception):
    pass


Transport = Callable[[ProviderRequest], ProviderResponse]


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------

def provider_schema(schema: dict) -> dict:
    """Copy of ``schema`` that strict provider modes accept: unsupported keywords removed, every
    object closed (``additionalProperties: false``) with all its properties required. Local
    validation still uses the full schema."""
    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out = {k: walk(v) for k, v in node.items() if k not in _PROVIDER_SCHEMA_DROP}
            if out.get("type") == "object" or (isinstance(out.get("type"), list) and "object" in out["type"]):
                props = out.get("properties")
                if isinstance(props, dict):
                    out["required"] = list(props.keys())
                out["additionalProperties"] = False
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(copy.deepcopy(schema))


def sniff_image_mime(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    raise ValueError("only PNG or JPEG images are accepted (render PDF pages to PNG first)")


def parse_json_object(text: str | None) -> tuple[dict | None, list[str]]:
    """Parse a JSON object from a model answer (tolerates code fences / stray text around it)."""
    if not text or not text.strip():
        return None, ["empty answer"]
    candidate = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", candidate, re.DOTALL | re.IGNORECASE)
    if fence:
        candidate = fence.group(1)
    try:
        value = json.loads(candidate)
    except ValueError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start < 0 or end <= start:
            return None, ["answer is not JSON"]
        try:
            value = json.loads(candidate[start:end + 1])
        except ValueError as exc:
            return None, [f"answer is not valid JSON: {exc}"]
    if not isinstance(value, dict):
        return None, ["answer is JSON but not an object"]
    return value, []


def _http_error_from(exc: BaseException) -> ProviderHTTPError | None:
    """Normalise an SDK exception (openai/anthropic/google-genai/httpx) to ProviderHTTPError."""
    status = getattr(exc, "status_code", None)
    if not isinstance(status, int):
        code_attr = getattr(exc, "code", None)
        status = code_attr if isinstance(code_attr, int) else None
    name = type(exc).__name__
    message = getattr(exc, "message", None) or str(exc)
    err_code = None
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        inner = body.get("error") if isinstance(body.get("error"), dict) else body
        err_code = inner.get("code") or inner.get("type")
    if err_code is None and isinstance(getattr(exc, "status", None), str):
        err_code = getattr(exc, "status")  # google: RESOURCE_EXHAUSTED, PERMISSION_DENIED, …
    retry_after = None
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if headers is not None:
        try:
            ra = headers.get("retry-after")
            retry_after = float(ra) if ra is not None else None
        except (TypeError, ValueError):
            retry_after = None
    if status is None:
        if not any(k in name for k in ("Connection", "Connect", "Timeout", "Network", "RemoteProtocol",
                                       "ReadError", "WriteError", "PoolTimeout")):
            return None
    return ProviderHTTPError(status, str(message)[:1000], code=str(err_code) if err_code else None,
                             retry_after=retry_after)


# --------------------------------------------------------------------------------------------
# Provider adapters (SDK imports are lazy)
# --------------------------------------------------------------------------------------------

class _Adapter:
    def __init__(self, engine: "AIEngine") -> None:
        self.engine = engine
        self._client: Any = None

    def send(self, req: ProviderRequest) -> ProviderResponse:
        try:
            return self._send(req)
        except (AIError, ProviderHTTPError):
            raise
        except ImportError as exc:
            raise AIError(f"the SDK for {self.engine.provider} is not installed ({exc})",
                          provider=self.engine.provider, model=self.engine.model) from exc
        except Exception as exc:  # SDK errors -> one normalised type
            http = _http_error_from(exc)
            if http is not None:
                raise http from exc
            raise ProviderError(f"{self.engine.provider} request failed: {type(exc).__name__}: {exc}",
                                provider=self.engine.provider, model=self.engine.model) from exc

    def _send(self, req: ProviderRequest) -> ProviderResponse:  # pragma: no cover - abstract
        raise NotImplementedError

    @staticmethod
    def data_url(data: bytes, mime: str) -> str:
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


class _OpenAIResponsesAdapter(_Adapter):
    """OpenAI Responses API with strict JSON schema; ``store=False`` keeps mail data off OpenAI."""

    def client(self):
        if self._client is None:
            import openai

            e = self.engine
            self._client = openai.OpenAI(api_key=e._api_key, base_url=e.base_url or None, max_retries=0,
                                         timeout=e.timeout, organization=e.extra.get("organization"),
                                         project=e.extra.get("project"))
        return self._client

    def _send(self, req: ProviderRequest) -> ProviderResponse:
        content: list[dict] = [{"type": "input_text", "text": req.user}]
        content += [{"type": "input_image", "image_url": self.data_url(d, m), "detail": "high"} for d, m in req.images]
        fmt = ({"type": "json_object"} if req.json_mode else
               {"type": "json_schema", "name": req.schema_name, "schema": req.schema, "strict": True})
        kwargs: dict[str, Any] = {"model": req.model, "instructions": req.system,
                                  "input": [{"role": "user", "content": content}],
                                  "max_output_tokens": req.max_tokens, "text": {"format": fmt}, "store": False}
        if req.temperature is not None:
            kwargs["temperature"] = req.temperature
        if req.effort and req.hints.get("reasoning"):
            kwargs["reasoning"] = {"effort": {"xhigh": "high", "max": "high"}.get(req.effort, req.effort)}
        resp = self.client().responses.create(**kwargs)
        refusal = None
        for item in getattr(resp, "output", None) or []:
            for part in getattr(item, "content", None) or []:
                if getattr(part, "type", None) == "refusal":
                    refusal = getattr(part, "refusal", None) or "refused"
        finish = "stop"
        if refusal:
            finish = "refusal"
        elif getattr(resp, "status", None) == "incomplete":
            reason = getattr(getattr(resp, "incomplete_details", None), "reason", None)
            finish = "content_filter" if reason == "content_filter" else "length"
        usage = getattr(resp, "usage", None)
        return ProviderResponse(text=getattr(resp, "output_text", "") or "",
                                input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
                                output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
                                finish_reason=finish, served_model=getattr(resp, "model", None), refusal=refusal)


class _ChatCompletionsAdapter(_Adapter):
    """Chat Completions: Azure OpenAI deployments, OpenAI-compatible gateways, or OpenAI (api=chat)."""

    def client(self):
        if self._client is None:
            import openai

            e = self.engine
            headers = {str(k): str(v) for k, v in (e.extra.get("headers") or {}).items()} or None
            if e.provider == "azure_openai":
                self._client = openai.AzureOpenAI(
                    api_key=e._api_key, azure_endpoint=e.base_url,
                    api_version=e.extra.get("api_version") or DEFAULT_AZURE_API_VERSION,
                    max_retries=0, timeout=e.timeout, default_headers=headers)
            else:  # local gateways (vLLM, Ollama, LM Studio) often need no key at all
                key = e._api_key or ("not-required" if e.provider == "openai_compatible" else None)
                self._client = openai.OpenAI(api_key=key, base_url=e.base_url or None,
                                             max_retries=0, timeout=e.timeout, default_headers=headers)
        return self._client

    def _send(self, req: ProviderRequest) -> ProviderResponse:
        e = self.engine
        if req.images:
            user: Any = [{"type": "text", "text": req.user}] + [
                {"type": "image_url", "image_url": {"url": self.data_url(d, m), "detail": "high"}}
                for d, m in req.images]
        else:
            user = req.user
        kwargs: dict[str, Any] = {"model": req.model,
                                  "messages": [{"role": "system", "content": req.system},
                                               {"role": "user", "content": user}]}
        kwargs["response_format"] = ({"type": "json_object"} if req.json_mode else
                                     {"type": "json_schema", "json_schema": {"name": req.schema_name,
                                                                             "schema": req.schema, "strict": True}})
        token_param = e.extra.get("max_tokens_param") or (
            "max_tokens" if e.provider == "openai_compatible" else "max_completion_tokens")
        kwargs[token_param] = req.max_tokens
        if req.temperature is not None:
            kwargs["temperature"] = req.temperature
        if req.effort and req.hints.get("reasoning"):
            kwargs["reasoning_effort"] = {"xhigh": "high", "max": "high"}.get(req.effort, req.effort)
        resp = self.client().chat.completions.create(**kwargs)
        choice = resp.choices[0] if getattr(resp, "choices", None) else None
        message = getattr(choice, "message", None)
        refusal = getattr(message, "refusal", None)
        reason = getattr(choice, "finish_reason", None) or "stop"
        finish = "refusal" if refusal else {"length": "length", "content_filter": "content_filter"}.get(reason, "stop")
        usage = getattr(resp, "usage", None)
        return ProviderResponse(text=getattr(message, "content", None) or "",
                                input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
                                output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
                                finish_reason=finish, served_model=getattr(resp, "model", None), refusal=refusal)


class _AnthropicAdapter(_Adapter):
    """Anthropic Messages API, structured output via ``output_config.format`` (forced tool use is
    rejected by current models). Streaming + ``get_final_message`` avoids HTTP timeouts on long
    outputs. Server-side model fallbacks are deliberately NOT enabled: the answering model must be
    the qualified one."""

    def client(self):
        if self._client is None:
            import anthropic

            e = self.engine
            self._client = anthropic.Anthropic(api_key=e._api_key, base_url=e.base_url or None, max_retries=0,
                                               timeout=e.timeout)
        return self._client

    def _send(self, req: ProviderRequest) -> ProviderResponse:
        content: list[dict] = [{"type": "image", "source": {"type": "base64", "media_type": m,
                                                            "data": base64.b64encode(d).decode("ascii")}}
                               for d, m in req.images]
        content.append({"type": "text", "text": req.user})
        kwargs: dict[str, Any] = {"model": req.model, "max_tokens": req.max_tokens, "system": req.system,
                                  "messages": [{"role": "user", "content": content}]}
        output_config: dict[str, Any] = {}
        if not req.json_mode:
            output_config["format"] = {"type": "json_schema", "schema": req.schema}
        if req.effort and req.hints.get("effort"):
            output_config["effort"] = req.effort
        if output_config:
            kwargs["output_config"] = output_config
        if req.hints.get("thinking") == "adaptive":
            kwargs["thinking"] = {"type": "adaptive"}
        with self.client().messages.stream(**kwargs) as stream:
            msg = stream.get_final_message()
        text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text")
        stop = getattr(msg, "stop_reason", None)
        refusal = None
        if stop == "refusal":
            details = getattr(msg, "stop_details", None)
            refusal = getattr(details, "explanation", None) or getattr(details, "category", None) or "refused"
        finish = {"max_tokens": "length", "refusal": "refusal"}.get(stop or "", "stop")
        usage = getattr(msg, "usage", None)
        tokens_in = sum(int(getattr(usage, k, 0) or 0) for k in
                        ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        return ProviderResponse(text=text, input_tokens=tokens_in,
                                output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
                                finish_reason=finish, served_model=getattr(msg, "model", None), refusal=refusal)


class _GoogleAdapter(_Adapter):
    """Gemini via google-genai with ``response_json_schema``."""

    def client(self):
        if self._client is None:
            from google import genai
            from google.genai import types

            e = self.engine
            http = types.HttpOptions(base_url=e.base_url, timeout=int(e.timeout * 1000)) if e.base_url else \
                types.HttpOptions(timeout=int(e.timeout * 1000))
            if e.extra.get("vertexai"):
                self._client = genai.Client(vertexai=True, project=e.extra.get("project"),
                                            location=e.extra.get("location"), http_options=http)
            else:
                self._client = genai.Client(api_key=e._api_key, http_options=http)
        return self._client

    def _send(self, req: ProviderRequest) -> ProviderResponse:
        from google.genai import types

        parts = [types.Part.from_bytes(data=d, mime_type=m) for d, m in req.images]
        parts.append(types.Part.from_text(text=req.user))
        cfg: dict[str, Any] = {"system_instruction": req.system, "max_output_tokens": req.max_tokens,
                               "response_mime_type": "application/json"}
        if not req.json_mode:
            cfg["response_json_schema"] = req.schema
        if req.temperature is not None:
            cfg["temperature"] = req.temperature
        resp = self.client().models.generate_content(
            model=req.model, contents=[types.Content(role="user", parts=parts)],
            config=types.GenerateContentConfig(**cfg))
        feedback = getattr(resp, "prompt_feedback", None)
        block = getattr(feedback, "block_reason", None)
        if block:
            return ProviderResponse(text="", finish_reason="content_filter", refusal=str(block),
                                    served_model=getattr(resp, "model_version", None))
        finish = "stop"
        cands = getattr(resp, "candidates", None) or []
        if cands:
            fr = getattr(cands[0], "finish_reason", None)
            name = getattr(fr, "name", str(fr or "")).upper()
            if name == "MAX_TOKENS":
                finish = "length"
            elif name in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION",
                          "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"):
                finish = "content_filter"
        try:
            text = resp.text or ""
        except Exception:  # noqa: BLE001 - SDK raises when no text part exists
            text = ""
        um = getattr(resp, "usage_metadata", None)
        out_tokens = int(getattr(um, "candidates_token_count", 0) or 0) + int(getattr(um, "thoughts_token_count", 0) or 0)
        return ProviderResponse(text=text, input_tokens=int(getattr(um, "prompt_token_count", 0) or 0),
                                output_tokens=out_tokens, finish_reason=finish,
                                served_model=getattr(resp, "model_version", None))


# --------------------------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------------------------

class AIEngine:
    def __init__(self, provider: str, model: str, api_key: str | None = None, base_url: str | None = None,
                 extra: dict | None = None, *, policy: Policy | None | object = _USE_STORE,
                 exam: dict | None | object = _USE_STORE, transport: Transport | None = None,
                 max_retries: int = 4, timeout: float = 300.0, sleep: Callable[[float], None] = time.sleep) -> None:
        if provider not in PROVIDERS:
            raise ValueError(f"unknown provider {provider!r}; expected one of {', '.join(PROVIDERS)}")
        if not model or not str(model).strip():
            raise ValueError("model is required")
        self.provider = provider
        self.model = str(model).strip()
        self._api_key = api_key
        self.base_url = base_url
        self.extra = dict(extra or {})
        self.max_retries = int(self.extra.get("max_retries", max_retries))
        self.timeout = float(self.extra.get("timeout", timeout))
        self._policy_arg = policy
        self._exam_arg = exam
        self._transport = transport
        self._sleep = sleep
        self._lock = threading.Lock()
        self.usage: dict[str, int] = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "retries": 0,
                                      "repairs": 0, "failures": 0}
        self.spec = load_registry().spec_for(provider, self.model)
        self._native_schema = True
        self._adapter: _Adapter | None = None
        if transport is None:
            if provider in ("azure_openai", "openai_compatible") and not base_url:
                raise ValueError(f"{provider} needs base_url "
                                 f"({'https://<resource>.openai.azure.com' if provider == 'azure_openai' else 'the gateway URL'})")
        result = self.eligibility()
        if result.status == "refused":
            raise RefusedByPolicy(
                f"{provider}:{self.model} is refused by the AI policy: {'; '.join(result.reasons)}",
                reasons=result.reasons, eligibility=result.to_dict(), provider=provider, model=self.model)

    # ---------------------------------------------------------------- policy
    @property
    def policy(self) -> Policy:
        if isinstance(self._policy_arg, Policy):
            return self._policy_arg
        if self._policy_arg is None:
            from .policy import DEFAULT_POLICY

            return DEFAULT_POLICY
        from .store import load_policy

        return load_policy()

    @property
    def exam(self) -> dict | None:
        if self._exam_arg is _USE_STORE:
            from .store import latest_exam

            return latest_exam(self.provider, self.model)
        return self._exam_arg  # type: ignore[return-value]

    def set_exam(self, exam: dict | None) -> None:
        """Pin the exam record this engine uses (instead of reading the local store)."""
        self._exam_arg = exam

    def eligibility(self, task: str | None = None) -> EligibilityResult:
        return evaluate_model(self.spec, self.policy, self.exam, task)

    def _in_exam(self, user_text: str) -> dict | None:
        ctx = _EXAM_CONTEXT.get()
        if ctx is not None and ctx.get("engine") is self and _prompt_hash(user_text) in ctx["allowed"]:
            return ctx
        return None

    def _enforce_policy(self, task: str | None, user_text: str, has_images: bool) -> None:
        if self._in_exam(user_text) is not None:
            res = evaluate_model(self.spec, self.policy, None, None)
            if res.status == "refused":
                raise RefusedByPolicy(f"{self.provider}:{self.model} is refused: {'; '.join(res.reasons)}",
                                      reasons=res.reasons, eligibility=res.to_dict(),
                                      provider=self.provider, model=self.model)
            if has_images and self.spec.capabilities.vision is False:
                raise RefusedByPolicy(f"{self.model} cannot read images", reasons=["no vision capability"],
                                      provider=self.provider, model=self.model)
            return
        checks = [task or "unspecified"]
        if has_images and self.spec.capabilities.vision is not True and "analyze_drawing" not in checks:
            checks.append("analyze_drawing")  # images need proven vision
        for t in checks:
            res = evaluate_model(self.spec, self.policy, self.exam, t)
            if res.status != "eligible":
                raise RefusedByPolicy(
                    f"{self.provider}:{self.model} may not run '{t}' ({res.status}): {'; '.join(res.reasons)}",
                    reasons=res.reasons, eligibility=res.to_dict(), provider=self.provider, model=self.model)

    # ---------------------------------------------------------------- description
    def describe(self) -> dict[str, Any]:
        res = self.eligibility()
        out = {
            "provider": self.provider, "model": self.model, "base_url": self.base_url,
            "api_key_set": bool(self._api_key), **{k: v for k, v in self.spec.to_dict().items()
                                                   if k not in ("provider", "model_id")},
            "structured_output_mode": "native" if self._native_schema else "json_mode",
            "eligibility": res.to_dict(), "usage": dict(self.usage),
        }
        if self.provider == "azure_openai":
            out["deployment"] = self.extra.get("deployment") or self.model
            out["api_version"] = self.extra.get("api_version") or DEFAULT_AZURE_API_VERSION
        return out

    # ---------------------------------------------------------------- main entry point
    def complete_json(self, system: str, user: str | list[dict], schema: dict, *,
                      images: list[bytes] | None = None, max_tokens: int = 4000, temperature: float = 0,
                      task: str | None = None, effort: str | None = None) -> dict:
        """Schema-validated JSON from the model. Raises RefusedByPolicy, AuthError, QuotaError,
        ModelNotFound, ModelDeclined, InputTooLarge, InvalidOutput or ProviderError."""
        user_text, raw_images = self._normalize_user(user, images)
        prepared = self._prepare_images(raw_images)
        self._enforce_policy(task, user_text, bool(prepared))
        if not isinstance(schema, dict) or schema.get("type") != "object":
            raise ValueError("schema must be a JSON-schema object (type: object)")
        validate_schema({}, schema)  # raises jsonschema.SchemaError early for a broken schema
        self._check_input_size(system, user_text, len(prepared))
        pschema = provider_schema(schema)
        name = re.sub(r"[^A-Za-z0-9_-]", "_", f"ess_{task or 'output'}")[:64]

        text, data, errors, finish = self._attempt(system, user_text, schema, pschema, name, prepared,
                                                   max_tokens, temperature, effort)
        if not errors and data is not None:
            return data
        with self._lock:
            self.usage["repairs"] += 1
        repair_user = self._repair_prompt(user_text, text, errors)
        mt = min(max_tokens * 2, MAX_OUTPUT_TOKENS) if finish == "length" else max_tokens
        text2, data2, errors2, _ = self._attempt(system, repair_user, schema, pschema, name, prepared,
                                                 mt, temperature, effort)
        if not errors2 and data2 is not None:
            return data2
        with self._lock:
            self.usage["failures"] += 1
        raise InvalidOutput(
            f"{self.provider}:{self.model} returned output that does not match the schema, even after a repair "
            f"retry: {errors2[0] if errors2 else 'unknown error'}",
            errors=errors2, raw=(text2 or "")[:4000], provider=self.provider, model=self.model)

    async def acomplete_json(self, *args: Any, **kwargs: Any) -> dict:
        """Async wrapper (runs the blocking call in a worker thread; context variables propagate)."""
        return await asyncio.to_thread(self.complete_json, *args, **kwargs)

    # ---------------------------------------------------------------- internals
    @staticmethod
    def _normalize_user(user: str | list[dict], images: list[bytes] | None) -> tuple[str, list[bytes]]:
        imgs = list(images or [])
        if isinstance(user, str):
            return user, imgs
        texts: list[str] = []
        for part in user or []:
            if not isinstance(part, dict):
                texts.append(str(part))
            elif part.get("type") == "image" and isinstance(part.get("data"), (bytes, bytearray)):
                imgs.append(bytes(part["data"]))
            elif part.get("text") is not None:
                texts.append(str(part["text"]))
        return "\n\n".join(texts), imgs

    @staticmethod
    def _prepare_images(images: list[bytes]) -> list[tuple[bytes, str]]:
        if len(images) > MAX_IMAGES:
            raise ValueError(f"at most {MAX_IMAGES} images per request")
        out = []
        for img in images:
            if not isinstance(img, (bytes, bytearray)):
                raise ValueError("images must be bytes (PNG or JPEG)")
            if len(img) > MAX_IMAGE_BYTES:
                raise ValueError(f"image of {len(img) // 1024} KB exceeds {MAX_IMAGE_BYTES // 1024 // 1024} MB; "
                                 "render the page at a lower DPI")
            out.append((bytes(img), sniff_image_mime(bytes(img))))
        return out

    def _check_input_size(self, system: str, user: str, n_images: int) -> None:
        context = self.spec.capabilities.context_tokens or 128_000
        # conservative estimate: ~3 chars per token (Arabic tokenises denser than English)
        estimate = (len(system) + len(user)) // 3 + n_images * IMAGE_TOKEN_ESTIMATE
        if estimate > context * CONTEXT_SAFETY:
            raise InputTooLarge(
                f"input of ~{estimate:,} tokens does not fit {self.model} (context {context:,}); split the document "
                "into parts - inputs are never truncated silently", provider=self.provider, model=self.model,
                details={"estimated_tokens": estimate, "context_tokens": context})

    def _hints(self) -> dict:
        return dict(self.spec.request or {})

    def _system_prompt(self, system: str, schema: dict, json_mode: bool) -> str:
        parts = [system.rstrip(), OUTPUT_CONTRACT]
        if json_mode:
            parts.append("JSON SCHEMA:\n" + json.dumps(schema, ensure_ascii=False, separators=(",", ":")))
        return "\n\n".join(parts)

    @staticmethod
    def _repair_prompt(user_text: str, previous: str | None, errors: list[str]) -> str:
        listed = "\n".join(f"- {e}" for e in errors[:25])
        return (f"{user_text}\n\n=== CORRECTION REQUIRED ===\nYour previous answer was rejected by the validator:\n"
                f"{listed}\nPrevious answer (for reference, do not repeat its mistakes):\n{(previous or '')[:12000]}\n"
                "Return the complete corrected JSON object now. Keep every rule: verbatim quotes, null when "
                "unknown, no prices.")

    def _api_model(self) -> str:
        if self.provider == "azure_openai":
            return str(self.extra.get("deployment") or self.model)
        return self.model

    def _adapter_for(self) -> _Adapter:
        if self._adapter is None:
            if self.provider == "openai" and self.extra.get("api") != "chat":
                self._adapter = _OpenAIResponsesAdapter(self)
            elif self.provider in ("openai", "azure_openai", "openai_compatible"):
                self._adapter = _ChatCompletionsAdapter(self)
            elif self.provider == "anthropic":
                self._adapter = _AnthropicAdapter(self)
            else:
                self._adapter = _GoogleAdapter(self)
        return self._adapter

    def _send(self, req: ProviderRequest) -> ProviderResponse:
        if self._transport is not None:
            return self._transport(req)
        return self._adapter_for().send(req)

    def _build_request(self, system: str, user: str, schema: dict, pschema: dict, name: str,
                       images: list[tuple[bytes, str]], max_tokens: int, temperature: float | None,
                       effort: str | None) -> ProviderRequest:
        hints = self._hints()
        json_mode = not self._native_schema
        headroom = int(hints.get("headroom") or 0)
        return ProviderRequest(
            provider=self.provider, model=self._api_model(), system=self._system_prompt(system, schema, json_mode),
            user=user, schema=None if json_mode else pschema, schema_name=name, images=images,
            max_tokens=min(int(max_tokens) + headroom, MAX_OUTPUT_TOKENS),
            temperature=temperature if hints.get("sampling") and temperature is not None else None,
            effort=effort or self.extra.get("effort"), json_mode=json_mode, hints=hints)

    def _attempt(self, system: str, user: str, schema: dict, pschema: dict, name: str,
                 images: list[tuple[bytes, str]], max_tokens: int, temperature: float | None,
                 effort: str | None) -> tuple[str, dict | None, list[str], str]:
        req = self._build_request(system, user, schema, pschema, name, images, max_tokens, temperature, effort)
        try:
            resp = self._call(req)
        except _SchemaRejected:
            log.warning("%s:%s rejected the native JSON schema; falling back to JSON mode", self.provider, self.model)
            self._native_schema = False
            req = self._build_request(system, user, schema, pschema, name, images, max_tokens, temperature, effort)
            resp = self._call(req)
        self._check_served(resp.served_model)
        if resp.finish_reason in ("refusal", "content_filter"):
            with self._lock:
                self.usage["failures"] += 1
            raise ModelDeclined(f"{self.provider}:{self.model} declined to answer ({resp.finish_reason}): "
                                f"{resp.refusal or 'no details'}", provider=self.provider, model=self.model,
                                details={"finish_reason": resp.finish_reason, "refusal": resp.refusal})
        data, errors = parse_json_object(resp.text)
        if data is not None:
            errors = validate_schema(data, schema)
        if resp.finish_reason == "length" and errors:
            errors = ["output truncated: the token limit was reached before the JSON was complete"] + errors
        return resp.text, data, errors, resp.finish_reason

    def _classify_error(self, exc: ProviderHTTPError) -> tuple[AIError, bool, bool]:
        """(error to raise, retryable, schema_rejected)."""
        s, msg = exc.status_code, exc.message or str(exc)
        low, code = msg.lower(), (exc.code or "").lower()
        ctx = dict(provider=self.provider, model=self.model, status_code=s)
        if s is None:
            return ProviderError(f"cannot reach {self.provider}: {msg}", **ctx), True, False
        if s in (401, 403) or code in ("unauthenticated", "permission_denied", "authentication_error"):
            return AuthError(f"{self.provider} rejected the credentials (HTTP {s}): {msg}", **ctx), False, False
        if s == 404:
            return ModelNotFound(f"{self.provider} does not offer '{self._api_model()}' to this account: {msg}",
                                 **ctx), False, False
        if s == 429:
            if code in ("insufficient_quota", "billing_hard_limit_reached") or "exceeded your current quota" in low \
                    or "billing" in low:
                return QuotaError(f"{self.provider} quota/billing exhausted: {msg}", **ctx), False, False
            return QuotaError(f"{self.provider} rate limit still exceeded after {self.max_retries} retries: {msg}",
                              **ctx), True, False
        if s == 413:
            return InputTooLarge(f"request too large for {self.provider}: {msg}", **ctx), False, False
        if s in _RETRYABLE_STATUS or s >= 500:
            return ProviderError(f"{self.provider} server error (HTTP {s}) after retries: {msg}", **ctx), True, False
        if s in (400, 422):
            if ("context" in low and ("length" in low or "window" in low or "limit" in low)) or "too long" in low \
                    or "maximum context" in low or "too many tokens" in low:
                return InputTooLarge(f"input too long for {self.model}: {msg}", **ctx), False, False
            if "model" in low and any(k in low for k in ("not found", "does not exist", "unknown model",
                                                          "not supported", "invalid model")):
                return ModelNotFound(f"{self.provider} rejected model '{self._api_model()}': {msg}", **ctx), False, False
            if _SCHEMA_ERROR_RE.search(low):
                return ProviderError(f"{self.provider} rejected the JSON schema: {msg}", **ctx), False, True
        return ProviderError(f"{self.provider} request failed (HTTP {s}): {msg}", **ctx), False, False

    def _backoff(self, attempt: int, retry_after: float | None) -> float:
        delay = min(30.0, 1.0 * (2 ** attempt)) * (0.75 + random.random() * 0.5)
        if retry_after:
            delay = max(delay, min(float(retry_after), 60.0))
        return delay

    def _call(self, req: ProviderRequest) -> ProviderResponse:
        attempt = 0
        while True:
            try:
                resp = self._send(req)
            except ProviderHTTPError as exc:
                err, retryable, schema_rejected = self._classify_error(exc)
                if schema_rejected and not req.json_mode:
                    raise _SchemaRejected() from exc
                if retryable and attempt < self.max_retries:
                    delay = self._backoff(attempt, exc.retry_after)
                    attempt += 1
                    with self._lock:
                        self.usage["retries"] += 1
                    log.info("%s:%s HTTP %s, retry %d/%d in %.1fs", self.provider, self.model, exc.status_code,
                             attempt, self.max_retries, delay)
                    self._sleep(delay)
                    continue
                with self._lock:
                    self.usage["failures"] += 1
                raise err from exc
            except AIError:
                with self._lock:
                    self.usage["failures"] += 1
                raise
            with self._lock:
                self.usage["calls"] += 1
                self.usage["input_tokens"] += int(resp.input_tokens or 0)
                self.usage["output_tokens"] += int(resp.output_tokens or 0)
            return resp

    def _check_served(self, served: str | None) -> None:
        if not served:
            return
        expected = self.model
        if not load_registry().same_model(self.provider, expected, served):
            raise RefusedByPolicy(
                f"{self.provider} answered with '{served}' instead of '{expected}'; an answer from a model that "
                "was not qualified is discarded", reasons=[f"served model {served} differs from {expected}"],
                provider=self.provider, model=self.model)
        ctx = _EXAM_CONTEXT.get()
        if ctx is not None and ctx.get("engine") is self:
            ctx["served_models"].add(served)
            return
        exam = self.exam
        seen = exam.get("served_models") if isinstance(exam, dict) else None
        if seen and served not in seen:
            raise RefusedByPolicy(
                f"the provider now serves '{served}' for '{expected}', not the snapshot that passed the exam "
                f"({', '.join(seen)}); re-run the qualification exam", reasons=["model snapshot changed"],
                provider=self.provider, model=self.model)
