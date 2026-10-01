"""Provider adapters: exact request shapes per SDK (fake clients, no network) and SDK error mapping."""
from __future__ import annotations

import json
import subprocess
import sys
from types import SimpleNamespace as NS

import httpx2
import pytest

from ess.ai.engine import AIEngine, _http_error_from
from ess.ai.errors import AuthError, ModelDeclined
from ess.ai.policy import DEFAULT_POLICY
from ess.ai.testing import exam_record

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["category"],
          "properties": {"category": {"type": "string", "enum": ["bmu", "wce"]}}}
GOOD = {"category": "wce"}
GOOD_TEXT = json.dumps(GOOD)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def make(provider, model, **kwargs) -> AIEngine:
    sleeps: list[float] = []
    eng = AIEngine(provider, model, api_key="sk-test", policy=DEFAULT_POLICY, exam=exam_record(provider, model),
                   sleep=sleeps.append, **kwargs)
    eng.sleeps = sleeps  # type: ignore[attr-defined]
    return eng


class Recorder:
    """Callable that records kwargs and returns (or raises) scripted items."""

    def __init__(self, *items):
        self.items = list(items)
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        item = self.items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def http_response(status: int, headers: dict | None = None) -> httpx2.Response:
    return httpx2.Response(status, headers=headers or {}, request=httpx2.Request("POST", "https://api.example/v1"))


# ---------------------------------------------------------------- OpenAI Responses API

def openai_response(text=GOOD_TEXT, status="completed", reason=None, refusal=None, model="gpt-5-2025-08-07"):
    content = [NS(type="refusal", refusal=refusal)] if refusal else [NS(type="output_text", text=text)]
    return NS(output_text="" if refusal else text, output=[NS(type="message", content=content)], status=status,
              incomplete_details=NS(reason=reason) if reason else None,
              usage=NS(input_tokens=11, output_tokens=7), model=model)


def test_openai_responses_request_shape():
    eng = make("openai", "gpt-5")
    create = Recorder(openai_response())
    eng._adapter_for()._client = NS(responses=NS(create=create))
    assert eng.complete_json("SYSTEM RULES", "user text", SCHEMA, images=[PNG], task="extract_request",
                             effort="max") == GOOD
    kw = create.calls[0]
    assert kw["model"] == "gpt-5" and kw["store"] is False and "SYSTEM RULES" in kw["instructions"]
    fmt = kw["text"]["format"]
    assert fmt == {"type": "json_schema", "name": "ess_extract_request", "strict": True,
                   "schema": {**SCHEMA, "required": ["category"], "additionalProperties": False}}
    content = kw["input"][0]["content"]
    assert content[0] == {"type": "input_text", "text": "user text"}
    assert content[1]["type"] == "input_image" and content[1]["image_url"].startswith("data:image/png;base64,")
    assert "temperature" not in kw  # reasoning model
    assert kw["reasoning"] == {"effort": "high"} and kw["max_output_tokens"] == 4000 + 8000
    assert eng.usage["input_tokens"] == 11 and eng.usage["output_tokens"] == 7


def test_openai_responses_incomplete_and_refusal():
    eng = make("openai", "gpt-5")
    create = Recorder(openai_response(text='{"categ', status="incomplete", reason="max_output_tokens"),
                      openai_response())
    eng._adapter_for()._client = NS(responses=NS(create=create))
    assert eng.complete_json("s", "u", SCHEMA, task="classify_email") == GOOD
    assert create.calls[1]["max_output_tokens"] == 2 * 4000 + 8000
    eng2 = make("openai", "gpt-5")
    eng2._adapter_for()._client = NS(responses=NS(create=Recorder(openai_response(refusal="I can't help"))))
    with pytest.raises(ModelDeclined):
        eng2.complete_json("s", "u", SCHEMA, task="classify_email")


def test_openai_sdk_errors_are_retried_or_mapped():
    import openai

    eng = make("openai", "gpt-5")
    rate = openai.RateLimitError("slow down", response=http_response(429, {"retry-after": "2"}),
                                 body={"error": {"code": "rate_limit_exceeded"}})
    conn = openai.APIConnectionError(request=httpx2.Request("POST", "https://api.openai.com/v1/responses"))
    eng._adapter_for()._client = NS(responses=NS(create=Recorder(rate, conn, openai_response())))
    assert eng.complete_json("s", "u", SCHEMA, task="classify_email") == GOOD
    assert len(eng.sleeps) == 2 and eng.sleeps[0] >= 2  # Retry-After honoured
    eng2 = make("openai", "gpt-5")
    auth = openai.AuthenticationError("bad key", response=http_response(401), body=None)
    eng2._adapter_for()._client = NS(responses=NS(create=Recorder(auth)))
    with pytest.raises(AuthError):
        eng2.complete_json("s", "u", SCHEMA, task="classify_email")
    assert eng2.sleeps == []


