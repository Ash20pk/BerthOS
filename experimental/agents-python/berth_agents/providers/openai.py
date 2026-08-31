"""Thin adapter over the `openai` package's Chat Completions tool-calling
loop. The second of two built-in LLMProvider implementations — proves the
Tool/LLMProvider seam is real (Agent/Crew never reference this module or
Anthropic's), not secretly single-vendor. Mirrors @berth/agents'
providers/openai.ts."""

from __future__ import annotations

import json
import os
from typing import Any, Callable

from openai import AsyncOpenAI

from ..types import AgentMessage, LLMTurn, Tool, ToolCall, Usage

DEFAULT_MODEL = "gpt-4o"


def _to_openai_messages(messages: list[AgentMessage]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "user":
            result.append({"role": "user", "content": message.text or ""})
        elif message.role == "tool":
            if message.tool_result is None:
                raise ValueError("AgentMessage with role 'tool' is missing tool_result")
            result.append(
                {
                    "role": "tool",
                    "tool_call_id": message.tool_result.id,
                    "content": json.dumps(message.tool_result.output),
                }
            )
        else:  # role == "assistant"
            entry: dict[str, Any] = {"role": "assistant", "content": message.text or ""}
            if message.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": json.dumps(call.input)},
                    }
                    for call in message.tool_calls
                ]
            result.append(entry)
    return result


def _tools_param(tools: list[Tool]) -> dict[str, Any]:
    """The OpenAI API rejects `tools: []` outright — the key has to be absent,
    not empty. That matters beyond tidiness: create_llm_guardrail() and
    llm_judge() both call chat() with no tools at all, so every LLM-judge
    feature was broken against OpenAI, Azure, Bedrock and Ollama (all four
    share the implementation below).

    This is REMEDIATION 3.1, which was fixed in `providers/openai.ts` and
    stayed live here — the Python adapters had no tests, which is 3.7, and
    this is what that absence was costing. Returned as a dict to be splatted
    into the request so the key simply doesn't exist rather than being set to
    None, exactly as `toolsParam()` does in the TypeScript adapter."""
    if not tools:
        return {}
    return {
        "tools": [
            {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}
            for t in tools
        ]
    }


class _OpenAIProvider:
    """The actual chat()/chat_stream() implementation, shared by every
    provider built on an `openai`-shaped async client — create_openai_provider()
    below, and create_azure_openai_provider()/create_bedrock_provider()/
    create_ollama_provider() (azure_openai.py/bedrock.py/ollama.py), which
    differ only in how the client itself is constructed, never in the
    message-mapping or tool-calling logic here."""

    def __init__(self, client: AsyncOpenAI, model: str, name: str = "openai") -> None:
        self._client = client
        self._model = model
        self.name = name

    async def chat(self, *, system: str | None, messages: list[AgentMessage], tools: list[Tool]) -> LLMTurn:
        chat_messages = _to_openai_messages(messages)
        if system is not None:
            chat_messages = [{"role": "system", "content": system}, *chat_messages]

        response = await self._client.chat.completions.create(
            model=self._model,
            messages=chat_messages,
            **_tools_param(tools),
        )

        choice = response.choices[0]
        message = choice.message
        tool_calls = [
            ToolCall(
                id=call.id,
                name=call.function.name,
                input=json.loads(call.function.arguments) if call.function.arguments else {},
            )
            for call in (message.tool_calls or [])
        ]

        return LLMTurn(
            text=message.content or None,
            tool_calls=tool_calls,
            stop=len(tool_calls) == 0,
            usage=Usage(input_tokens=response.usage.prompt_tokens, output_tokens=response.usage.completion_tokens)
            if response.usage
            else None,
        )

    async def chat_stream(
        self,
        *,
        system: str | None,
        messages: list[AgentMessage],
        tools: list[Tool],
        on_text: Callable[[str], None],
    ) -> LLMTurn:
        chat_messages = _to_openai_messages(messages)
        if system is not None:
            chat_messages = [{"role": "system", "content": system}, *chat_messages]

        stream = await self._client.chat.completions.create(
            model=self._model,
            messages=chat_messages,
            **_tools_param(tools),
            stream=True,
            # Without this, a streamed response never carries a usage field
            # at all (unlike the non-streamed chat() call, where it's always
            # present) — the one extra flag OpenAI's API needs to include it
            # on the final chunk.
            stream_options={"include_usage": True},
        )

        text = ""
        # Tool-call deltas arrive fragmented across chunks, keyed by their
        # position in the response (not by id, which only shows up on the
        # first fragment) — accumulate each field until the stream ends.
        tool_calls_by_index: dict[int, dict[str, Any]] = {}
        usage: Usage | None = None

        async for chunk in stream:
            if not chunk.choices:
                # The final usage-only chunk (stream_options.include_usage)
                # carries an empty choices list.
                if chunk.usage:
                    usage = Usage(input_tokens=chunk.usage.prompt_tokens, output_tokens=chunk.usage.completion_tokens)
                continue

            delta = chunk.choices[0].delta
            if delta.content:
                text += delta.content
                on_text(delta.content)
            for tool_call_delta in delta.tool_calls or []:
                acc = tool_calls_by_index.setdefault(tool_call_delta.index, {"arguments": ""})
                if tool_call_delta.id:
                    acc["id"] = tool_call_delta.id
                if tool_call_delta.function and tool_call_delta.function.name:
                    acc["name"] = acc.get("name", "") + tool_call_delta.function.name
                if tool_call_delta.function and tool_call_delta.function.arguments:
                    acc["arguments"] += tool_call_delta.function.arguments
            if chunk.usage:
                usage = Usage(input_tokens=chunk.usage.prompt_tokens, output_tokens=chunk.usage.completion_tokens)

        tool_calls = [
            ToolCall(id=acc.get("id", ""), name=acc.get("name", ""), input=json.loads(acc["arguments"]) if acc["arguments"] else {})
            for acc in tool_calls_by_index.values()
        ]

        return LLMTurn(text=text or None, tool_calls=tool_calls, stop=len(tool_calls) == 0, usage=usage)


def create_openai_provider(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    max_retries: int | None = None,
) -> _OpenAIProvider:
    client_kwargs: dict[str, Any] = {"api_key": api_key or os.environ.get("OPENAI_API_KEY")}
    if base_url is not None:
        client_kwargs["base_url"] = base_url
    if max_retries is not None:
        client_kwargs["max_retries"] = max_retries

    client = AsyncOpenAI(**client_kwargs)
    return _OpenAIProvider(client, model or DEFAULT_MODEL)
