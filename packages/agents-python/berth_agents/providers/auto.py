"""Mirrors @berth/agents' providers/auto.ts: env-key auto-detection and a
plain-data provider config, so a caller doesn't have to know which
create_x_provider() function to call."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from ..types import LLMProvider
from .anthropic import create_anthropic_provider
from .openai import create_openai_provider


def detect_llm_provider() -> LLMProvider:
    """Picks whichever LLMProvider has a real API key sitting in the
    environment. Anthropic is checked first only because it's listed first
    in this repo's own docs/README, not because of any functional
    preference between the two."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return create_anthropic_provider()
    if os.environ.get("OPENAI_API_KEY"):
        return create_openai_provider()
    raise RuntimeError(
        "no LLM provider could be auto-detected — set ANTHROPIC_API_KEY or OPENAI_API_KEY, "
        "or pass llm=create_anthropic_provider() / create_openai_provider() / your own LLMProvider explicitly"
    )


@dataclass
class LLMProviderConfig:
    """A plain-data alternative to constructing a provider yourself."""

    provider: Literal["anthropic", "openai"]
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
        raise ValueError(f'llm.provider must be "anthropic" or "openai" — got {llm.provider!r}')
    return llm
