"""The provider-agnostic shapes Agent/Crew are built from — mirrors
@berth/agents' types.ts field-for-field (snake_case instead of camelCase),
not a novel design."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Protocol

AgentRole = Literal["user", "assistant", "tool"]


@dataclass
class ToolCall:
    id: str
    name: str
    input: Any


@dataclass
class ToolResult:
    id: str
    name: str
    output: Any


@dataclass
class AgentMessage:
    role: AgentRole
    text: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_result: ToolResult | None = None


@dataclass
class Usage:
    input_tokens: int
    output_tokens: int


@dataclass
class LLMTurn:
    tool_calls: list[ToolCall]
    text: str | None = None
    # True once the model has nothing further to do — no pending tool calls.
    stop: bool = False
    usage: Usage | None = None


@dataclass
class ExecutedToolCall:
    name: str
    input: Any
    result: Any


@dataclass
class AgentRunResult:
    text: str
    tool_calls: list[ExecutedToolCall] = field(default_factory=list)


class Tool(Protocol):
    """The single interface a resident-app export or another Agent (via
    Agent.as_tool()) both implement."""

    name: str
    description: str
    # JSON Schema for the tool's input.
    input_schema: dict[str, Any]

    async def invoke(self, input: Any) -> Any: ...


class LLMProvider(Protocol):
    """The "bring your own LLM" seam. Any provider implementing this can
    drive an Agent — Agent/Crew never reference a specific vendor.

    `chat_stream` is deliberately not declared here — it's an optional
    capability (mirroring chatStream? on LLMProvider in types.ts), checked at
    call time via getattr(llm, "chat_stream", None) rather than required by
    this Protocol, so a provider without it still satisfies structural typing."""

    name: str

    async def chat(
        self,
        *,
        system: str | None,
        messages: list[AgentMessage],
        tools: list[Tool],
    ) -> LLMTurn: ...


@dataclass
class CrewRun:
    _run: Callable[[str], Awaitable[str]]

    async def run(self, input: str) -> str:
        return await self._run(input)
