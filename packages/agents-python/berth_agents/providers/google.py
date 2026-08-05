"""Thin adapter over `google-genai`'s `generate_content`/`generate_content_stream`
— the third built-in LLMProvider, and the first non-Anthropic-shaped,
non-OpenAI-shaped one: Gemini's Content/Part/FunctionCall/FunctionResponse
types are genuinely different from either. Mirrors @berth/agents'
providers/google.ts field-for-field (snake_case instead of camelCase)."""

from __future__ import annotations

import os
from typing import Any, Callable

from google import genai
from google.genai import types

from ..types import AgentMessage, LLMTurn, Tool, ToolCall, Usage

DEFAULT_MODEL = "gemini-2.5-flash"


def _to_function_response_object(output: Any) -> dict[str, Any]:
    """Gemini's FunctionResponse.response must be a JSON object, unlike
    Anthropic/OpenAI's tool_result content, which accepts any JSON value —
    a bare string/number/list tool output gets wrapped under a "result" key
    rather than sent as-is."""
    if isinstance(output, dict):
        return output
    return {"result": output}


def _to_google_contents(messages: list[AgentMessage]) -> list[types.Content]:
    contents: list[types.Content] = []
    for message in messages:
        if message.role == "user":
            contents.append(types.Content(role="user", parts=[types.Part(text=message.text or "")]))
        elif message.role == "tool":
            result = message.tool_result
            if result is None:
                raise ValueError("AgentMessage with role 'tool' is missing tool_result")
            contents.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            function_response=types.FunctionResponse(
                                id=result.id, name=result.name, response=_to_function_response_object(result.output)
                            )
                        )
                    ],
                )
            )
        else:  # role == "assistant"
            parts: list[types.Part] = []
            if message.text:
                parts.append(types.Part(text=message.text))
            for call in message.tool_calls or []:
                parts.append(types.Part(function_call=types.FunctionCall(id=call.id, name=call.name, args=call.input)))
            contents.append(types.Content(role="model", parts=parts))
    return contents


def _to_function_declarations(tools: list[Tool]) -> list[types.FunctionDeclaration]:
    # Gemini accepts plain JSON Schema directly via parameters_json_schema
    # (mutually exclusive with its own typed `parameters: Schema` field) —
    # no translation needed, same as Anthropic/OpenAI's input_schema passthrough.
    return [types.FunctionDeclaration(name=t.name, description=t.description, parameters_json_schema=t.input_schema) for t in tools]


def _config_for(system: str | None, tools: list[Tool]) -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        system_instruction=system,
        tools=[types.Tool(function_declarations=_to_function_declarations(tools))] if tools else None,
    )


def _usage_from(usage_metadata: Any) -> Usage | None:
    if usage_metadata is None:
        return None
    return Usage(input_tokens=usage_metadata.prompt_token_count or 0, output_tokens=usage_metadata.candidates_token_count or 0)


def _tool_calls_from(function_calls: list[Any] | None) -> list[ToolCall]:
    return [
        ToolCall(id=call.id or f"call_{i}", name=call.name or "", input=call.args or {})
        for i, call in enumerate(function_calls or [])
    ]


class _GoogleProvider:
    name = "google"

    def __init__(self, client: genai.Client, model: str) -> None:
        self._client = client
        self._model = model

    async def chat(self, *, system: str | None, messages: list[AgentMessage], tools: list[Tool]) -> LLMTurn:
        response = await self._client.aio.models.generate_content(
            model=self._model, contents=_to_google_contents(messages), config=_config_for(system, tools)
        )
        tool_calls = _tool_calls_from(response.function_calls)
        return LLMTurn(text=response.text, tool_calls=tool_calls, stop=len(tool_calls) == 0, usage=_usage_from(response.usage_metadata))

    async def chat_stream(
        self,
        *,
        system: str | None,
        messages: list[AgentMessage],
        tools: list[Tool],
        on_text: Callable[[str], None],
    ) -> LLMTurn:
        stream = await self._client.aio.models.generate_content_stream(
            model=self._model, contents=_to_google_contents(messages), config=_config_for(system, tools)
        )

        text = ""
        # Unlike OpenAI, Gemini doesn't fragment a function call's JSON
        # arguments across chunks — each chunk's own function_calls/
        # usage_metadata already reflect that chunk's complete state, so the
        # last chunk that has them wins (usage is typically only present on
        # the final chunk).
        last_tool_calls: list[ToolCall] | None = None
        usage: Usage | None = None

        async for chunk in stream:
            if chunk.text:
                text += chunk.text
                on_text(chunk.text)
            if chunk.function_calls:
                last_tool_calls = _tool_calls_from(chunk.function_calls)
            if chunk.usage_metadata:
                usage = _usage_from(chunk.usage_metadata)

        tool_calls = last_tool_calls or []
        return LLMTurn(text=text or None, tool_calls=tool_calls, stop=len(tool_calls) == 0, usage=usage)


def create_google_provider(
    *,
    api_key: str | None = None,
    vertexai: bool = False,
    project: str | None = None,
    location: str | None = None,
    model: str | None = None,
) -> _GoogleProvider:
    client_kwargs: dict[str, Any] = {"vertexai": vertexai}
    if vertexai:
        if project is not None:
            client_kwargs["project"] = project
        if location is not None:
            client_kwargs["location"] = location
    else:
        client_kwargs["api_key"] = api_key or os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")

    client = genai.Client(**client_kwargs)
    return _GoogleProvider(client, model or DEFAULT_MODEL)
