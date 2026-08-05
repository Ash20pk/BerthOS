"""Thin adapter over the `anthropic` package's Messages API tool-use loop.
One built-in LLMProvider implementation, proving the interface isn't secretly
hardcoded to one vendor — Agent/Crew never reference this module. Mirrors
@berth/agents' providers/anthropic.ts, including chat_stream()/usage."""

from __future__ import annotations

import json
import os
from typing import Any, Callable

from anthropic import AsyncAnthropic

from ..types import AgentMessage, LLMTurn, Tool, ToolCall, Usage

DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_MAX_TOKENS = 4096


def _to_anthropic_messages(messages: list[AgentMessage]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "user":
            result.append({"role": "user", "content": message.text or ""})
        elif message.role == "tool":
            if message.tool_result is None:
                raise ValueError("AgentMessage with role 'tool' is missing tool_result")
            result.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.tool_result.id,
                            "content": json.dumps(message.tool_result.output),
                        }
                    ],
                }
            )
        else:  # role == "assistant"
            content: list[dict[str, Any]] = []
            if message.text:
                content.append({"type": "text", "text": message.text})
            for call in message.tool_calls or []:
                content.append({"type": "tool_use", "id": call.id, "name": call.name, "input": call.input})
            result.append({"role": "assistant", "content": content})
    return result


class _AnthropicProvider:
    name = "anthropic"

    def __init__(self, client: AsyncAnthropic, model: str, max_tokens: int) -> None:
        self._client = client
        self._model = model
        self._max_tokens = max_tokens

    async def chat(self, *, system: str | None, messages: list[AgentMessage], tools: list[Tool]) -> LLMTurn:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "messages": _to_anthropic_messages(messages),
            "tools": [{"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in tools],
        }
        if system is not None:
            kwargs["system"] = system

        response = await self._client.messages.create(**kwargs)

        text_blocks = [block for block in response.content if block.type == "text"]
        tool_use_blocks = [block for block in response.content if block.type == "tool_use"]

        return LLMTurn(
            text="\n".join(block.text for block in text_blocks) or None,
            tool_calls=[ToolCall(id=block.id, name=block.name, input=block.input) for block in tool_use_blocks],
            stop=len(tool_use_blocks) == 0,
            usage=Usage(input_tokens=response.usage.input_tokens, output_tokens=response.usage.output_tokens),
        )

    async def chat_stream(
        self,
        *,
        system: str | None,
        messages: list[AgentMessage],
        tools: list[Tool],
        on_text: Callable[[str], None],
    ) -> LLMTurn:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "messages": _to_anthropic_messages(messages),
            "tools": [{"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in tools],
        }
        if system is not None:
            kwargs["system"] = system

        async with self._client.messages.stream(**kwargs) as stream:
            async for text_delta in stream.text_stream:
                on_text(text_delta)
            response = await stream.get_final_message()

        text_blocks = [block for block in response.content if block.type == "text"]
        tool_use_blocks = [block for block in response.content if block.type == "tool_use"]

        return LLMTurn(
            text="\n".join(block.text for block in text_blocks) or None,
            tool_calls=[ToolCall(id=block.id, name=block.name, input=block.input) for block in tool_use_blocks],
            stop=len(tool_use_blocks) == 0,
            usage=Usage(input_tokens=response.usage.input_tokens, output_tokens=response.usage.output_tokens),
        )


def create_anthropic_provider(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    max_tokens: int | None = None,
    max_retries: int | None = None,
) -> _AnthropicProvider:
    client_kwargs: dict[str, Any] = {"api_key": api_key or os.environ.get("ANTHROPIC_API_KEY")}
    if base_url is not None:
        client_kwargs["base_url"] = base_url
    if max_retries is not None:
        client_kwargs["max_retries"] = max_retries

    client = AsyncAnthropic(**client_kwargs)
    return _AnthropicProvider(client, model or DEFAULT_MODEL, max_tokens or DEFAULT_MAX_TOKENS)
