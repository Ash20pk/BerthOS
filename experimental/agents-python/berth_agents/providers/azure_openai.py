"""Azure OpenAI isn't just OpenAI with a different base_url — it
authenticates with an `api-key` header (or Entra ID) instead of `Authorization:
Bearer`, routes by a deployment name in the URL path rather than `model` in
the request body, and requires an `api-version` query param on every
request. `openai`'s own `AsyncAzureOpenAI` client already handles all three;
this just reuses the same chat()/chat_stream() implementation every
OpenAI-shaped provider shares. Mirrors @berth/agents' providers/azure-openai.ts."""

from __future__ import annotations

import os

from openai import AsyncAzureOpenAI

from .openai import _OpenAIProvider

DEFAULT_API_VERSION = "2024-10-21"


def create_azure_openai_provider(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    deployment: str | None = None,
    api_version: str | None = None,
) -> _OpenAIProvider:
    resolved_deployment = deployment or os.environ.get("AZURE_OPENAI_DEPLOYMENT")
    if not resolved_deployment:
        raise ValueError("create_azure_openai_provider() needs deployment= (or AZURE_OPENAI_DEPLOYMENT) — Azure routes by deployment name, not model")

    client = AsyncAzureOpenAI(
        api_key=api_key or os.environ.get("AZURE_OPENAI_API_KEY"),
        azure_endpoint=endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT"),
        azure_deployment=resolved_deployment,
        api_version=api_version or os.environ.get("AZURE_OPENAI_API_VERSION") or DEFAULT_API_VERSION,
    )
    # Azure's chat.completions.create() ignores `model` in favor of the
    # client's configured deployment, but the field is still required by the
    # SDK's own types — the deployment name is a reasonable value to send.
    return _OpenAIProvider(client, resolved_deployment, name="azure-openai")
