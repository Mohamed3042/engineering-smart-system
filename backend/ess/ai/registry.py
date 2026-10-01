"""Model catalogue: curated entries (registry.yaml) plus deterministic rules for unknown IDs.

``load_registry()`` returns the curated catalogue; ``get_spec(provider, model_id)`` always returns
a :class:`ModelSpec` – the curated entry when we know the model, otherwise the result of
:func:`classify_unknown`, which never trusts a name it has not seen before:

* non-chat modalities (embedding, tts, whisper, transcribe, audio, realtime, image, dall-e,
  moderation, search-preview, computer-use, …), code-specialised and autonomous research models,
  moving aliases (``*-latest``), routers (``openrouter/auto``) and free/online proxy variants → **refused**
* mini | nano | lite | haiku-3 | small | tiny | instruct | ≤14B parameter sizes → **light**
* everything else → **standard** with ``needs_evaluation=True`` (capabilities unverified; the
  qualification exam decides).
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

PROVIDERS = ("openai", "anthropic", "google", "azure_openai", "openai_compatible")
TIERS = ("frontier", "standard", "light", "refused")
REGISTRY_PATH = Path(__file__).with_name("registry.yaml")

# Which curated catalogue a provider's model IDs come from.
_CATALOGUE_FOR = {"openai": "openai", "azure_openai": "openai", "anthropic": "anthropic", "google": "google"}
# "vendor/model" prefixes used by OpenAI-compatible gateways (OpenRouter, LiteLLM, …)
_VENDOR_PREFIX = {"openai": "openai", "anthropic": "anthropic", "google": "google", "gemini": "google",
                  "azure": "openai"}


@dataclass(frozen=True)
class Capabilities:
    structured_output: bool | None = None
    vision: bool | None = None
    tool_use: bool | None = None
    context_tokens: int | None = None
    pdf_input: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ModelSpec:
    provider: str
    model_id: str
    display_name: str
    family: str
    tier: str  # frontier | standard | light | refused
    capabilities: Capabilities
    deprecated: bool = False
    notes: str = ""
    aliases: tuple[str, ...] = ()
    source: str = "curated"  # curated | rules
    needs_evaluation: bool = False  # True when capabilities/quality are unverified (rules)
    rule: str | None = None  # the rule that classified an unknown ID
    canonical_id: str | None = None  # curated ID when model_id is an alias/snapshot/gateway name
    request: dict = field(default_factory=dict, compare=False, hash=False)  # engine hints

    @property
    def key(self) -> str:
        return f"{self.provider}:{self.model_id}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider, "model_id": self.model_id, "display_name": self.display_name,
            "family": self.family, "tier": self.tier, "capabilities": self.capabilities.to_dict(),
            "deprecated": self.deprecated, "notes": self.notes, "aliases": list(self.aliases),
            "source": self.source, "needs_evaluation": self.needs_evaluation, "rule": self.rule,
            "canonical_id": self.canonical_id or self.model_id,
        }


# --------------------------------------------------------------------------------------------
# Model-ID normalisation
# --------------------------------------------------------------------------------------------

_DATE_SUFFIXES = (
    re.compile(r"-\d{4}-\d{2}-\d{2}$"),          # OpenAI snapshots: gpt-5-2025-08-07
    re.compile(r"[-@]\d{8}$"),                    # Anthropic / Vertex: claude-haiku-4-5-20251001
    re.compile(r"-preview-\d{2}-\d{2,4}$"),       # Google previews: gemini-2.5-flash-preview-05-20
)


def split_variant(model_id: str) -> tuple[str, str | None]:
    """``"vendor/model:free"`` -> (``"vendor/model"``, ``"free"``)."""
    if ":" in model_id and "/" in model_id.split(":", 1)[0] or re.search(r":[a-z]+$", model_id):
        base, _, variant = model_id.rpartition(":")
        return base, variant or None
    return model_id, None


def base_model_id(model_id: str | None) -> str:
    """Lower-case model ID without provider prefix, routing variant and date/snapshot suffix."""
    if not model_id:
        return ""
    mid = model_id.strip().lower()
    for prefix in ("models/", "publishers/google/models/"):
        if mid.startswith(prefix):
            mid = mid[len(prefix):]
    mid, _ = split_variant(mid)
    if "/" in mid:
        vendor, _, rest = mid.partition("/")
        if vendor in _VENDOR_PREFIX:
            mid = rest
    mid = mid.replace("gpt-35", "gpt-3.5")
    for rx in _DATE_SUFFIXES:
        mid = rx.sub("", mid)
    return mid


# --------------------------------------------------------------------------------------------
# Rules for unknown IDs
# --------------------------------------------------------------------------------------------

_REFUSED_RULES: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("non_chat_modality", re.compile(
        r"embed|(^|[-_/.])tts([-_/.:]|$)|whisper|transcri|(^|[-_/.])audio|realtime|(^|[-_/.])image|dall-?e|"
        r"moderation|search-preview|(^|[-_/.])search([-_/.:]|$)|computer-use|imagen|(^|[-_/.])veo([-_/.:]|$)|"
        r"(^|[-_/.])sora|speech|rerank|native-audio|(^|[-_/.])live([-_/.:]|$)|(^|[-_/.])aqa$|(^|[-_/.])ocr([-_/.:]|$)"),
     "not a text/vision chat model (embedding, speech, image, realtime, search or computer-use)"),
    ("autonomous_research", re.compile(r"deep-research"),
     "autonomous research agent that browses the web on its own (would send mail content to third parties)"),
    ("code_specialised", re.compile(r"codex|coder|codestral"),
     "code-specialised model, not trained for business-document extraction"),
    ("legacy_completion", re.compile(r"(^|/)(text-)?(davinci|babbage|curie|ada)([-_]|$)|(^|/)gpt-3\.5|(^|/)gpt-35"),
     "obsolete completion-era model, prone to invent facts"),
    ("moving_alias", re.compile(r"-latest$|:latest$|(^|/)chatgpt-"),
     "moving alias: the model behind it changes without notice, so a qualification cannot hold - pick the pinned ID"),
    ("router", re.compile(r"(^|/)auto$|(^|/)router"),
     "router that picks a different model per request - the answering model cannot be qualified"),
    ("free_or_online_variant", re.compile(r":(free|online)$"),
     "free/online gateway variant (may log prompts for training or send content to web search)"),
    ("experimental", re.compile(r"(^|[-_/.])exp([-_/.:]|$)|experimental"),
     "experimental endpoint: may change or disappear and may use prompts for training"),
)
_OPENAI_REFUSED_RULES: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("legacy_instruct", re.compile(r"-instruct$"), "completion-only *-instruct model"),
)
_LIGHT_TOKENS = frozenset({"mini", "nano", "lite", "small", "tiny", "instruct"})
_PARAM_SIZE = re.compile(r"^(?:\d+x)?(?:e)?(\d+(?:\.\d+)?)b$")
LIGHT_MAX_PARAMS_B = 14.0


def _tokens(model_id: str) -> list[str]:
    return [t for t in re.split(r"[-_/.:@\s]+", model_id.lower()) if t]


def hard_refusal(model_id: str, provider: str | None = None) -> tuple[str, str] | None:
    """(rule, reason) when a model ID matches a refusal rule. Applied to curated entries too."""
    mid = (model_id or "").lower()
    rules = _REFUSED_RULES + (_OPENAI_REFUSED_RULES if provider in ("openai", "azure_openai") else ())
    for name, rx, reason in rules:
        if rx.search(mid):
            return name, reason
    return None


def light_rule(model_id: str) -> str | None:
    toks = _tokens(model_id)
    for t in toks:
        if t in _LIGHT_TOKENS:
            return f"name contains '{t}'"
    if "haiku" in toks and "3" in toks:
        return "Claude 3 Haiku class model"
    for t in toks:
        m = _PARAM_SIZE.match(t)
        if m and float(m.group(1)) <= LIGHT_MAX_PARAMS_B:
            return f"{t.upper()} parameters (small model)"
    return None


def _request_hints_for_unknown(provider: str, model_id: str) -> dict[str, Any]:
    mid = base_model_id(model_id)
    if provider in ("openai", "azure_openai"):
        reasoning = bool(re.match(r"^(o\d|gpt-[5-9])", mid))
        return {"sampling": not reasoning, "reasoning": reasoning, "headroom": 8000 if reasoning else 0}
    if provider == "anthropic":
        return {"sampling": False, "thinking": "omit", "effort": False, "headroom": 8000}
    if provider == "google":
        return {"sampling": False, "headroom": 8000}
    return {"sampling": True, "reasoning": False, "headroom": 4000}


def classify_unknown(provider: str, model_id: str, remote_info: dict | None = None) -> ModelSpec:
    """Classify a model ID that is not in the curated catalogue (see module docstring)."""
    info = remote_info or {}
    caps = Capabilities(
        structured_output=info.get("structured_output"),
        vision=info.get("vision"),
        tool_use=info.get("tool_use"),
        context_tokens=info.get("context_tokens"),
        pdf_input=info.get("pdf_input"),
    )
    common = dict(provider=provider, model_id=model_id, display_name=info.get("display_name") or model_id,
                  family="unknown", capabilities=caps, source="rules", needs_evaluation=True,
                  request=_request_hints_for_unknown(provider, model_id))
    refused = hard_refusal(model_id, provider)
    if refused:
        return ModelSpec(tier="refused", rule=refused[0], notes=f"Refused by rule: {refused[1]}.", **common)
    light = light_rule(model_id)
    if light:
        return ModelSpec(tier="light", rule="light_model", notes=f"Light tier: {light}.", **common)
    return ModelSpec(tier="standard", rule="unknown_model",
                     notes="Not in the curated catalogue: standard tier until it passes the qualification exam.",
                     **common)


# --------------------------------------------------------------------------------------------
# Azure deployments: arbitrary names that stand for an underlying model
# --------------------------------------------------------------------------------------------

_AZURE_DEPLOYMENTS: dict[str, str] = {}
_AZURE_LOADED = False


def register_azure_deployments(mapping: dict[str, str], *, persist: bool = True) -> None:
    """Remember which model each Azure deployment serves (filled by the deployments listing), so a
    deployment called e.g. "prod-chat" is evaluated as the model behind it."""
    clean = {str(k).lower(): str(v) for k, v in (mapping or {}).items() if k and v}
    _AZURE_DEPLOYMENTS.update(clean)
    if persist and clean:
        try:
            from .store import save_azure_deployments

            save_azure_deployments(dict(_AZURE_DEPLOYMENTS))
        except Exception:  # persistence is a convenience; the in-memory map still applies
            pass


def azure_underlying_model(deployment: str | None) -> str | None:
    global _AZURE_LOADED
    if not deployment:
        return None
    if not _AZURE_LOADED:
        _AZURE_LOADED = True
        try:
            from .store import load_azure_deployments

            for k, v in load_azure_deployments().items():
                _AZURE_DEPLOYMENTS.setdefault(str(k).lower(), str(v))
        except Exception:
            pass
    return _AZURE_DEPLOYMENTS.get(deployment.lower())


# --------------------------------------------------------------------------------------------
# Catalogue
# --------------------------------------------------------------------------------------------

class Registry:
    def __init__(self, specs: list[ModelSpec], meta: dict[str, Any] | None = None) -> None:
        self.meta = meta or {}
        self._specs = list(specs)
        self._index: dict[tuple[str, str], ModelSpec] = {}
        for spec in self._specs:  # exact IDs and aliases first …
            for name in (spec.model_id, *spec.aliases):
                key = (spec.provider, name.lower())
                if key in self._index:
                    raise ValueError(f"duplicate model id in registry: {spec.provider}:{name}")
                self._index[key] = spec
        for spec in self._specs:  # … then snapshot-free base IDs, never overriding an exact ID
            self._index.setdefault((spec.provider, base_model_id(spec.model_id)), spec)

    def all(self, provider: str | None = None) -> list[ModelSpec]:
        cat = _CATALOGUE_FOR.get(provider, provider) if provider else None
        return [s for s in self._specs if cat is None or s.provider == cat]

    def _lookup(self, catalogue: str, model_id: str) -> ModelSpec | None:
        mid = model_id.strip().lower()
        for candidate in (mid, base_model_id(mid)):
            spec = self._index.get((catalogue, candidate))
            if spec:
                return spec
        if catalogue == "anthropic" and "." in mid:  # gateway spelling claude-opus-4.5
            return self._lookup(catalogue, mid.replace(".", "-"))
        return None

    def get(self, provider: str, model_id: str) -> ModelSpec | None:
        """Curated spec for ``model_id`` on ``provider`` (aliases and snapshots resolved), else None.
        For Azure the model ID is the *underlying* model (e.g. ``gpt-5``), not the deployment."""
        if not model_id:
            return None
        catalogue = _CATALOGUE_FOR.get(provider)
        lookup_id = model_id
        if provider == "openai_compatible":
            base, _variant = split_variant(model_id.strip())
            vendor, sep, rest = base.partition("/")
            catalogue = _VENDOR_PREFIX.get(vendor.lower()) if sep else None
            lookup_id = rest if sep else base
        if not catalogue:
            return None
        spec = self._lookup(catalogue, lookup_id)
        if spec is None:
            return None
        if provider != spec.provider or model_id != spec.model_id:
            notes = spec.notes
            if provider != spec.provider:
                via = {"azure_openai": "Azure OpenAI", "openai_compatible": "an OpenAI-compatible gateway"}[provider]
                notes = f"{notes} Served via {via}.".strip()
            spec = replace(spec, provider=provider, model_id=model_id, canonical_id=spec.model_id, notes=notes)
        return spec

    def spec_for(self, provider: str, model_id: str, remote_info: dict | None = None) -> ModelSpec:
        if provider not in PROVIDERS:
            raise ValueError(f"unknown provider {provider!r}; expected one of {', '.join(PROVIDERS)}")
        spec = self.get(provider, model_id)
        if spec is None and provider == "azure_openai":
            underlying = azure_underlying_model(model_id)
            if underlying and underlying.lower() != model_id.lower():
                base = self.spec_for(provider, underlying, remote_info)
                return replace(base, model_id=model_id, canonical_id=base.canonical_id or base.model_id,
                               notes=f"{base.notes} Azure deployment '{model_id}' of {underlying}.".strip())
        if spec is not None and spec.tier != "refused" and hard_refusal(model_id, provider):
            spec = None  # e.g. "openai/gpt-5:free": the refusal rule wins over the curated base model
        return spec or classify_unknown(provider, model_id, remote_info)

    def served_model_expected(self, provider: str, model_id: str, extra: dict | None = None) -> str:
        """The model name the API should report for ``model_id`` (Azure: the deployment's model)."""
        if provider == "azure_openai":
            return str((extra or {}).get("model") or azure_underlying_model(model_id) or model_id)
        return model_id

    def same_model(self, provider: str, requested: str, served: str | None) -> bool:
        """True when ``served`` (what the API says answered) is the requested model or one of its
        snapshots/aliases."""
        if not served:
            return True
        if base_model_id(requested) == base_model_id(served):
            return True
        a, b = self.get(provider, requested), self.get(provider, served)
        return a is not None and b is not None and \
            (a.canonical_id or a.model_id).lower() == (b.canonical_id or b.model_id).lower()


def _build_spec(entry: dict[str, Any], defaults: dict[str, Any]) -> ModelSpec:
    provider = entry["provider"]
    if provider not in _CATALOGUE_FOR.values():
        raise ValueError(f"registry entry {entry.get('id')}: unknown provider {provider!r}")
    tier = entry.get("tier")
    if tier not in TIERS:
        raise ValueError(f"registry entry {entry.get('id')}: invalid tier {tier!r}")
    pdef = defaults.get(provider, {})
    caps = {**pdef.get("capabilities", {}), **(entry.get("capabilities") or {})}
    unknown_caps = set(caps) - set(Capabilities.__dataclass_fields__)
    if unknown_caps:
        raise ValueError(f"registry entry {entry['id']}: unknown capabilities {sorted(unknown_caps)}")
    request = {**pdef.get("request", {}), **(entry.get("request") or {})}
    return ModelSpec(
        provider=provider, model_id=entry["id"], display_name=entry.get("display_name") or entry["id"],
        family=entry.get("family") or "unknown", tier=tier, capabilities=Capabilities(**caps),
        deprecated=bool(entry.get("deprecated", False)), notes=(entry.get("notes") or "").strip(),
        aliases=tuple(entry.get("aliases") or ()), source="curated", needs_evaluation=False, request=request,
    )


def parse_registry(data: dict[str, Any]) -> Registry:
    defaults = data.get("defaults") or {}
    specs = [_build_spec(e, defaults) for e in data.get("models") or []]
    return Registry(specs, {k: v for k, v in data.items() if k not in ("models", "defaults")})


@lru_cache(maxsize=4)
def _load(path: str) -> Registry:
    with open(path, encoding="utf-8") as fh:
        return parse_registry(yaml.safe_load(fh) or {})


def load_registry(path: str | Path | None = None) -> Registry:
    """The curated catalogue (cached). ``path`` defaults to ``ess/ai/registry.yaml``."""
    return _load(str(path or REGISTRY_PATH))


def get_spec(provider: str, model_id: str, remote_info: dict | None = None) -> ModelSpec:
    """Curated spec, or the rule-based classification for an unknown ID."""
    return load_registry().spec_for(provider, model_id, remote_info)
