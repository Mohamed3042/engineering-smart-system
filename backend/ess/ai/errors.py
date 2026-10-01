"""Error types raised by the AI layer.

Every error carries the provider/model it concerns so the UI, the REST API and the MCP server can
show one clear message ("Anthropic rejected the API key", "gpt-4o-mini is refused by policy: ...").
"""
from __future__ import annotations

from typing import Any


class AIError(Exception):
    """Base class for every failure in ``ess.ai``."""

    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        provider: str | None = None,
        model: str | None = None,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.provider = provider
        self.model = model
        self.status_code = status_code
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": type(self).__name__,
            "message": self.message,
            "provider": self.provider,
            "model": self.model,
            "status_code": self.status_code,
            "details": self.details,
        }


class AuthError(AIError):
    """Missing, invalid or insufficiently privileged credentials (HTTP 401/403)."""


class QuotaError(AIError):
    """Rate limit still exceeded after back-off, or the account's quota/billing is exhausted."""


class ModelNotFound(AIError):
    """The provider does not know the model (or the deployment) on this account."""


class RefusedByPolicy(AIError):
    """The workspace policy forbids this model for this task. There is no bypass."""

    def __init__(self, message: str, *, reasons: list[str] | None = None, eligibility: dict | None = None,
                 **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.reasons = list(reasons or [])
        self.eligibility = eligibility or {}
        self.details.setdefault("reasons", self.reasons)


class InvalidOutput(AIError):
    """The model's answer was not valid JSON for the schema, even after the automatic repair retry."""

    def __init__(self, message: str, *, errors: list[str] | None = None, raw: str | None = None,
                 **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.errors = list(errors or [])
        self.raw = raw
        self.details.setdefault("errors", self.errors[:25])


class ModelDeclined(AIError):
    """The model or the provider's safety system declined to answer (refusal / content filter)."""


class ProviderError(AIError):
    """Upstream failure: network unreachable, 5xx after retries, or an unexpected 4xx."""


class InputTooLarge(AIError):
    """The request would not fit the model's context window. Inputs are never truncated silently."""


class PolicyError(AIError, ValueError):
    """An attempt to configure a policy that weakens the hard floor (or an unreadable policy)."""
