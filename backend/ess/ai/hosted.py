"""Named hosted services keep keys, model exams and endpoints separate."""
HOSTED = {
    "groq": {
        "label": "Groq · free plan available", "base_url": "https://api.groq.com/openai/v1",
        "signup_url": "https://console.groq.com/keys", "max_tokens_param": "max_completion_tokens",
        "hint": "Start with openai/gpt-oss-120b. This text model can sort mail after qualification; engineering tasks keep their stricter model requirements.",
    },
    "mistral": {
        "label": "Mistral · free Experiment plan", "base_url": "https://api.mistral.ai/v1",
        "signup_url": "https://console.mistral.ai/api-keys", "max_tokens_param": "max_tokens",
        "hint": "Choose a pinned model ID. Before using company documents, disable API data training in your Mistral account.",
    },
    "sambanova": {
        "label": "SambaNova · free plan available", "base_url": "https://api.sambanova.ai/v1",
        "signup_url": "https://cloud.sambanova.ai/", "max_tokens_param": "max_tokens",
        "hint": "A backup provider with small daily free limits. Available models and limits depend on your account.",
    },
}


def endpoint(provider: str, base_url: str | None = None) -> str | None:
    """Named keys only go to their official host; custom endpoints use a separate connection."""
    if provider not in HOSTED:
        return base_url
    expected = HOSTED[provider]["base_url"]
    if base_url and base_url.rstrip("/") != expected:
        raise ValueError(f"{provider} uses {expected}. Use a separate OpenAI-compatible connection for another endpoint.")
    return expected
