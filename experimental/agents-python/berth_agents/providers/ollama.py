"""`create_openai_provider(base_url="http://127.0.0.1:11434/v1")` already
works — Ollama speaks the OpenAI Chat Completions API — so this is pure
ergonomics: a real local-model default and a name that says what it is.
Mirrors @berth/agents' providers/ollama.ts."""

from __future__ import annotations

from openai import AsyncOpenAI

from .openai import _OpenAIProvider

DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
DEFAULT_MODEL = "llama3.1"


def create_ollama_provider(*, base_url: str | None = None, model: str | None = None) -> _OpenAIProvider:
    # Ollama's own server ignores authentication entirely, but the openai
    # client still requires a non-empty api_key string to construct —
    # "ollama" is the placeholder the Ollama project's own docs suggest.
    client = AsyncOpenAI(api_key="ollama", base_url=base_url or DEFAULT_BASE_URL)
    return _OpenAIProvider(client, model or DEFAULT_MODEL, name="ollama")
