"""Provider-adapter tests — REMEDIATION 3.7's Python half.

`berth_agents/providers/` was 688 lines with no test of any kind. That
absence is exactly why 3.1, 3.2 and 3.6 were live in the TypeScript adapters
until someone went looking; the Python ones have never been checked at all.

Structured to mirror `packages/agents/src/providers/*.test.ts`, against a
real HTTP server rather than a stubbed client — see mock_llm_server.py for
why that distinction is load-bearing rather than stylistic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from berth_agents.providers.anthropic import create_anthropic_provider
from berth_agents.providers.openai import create_openai_provider
from berth_agents.types import AgentMessage, Tool, ToolCall, ToolResult

from mock_llm_server import MockLLMServer, anthropic_message, chat_completion, sse_chunk, tool_call


@dataclass
class _FakeTool:
    """A concrete stand-in: `Tool` is a Protocol, so it can't be instantiated.
    Structural typing means an adapter can't tell this from a real
    resident-app export."""

    name: str
    description: str
    input_schema: dict[str, Any]

    async def invoke(self, _input: Any) -> Any:
        return None


def a_tool(name: str = "read_file") -> Tool:
    return _FakeTool(
        name=name,
        description=f"reads a file ({name})",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
    )


# ---------------------------------------------------------------------------
# OpenAI family
# ---------------------------------------------------------------------------


async def test_maps_messages_including_tool_call_round_trip() -> None:
    with MockLLMServer([chat_completion(content="done")]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url)
        await provider.chat(
            system="you are helpful",
            messages=[
                AgentMessage(role="user", text="read it"),
                AgentMessage(role="assistant", tool_calls=[ToolCall(id="call_1", name="read_file", input={"path": "/x"})]),
                AgentMessage(role="tool", tool_result=ToolResult(id="call_1", name="read_file", output={"content": "hi"})),
            ],
            tools=[a_tool()],
        )

        body = server.last_request
        roles = [m["role"] for m in body["messages"]]
        assert roles == ["system", "user", "assistant", "tool"]
        # Arguments cross the wire as a JSON *string*, not an object — getting
        # this wrong is silently accepted by a stub and rejected by the API.
        assert body["messages"][2]["tool_calls"][0]["function"]["arguments"] == '{"path": "/x"}'
        # tool_call_id is what correlates a result to its call; without it the
        # API can't match them and rejects the request.
        assert body["messages"][3]["tool_call_id"] == "call_1"


async def test_omits_the_tools_key_entirely_when_there_are_no_tools() -> None:
    # REMEDIATION 3.1, Python side. The OpenAI API rejects `tools: []`
    # outright — the key has to be absent, not empty — and both LLM-judge
    # features (create_llm_guardrail, llm_judge) call chat() with no tools at
    # all. Fixed in openai.ts long ago; the Python adapter still sent the
    # empty list, so the same two features were broken here.
    with MockLLMServer([chat_completion()]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url)
        await provider.chat(system=None, messages=[AgentMessage(role="user", text="hi")], tools=[])

        assert "tools" not in server.last_request, "an empty tools array is rejected by the real API"


async def test_sends_tools_when_there_are_some() -> None:
    # The positive control: a test that only asserted absence would also pass
    # against an adapter that had stopped sending tools altogether.
    with MockLLMServer([chat_completion()]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url)
        await provider.chat(system=None, messages=[AgentMessage(role="user", text="hi")], tools=[a_tool()])

        assert [t["function"]["name"] for t in server.last_request["tools"]] == ["read_file"]


async def test_parses_a_tool_call_response() -> None:
    with MockLLMServer([chat_completion(content=None, tool_calls=[tool_call()], finish_reason="tool_calls")]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url)
        turn = await provider.chat(system=None, messages=[AgentMessage(role="user", text="read")], tools=[a_tool()])

        assert len(turn.tool_calls) == 1
        assert turn.tool_calls[0].name == "read_file"
        assert turn.tool_calls[0].input == {"path": "/x"}
        assert turn.stop is False


async def test_reports_usage() -> None:
    with MockLLMServer([chat_completion(usage={"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18})]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url)
        turn = await provider.chat(system=None, messages=[AgentMessage(role="user", text="hi")], tools=[])

        assert turn.usage is not None
        assert (turn.usage.input_tokens, turn.usage.output_tokens) == (11, 7)


async def test_streams_text_deltas() -> None:
    chunks = [
        sse_chunk(content="hel"),
        sse_chunk(content="lo"),
        sse_chunk(finish_reason="stop"),
        sse_chunk(usage={"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}),
    ]
    with MockLLMServer([chunks]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url)
        seen: list[str] = []
        turn = await provider.chat_stream(
            system=None,
            messages=[AgentMessage(role="user", text="hi")],
            tools=[],
            on_text=seen.append,
        )

        assert seen == ["hel", "lo"]
        assert turn.text == "hello"
        # The usage-only final frame has an empty choices list, so an adapter
        # that reads fields off "the last chunk" loses this.
        assert turn.usage is not None
        assert turn.usage.input_tokens == 3


async def test_reassembles_a_tool_call_fragmented_across_frames() -> None:
    chunks = [
        sse_chunk(tool_call_delta={"index": 0, "id": "call_1", "function": {"name": "read_", "arguments": ""}}),
        sse_chunk(tool_call_delta={"index": 0, "function": {"name": "file", "arguments": '{"pa'}}),
        sse_chunk(tool_call_delta={"index": 0, "function": {"arguments": 'th":"/x"}'}}),
        sse_chunk(finish_reason="tool_calls"),
    ]
    with MockLLMServer([chunks]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url)
        turn = await provider.chat_stream(
            system=None, messages=[AgentMessage(role="user", text="hi")], tools=[a_tool()], on_text=lambda _d: None
        )

        # Both the name and the arguments arrive in pieces, keyed by index
        # rather than id — the id only appears on the first fragment.
        assert len(turn.tool_calls) == 1
        assert turn.tool_calls[0].name == "read_file"
        assert turn.tool_calls[0].input == {"path": "/x"}


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


async def test_anthropic_maps_messages_and_tools() -> None:
    with MockLLMServer([anthropic_message()]) as server:
        provider = create_anthropic_provider(api_key="test", base_url=server.base_url)
        await provider.chat(
            system="be brief",
            messages=[AgentMessage(role="user", text="hi")],
            tools=[a_tool()],
        )

        body = server.last_request
        # Anthropic takes the system prompt as a top-level field, not as a
        # message with role "system" — the one structural difference from the
        # OpenAI mapping that a shared test would paper over.
        assert body["system"] == "be brief"
        assert body["messages"] == [{"role": "user", "content": "hi"}]
        assert body["tools"][0]["name"] == "read_file"
        assert "input_schema" in body["tools"][0]


async def test_anthropic_drops_messages_with_no_content_at_all() -> None:
    # REMEDIATION 3.6: the Messages API rejects any message whose content is
    # an empty string or empty array, and Agent.run() can produce both.
    with MockLLMServer([anthropic_message()]) as server:
        provider = create_anthropic_provider(api_key="test", base_url=server.base_url)
        await provider.chat(
            system=None,
            messages=[
                AgentMessage(role="user", text="hi"),
                AgentMessage(role="assistant", text=""),
                AgentMessage(role="user", text="still here"),
            ],
            tools=[],
        )

        contents = [m["content"] for m in server.last_request["messages"]]
        assert "" not in contents
        assert [c for c in contents if isinstance(c, str)] == ["hi", "still here"]


async def test_anthropic_keeps_an_assistant_turn_that_has_tool_calls_but_no_text() -> None:
    # The 3.6 test keys on "no content at all", not "no text": an assistant
    # turn with tool calls and no narration is both legitimate and common,
    # and dropping it would break every tool-use loop.
    with MockLLMServer([anthropic_message()]) as server:
        provider = create_anthropic_provider(api_key="test", base_url=server.base_url)
        await provider.chat(
            system=None,
            messages=[
                AgentMessage(role="user", text="read it"),
                AgentMessage(role="assistant", tool_calls=[ToolCall(id="t1", name="read_file", input={"path": "/x"})]),
                AgentMessage(role="tool", tool_result=ToolResult(id="t1", name="read_file", output={"content": "hi"})),
            ],
            tools=[a_tool()],
        )

        roles = [m["role"] for m in server.last_request["messages"]]
        assert "assistant" in roles, "an assistant turn carrying only tool calls must survive"


async def test_anthropic_parses_tool_use_blocks() -> None:
    response = anthropic_message(
        content=[{"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "/x"}}],
        stop_reason="tool_use",
    )
    with MockLLMServer([response]) as server:
        provider = create_anthropic_provider(api_key="test", base_url=server.base_url)
        turn = await provider.chat(system=None, messages=[AgentMessage(role="user", text="read")], tools=[a_tool()])

        assert [c.name for c in turn.tool_calls] == ["read_file"]
        assert turn.stop is False


async def test_anthropic_normalizes_a_missing_tool_output_to_json_null() -> None:
    # json.dumps(None) is "null"; an absent value would produce an empty
    # content block, which is the very thing 3.6 exists to prevent.
    with MockLLMServer([anthropic_message()]) as server:
        provider = create_anthropic_provider(api_key="test", base_url=server.base_url)
        await provider.chat(
            system=None,
            messages=[
                AgentMessage(role="user", text="hi"),
                AgentMessage(role="assistant", tool_calls=[ToolCall(id="t1", name="read_file", input={})]),
                AgentMessage(role="tool", tool_result=ToolResult(id="t1", name="read_file", output=None)),
            ],
            tools=[],
        )

        blocks = server.last_request["messages"][-1]["content"]
        assert blocks[0]["content"] == "null"


@pytest.mark.parametrize("status", [401, 429, 500])
async def test_surfaces_transport_failures_rather_than_returning_an_empty_turn(status: int) -> None:
    # A provider that swallowed these would hand Agent an empty turn, which
    # the loop would treat as a final answer — the same class of silent
    # success REMEDIATION 3.2 found in the TypeScript adapters.
    with MockLLMServer([{"__status": status, "error": {"message": "nope"}}]) as server:
        provider = create_openai_provider(api_key="test", base_url=server.base_url, max_retries=0)
        with pytest.raises(Exception):
            await provider.chat(system=None, messages=[AgentMessage(role="user", text="hi")], tools=[])
