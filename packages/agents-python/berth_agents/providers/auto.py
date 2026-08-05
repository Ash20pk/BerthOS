"""Mirrors @berth/agents' providers/auto.ts: env-key auto-detection and a
plain-data provider config, so a caller doesn't have to know which
create_x_provider() function to call."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from ..types import LLMProvider
from .anthropic import create_anthropic_provider
from .google import create_google_provider
from .ollama import create_ollama_provider
from .openai import create_openai_provider


def detect_llm_provider() -> LLMProvider:
    """Picks whichever LLMProvider has a real API key sitting in the
    environment, checked in the order listed in this repo's own
    docs/README. Azure OpenAI/Bedrock/Ollama aren't auto-detected — each
    needs more than an API key (a deployment name, an AWS region, a local
    server address) to construct correctly, so those stay explicit."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return create_anthropic_provider()
    if os.environ.get("OPENAI_API_KEY"):
        return create_openai_provider()
    if os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"):
        return create_google_provider()
    raise RuntimeError(
        "no LLM provider could be auto-detected — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY/GEMINI_API_KEY, "
        "or pass llm=create_anthropic_provider() / create_openai_provider() / create_google_provider() / "
        "create_azure_openai_provider() / create_bedrock_provider() / create_ollama_provider() / your own LLMProvider explicitly"
    )


@dataclass
class LLMProviderConfig:
    """A plain-data alternative to constructing a provider yourself. Azure
    OpenAI and Bedrock aren't representable in this shape (a deployment
    name, an AWS region) — use create_azure_openai_provider()/
    create_bedrock_provider() directly for those."""

    provider: Literal["anthropic", "openai", "google", "ollama"]
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None


def resolve_llm_provider(llm: LLMProvider | LLMProviderConfig | None) -> LLMProvider:
    """A real LLMProvider passes through untouched, a config object is
    built into one, and None auto-detects."""
    if llm is None:
        return detect_llm_provider()
    if isinstance(llm, LLMProviderConfig):
        if llm.provider == "anthropic":
            return create_anthropic_provider(api_key=llm.api_key, base_url=llm.base_url, model=llm.model)
        if llm.provider == "openai":
            return create_openai_provider(api_key=llm.api_key, base_url=llm.base_url, model=llm.model)
        if llm.provider == "google":
            return create_google_provider(api_key=llm.api_key, model=llm.model)
        if llm.provider == "ollama":
            return create_ollama_provider(base_url=llm.base_url, model=llm.model)
        raise ValueError(f'llm.provider must be one of "anthropic"/"openai"/"google"/"ollama" — got {llm.provider!r}')
    return llm