# ---------------------------------------------------------------- Chat Completions (Azure / gateways)

def chat_response(text=GOOD_TEXT, model="gpt-4.1-2025-04-14", finish="stop", refusal=None):
    return NS(choices=[NS(message=NS(content=text, refusal=refusal), finish_reason=finish)],
              usage=NS(prompt_tokens=9, completion_tokens=4), model=model)


def test_azure_uses_the_deployment_and_strict_response_format():
    eng = make("azure_openai", "gpt-4.1", base_url="https://res.openai.azure.com",
               extra={"deployment": "dep-41", "api_version": "2024-10-21"})
    create = Recorder(chat_response())
    eng._adapter_for()._client = NS(chat=NS(completions=NS(create=create)))
    assert eng.complete_json("sys", "u", SCHEMA, task="classify_email", temperature=0) == GOOD
    kw = create.calls[0]
    assert kw["model"] == "dep-41" and kw["max_completion_tokens"] == 4000 and kw["temperature"] == 0
    assert kw["response_format"]["type"] == "json_schema" and kw["response_format"]["json_schema"]["strict"] is True
    assert kw["messages"][0]["role"] == "system" and kw["messages"][1]["content"] == "u"


def test_azure_deployment_serving_another_model_is_caught():
    eng = make("azure_openai", "gpt-5", base_url="https://res.openai.azure.com", extra={"deployment": "prod"})
    eng._adapter_for()._client = NS(chat=NS(completions=NS(create=Recorder(chat_response(model="gpt-4o-mini")))))
    from ess.ai.errors import RefusedByPolicy

    with pytest.raises(RefusedByPolicy, match="instead of"):
        eng.complete_json("s", "u", SCHEMA, task="classify_email")


def test_openai_compatible_gateway():
    eng = make("openai_compatible", "anthropic/claude-opus-5-5", base_url="https://openrouter.ai/api/v1",
               extra={"headers": {"X-Title": "ESS"}})
    create = Recorder(chat_response(model="anthropic/claude-opus-5-5"))
    eng._adapter_for()._client = NS(chat=NS(completions=NS(create=create)))
    assert eng.complete_json("s", "u", SCHEMA, images=[PNG], task="analyze_drawing") == GOOD
    kw = create.calls[0]
    assert kw["max_tokens"] == 4000 + 8000 and "max_completion_tokens" not in kw and "temperature" not in kw
    assert kw["messages"][1]["content"][1]["type"] == "image_url"


def test_chat_content_filter_is_a_decline():
    eng = make("azure_openai", "gpt-4.1", base_url="https://res.openai.azure.com")
    eng._adapter_for()._client = NS(chat=NS(completions=NS(create=Recorder(chat_response(text="", finish="content_filter")))))
    with pytest.raises(ModelDeclined):
        eng.complete_json("s", "u", SCHEMA, task="classify_email")


# ---------------------------------------------------------------- Anthropic Messages API

class FakeStream:
    def __init__(self, message):
        self.message = message

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self.message


def claude_message(text=GOOD_TEXT, stop="end_turn", model="claude-opus-5-5", details=None):
    return NS(content=[NS(type="thinking", thinking=""), NS(type="text", text=text)], stop_reason=stop,
              stop_details=details, model=model,
              usage=NS(input_tokens=20, output_tokens=8, cache_read_input_tokens=5, cache_creation_input_tokens=0))


def anthropic_client(*messages):
    rec = Recorder(*[FakeStream(m) if not isinstance(m, BaseException) else m for m in messages])
    return NS(messages=NS(stream=rec)), rec


def test_anthropic_structured_output_via_output_config():
    eng = make("anthropic", "claude-opus-5-5")
    client, rec = anthropic_client(claude_message())
    eng._adapter_for()._client = client
    assert eng.complete_json("sys", "u", SCHEMA, images=[PNG], task="analyze_drawing", effort="high") == GOOD
    kw = rec.calls[0]
    assert kw["output_config"] == {"format": {"type": "json_schema", "schema": {**SCHEMA}}, "effort": "high"}
    assert "thinking" not in kw and "temperature" not in kw and "tool_choice" not in kw
    assert kw["max_tokens"] == 4000 + 8000 and kw["model"] == "claude-opus-5-5"
    content = kw["messages"][0]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/png"
    assert content[-1] == {"type": "text", "text": "u"}
    assert eng.usage["input_tokens"] == 25


