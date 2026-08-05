"""Amazon Bedrock's newer OpenAI-compatible "Mantle" endpoint, via the
`openai` package's own `AsyncBedrockOpenAI` client (`openai.lib.bedrock`,
bearer-token auth, not full AWS SigV4) — real, current Bedrock support, not
a workaround. Mirrors @berth/agents' providers/bedrock.ts."""

from __future__ import annotations

from openai.lib.bedrock import AsyncBedrockOpenAI

from .openai import _OpenAIProvider

DEFAULT_MODEL = "anthropic.claude-sonnet-5"


def create_bedrock_provider(
    *,
    api_key: str | None = None,
    aws_region: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> _OpenAIProvider:
    client = AsyncBedrockOpenAI(api_key=api_key, aws_region=aws_region, base_url=base_url)
    return _OpenAIProvider(client, model or DEFAULT_MODEL, name="bedrock")
