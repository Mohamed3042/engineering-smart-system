"""Live model listing (mocked with respx): parsing, pagination, error messages, policy merge."""
from __future__ import annotations

import httpx
import pytest
import respx

from ess.ai.errors import AIError, AuthError, ProviderError, QuotaError
from ess.ai.policy import DEFAULT_POLICY
from ess.ai.providers import available_models, list_remote_model_details, list_remote_models
from ess.ai.testing import exam_record


@respx.mock
def test_openai_models():
    route = respx.get("https://api.openai.com/v1/models").mock(return_value=httpx.Response(200, json={
        "object": "list", "data": [{"id": "gpt-5", "owned_by": "openai"}, {"id": "gpt-5-mini", "owned_by": "openai"},
                                   {"id": "text-embedding-3-large", "owned_by": "openai"}, {"id": "gpt-5.5"}]}))
    assert list_remote_models("openai", "sk-1") == ["gpt-5", "gpt-5-mini", "gpt-5.5", "text-embedding-3-large"]
    assert route.calls.last.request.headers["authorization"] == "Bearer sk-1"


@respx.mock
def test_anthropic_models_with_pagination_and_capabilities():
    page1 = {"data": [{"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "max_input_tokens": 1_000_000,
                       "capabilities": {"image_input": {"supported": True},
                                        "structured_outputs": {"supported": True}}}],
             "has_more": True, "last_id": "claude-opus-5-5"}
    page2 = {"data": [{"id": "claude-haiku-4-5-20251001", "max_input_tokens": 200_000}], "has_more": False}
    respx.get("https://api.anthropic.com/v1/models").mock(side_effect=lambda request: httpx.Response(
        200, json=page2 if request.url.params.get("after_id") == "claude-opus-5-5" else page1))
    details = list_remote_model_details("anthropic", "sk-ant")
    assert [d["id"] for d in details] == ["claude-opus-5-5", "claude-haiku-4-5-20251001"]
    assert details[0]["context_tokens"] == 1_000_000 and details[0]["vision"] is True
    assert details[0]["structured_output"] is True
    request = respx.calls[0].request
    assert request.headers["x-api-key"] == "sk-ant" and request.headers["anthropic-version"] == "2023-06-01"


@respx.mock
def test_google_models_pagination_and_filter():
    page1 = {"models": [{"name": "models/gemini-2.5-pro", "inputTokenLimit": 1048576,
                         "supportedGenerationMethods": ["generateContent", "countTokens"]},
                        {"name": "models/gemini-embedding-001", "supportedGenerationMethods": ["embedContent"]}],
             "nextPageToken": "p2"}
    page2 = {"models": [{"name": "models/gemini-2.5-flash-lite", "supportedGenerationMethods": ["generateContent"]}]}
    respx.get("https://generativelanguage.googleapis.com/v1beta/models").mock(side_effect=lambda request: httpx.Response(
        200, json=page2 if request.url.params.get("pageToken") == "p2" else page1))
    assert list_remote_models("google", "g-key") == ["gemini-2.5-flash-lite", "gemini-2.5-pro"]
    assert len(respx.calls) == 2 and respx.calls[0].request.headers["x-goog-api-key"] == "g-key"


@respx.mock
def test_azure_deployments_carry_the_underlying_model():
    respx.get("https://res.openai.azure.com/openai/deployments").mock(return_value=httpx.Response(200, json={
        "data": [{"id": "prod-gpt5", "model": "gpt-5", "status": "succeeded"},
                 {"id": "cheap", "model": "gpt-4o-mini", "status": "succeeded"}]}))
    details = list_remote_model_details("azure_openai", "az-key", "https://res.openai.azure.com")
    assert {(d["deployment"], d["model"]) for d in details} == {("prod-gpt5", "gpt-5"), ("cheap", "gpt-4o-mini")}
    assert respx.calls[0].request.headers["api-key"] == "az-key"
    rows = available_models("azure_openai", "az-key", "https://res.openai.azure.com", policy=DEFAULT_POLICY, exams={})
    by_deployment = {r["model_id"]: r for r in rows}  # deployments are what the engine calls
    prod = by_deployment["prod-gpt5"]
    assert prod["canonical_id"] == "gpt-5" and prod["tier"] == "frontier" and prod["deployment"] == "prod-gpt5"
    assert prod["eligibility"]["status"] == "needs_evaluation"
    assert by_deployment["cheap"]["eligibility"]["status"] == "refused"  # gpt-4o-mini behind a friendly name
    from ess.ai import store
    assert store.load_azure_deployments()["prod-gpt5"] == "gpt-5"  # remembered for later engine runs


@respx.mock
def test_openai_compatible_gateway_metadata():
    respx.get("https://openrouter.ai/api/v1/models").mock(return_value=httpx.Response(200, json={"data": [
        {"id": "anthropic/claude-opus-5-5", "name": "Claude Opus 5.5", "context_length": 1000000,
         "architecture": {"input_modalities": ["text", "image"]}, "supported_parameters": ["structured_outputs"]},
        {"id": "deepseek/deepseek-v4", "context_length": 163840, "architecture": {"input_modalities": ["text"]},
         "supported_parameters": ["response_format"]},
        {"id": "openai/gpt-5:free", "context_length": 400000}]}))
    rows = available_models("openai_compatible", None, "https://openrouter.ai/api/v1", policy=DEFAULT_POLICY,
                            exams={"openai_compatible:deepseek/deepseek-v4": exam_record("openai_compatible",
                                                                                         "deepseek/deepseek-v4")})
    by_id = {r["model_id"]: r for r in rows}
    assert by_id["anthropic/claude-opus-5-5"]["tier"] == "frontier"
    deepseek = by_id["deepseek/deepseek-v4"]
    assert deepseek["capabilities"]["vision"] is False and deepseek["capabilities"]["context_tokens"] == 163840
    assert deepseek["eligibility"]["status"] == "eligible" and deepseek["eligibility"]["allowed_tasks"] == ["classify_email"]
    assert by_id["openai/gpt-5:free"]["eligibility"]["status"] == "refused"
    assert "authorization" not in respx.calls[0].request.headers  # no key: none sent


@respx.mock
@pytest.mark.parametrize("status, exc", [(401, AuthError), (403, AuthError), (429, QuotaError), (404, ProviderError),
                                         (500, ProviderError)])
def test_http_errors_are_clear(status, exc):
    respx.get("https://api.openai.com/v1/models").mock(return_value=httpx.Response(status, text="nope"))
    with pytest.raises(exc) as err:
        list_remote_models("openai", "sk")
    assert "openai" in str(err.value)


@respx.mock
def test_network_errors_and_bad_json():
    respx.get("https://api.anthropic.com/v1/models").mock(side_effect=httpx.ConnectError("blocked by proxy"))
    with pytest.raises(ProviderError, match="cannot reach api.anthropic.com"):
        list_remote_models("anthropic", "k")
    respx.get("https://api.openai.com/v1/models").mock(return_value=httpx.Response(200, text="<html>"))
    with pytest.raises(ProviderError, match="non-JSON"):
        list_remote_models("openai", "k")


def test_configuration_errors_need_no_network():
    with pytest.raises(AuthError):
        list_remote_models("openai", None)
    with pytest.raises(AIError, match="base_url"):
        list_remote_models("openai_compatible", "k")
    with pytest.raises(AIError, match="base_url"):
        list_remote_models("azure_openai", "k")
    with pytest.raises(AIError, match="unknown provider"):
        list_remote_models("unknown-provider", "k")