def test_anthropic_model_specific_parameters():
    eng = make("anthropic", "claude-opus-4-8")
    client, rec = anthropic_client(claude_message(model="claude-opus-4-8"))
    eng._adapter_for()._client = client
    eng.complete_json("s", "u", SCHEMA, task="classify_email", effort="low")
    assert rec.calls[0]["thinking"] == {"type": "adaptive"} and rec.calls[0]["output_config"]["effort"] == "low"
    haiku = make("anthropic", "claude-haiku-4-5")
    client, rec = anthropic_client(claude_message(model="claude-haiku-4-5-20251001"))
    haiku._adapter_for()._client = client
    haiku.complete_json("s", "u", SCHEMA, task="classify_email", effort="low")
    assert "effort" not in rec.calls[0]["output_config"] and rec.calls[0]["max_tokens"] == 4000


def test_anthropic_refusal_and_errors():
    import anthropic

    eng = make("anthropic", "claude-opus-5-5")
    client, _ = anthropic_client(claude_message(text="", stop="refusal", details=NS(category="cyber", explanation="no")))
    eng._adapter_for()._client = client
    with pytest.raises(ModelDeclined):
        eng.complete_json("s", "u", SCHEMA, task="classify_email")
    eng2 = make("anthropic", "claude-opus-5-5")
    overloaded = anthropic.InternalServerError("overloaded", response=http_response(529),
                                               body={"type": "error", "error": {"type": "overloaded_error"}})
    client, rec = anthropic_client(overloaded, claude_message())
    eng2._adapter_for()._client = client
    assert eng2.complete_json("s", "u", SCHEMA, task="classify_email") == GOOD and len(eng2.sleeps) == 1


# ---------------------------------------------------------------- Google Gemini

def gemini_response(text=GOOD_TEXT, finish="STOP", model="gemini-2.5-pro", block=None):
    return NS(text=text, candidates=[NS(finish_reason=NS(name=finish))], model_version=model,
              usage_metadata=NS(prompt_token_count=30, candidates_token_count=10, thoughts_token_count=5),
              prompt_feedback=NS(block_reason=block) if block else None)


def test_gemini_request_shape():
    eng = make("google", "gemini-2.5-pro")
    gen = Recorder(gemini_response())
    eng._adapter_for()._client = NS(models=NS(generate_content=gen))
    assert eng.complete_json("sys", "u", SCHEMA, images=[PNG], task="analyze_drawing", temperature=0) == GOOD
    kw = gen.calls[0]
    cfg = kw["config"]
    assert kw["model"] == "gemini-2.5-pro" and cfg.response_mime_type == "application/json"
    assert cfg.response_json_schema == {**SCHEMA} and cfg.temperature == 0 and "sys" in cfg.system_instruction
    parts = kw["contents"][0].parts
    assert parts[0].inline_data.mime_type == "image/png" and parts[-1].text == "u"
    assert eng.usage["output_tokens"] == 15


def test_gemini_specifics():
    g3 = make("google", "gemini-3-pro-preview")
    gen = Recorder(gemini_response(model="gemini-3-pro-preview"))
    g3._adapter_for()._client = NS(models=NS(generate_content=gen))
    g3.complete_json("s", "u", SCHEMA, task="classify_email", temperature=0)
    assert gen.calls[0]["config"].temperature is None  # Gemini 3: keep the default temperature
    blocked = make("google", "gemini-2.5-pro")
    blocked._adapter_for()._client = NS(models=NS(generate_content=Recorder(gemini_response(text="", block="SAFETY"))))
    with pytest.raises(ModelDeclined):
        blocked.complete_json("s", "u", SCHEMA, task="classify_email")


def test_google_sdk_error_mapping():
    from google.genai import errors

    quota = errors.ClientError(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Quota"}})
    http = _http_error_from(quota)
    assert http.status_code == 429 and http.code == "RESOURCE_EXHAUSTED"
    eng = make("google", "gemini-2.5-pro")
    eng._adapter_for()._client = NS(models=NS(generate_content=Recorder(quota, gemini_response())))
    assert eng.complete_json("s", "u", SCHEMA, task="classify_email") == GOOD and len(eng.sleeps) == 1


def test_error_normalisation_and_unknown_exceptions():
    import anthropic

    auth = anthropic.AuthenticationError("invalid x-api-key", response=http_response(401), body=None)
    assert _http_error_from(auth).status_code == 401
    assert _http_error_from(ValueError("bug")) is None
    eng = make("anthropic", "claude-opus-5-5")
    client, _ = anthropic_client(TypeError("unexpected keyword"))
    eng._adapter_for()._client = client
    from ess.ai.errors import ProviderError

    with pytest.raises(ProviderError, match="TypeError"):
        eng.complete_json("s", "u", SCHEMA, task="classify_email")


def test_sdks_are_imported_lazily():
    code = ("import sys, ess.ai.engine, ess.ai.tasks, ess.ai.qualification, ess.ai.rules, ess.ai.providers, "
            "ess.ai.external, ess.ai.registry, ess.ai.policy, ess.ai.guards; "
            "print([m for m in ('openai', 'anthropic', 'google.genai', 'PIL') if m in sys.modules])")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, cwd=".")
    assert out.stdout.strip() == "[]"
