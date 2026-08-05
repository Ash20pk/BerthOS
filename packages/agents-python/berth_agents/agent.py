"""The provider-agnostic tool-use loop: identical regardless of which
LLMProvider or which Tool implementations are plugged in. Mirrors the core
loop in @berth/agents' agent.ts, including its checkpointing, token-level
streaming, structured-output repair loop, and per-turn/per-tool-call
tracing. Retrieval/human-approval and Computer/Docker boot glue
(createAgent/runAgent) still aren't ported — see docs/agents-python-reference.md."""

from __future__ import annotations

import time
from typing import Any, Callable

from pydantic import BaseModel

from .checkpoint import CheckpointedRun, CheckpointStore
from .guardrails import Guardrail, run_guardrails
from .structured_output import (
    StructuredOutputError,
    format_tool_input_error,
    parse_structured_output,
    structured_output_repair_prompt,
)
from .tracing import AgentStepEvent, StepTracer
from .types import AgentMessage, AgentRunResult, ExecutedToolCall, LLMProvider, Tool, ToolResult

DEFAULT_MAX_TURNS = 25
DEFAULT_MAX_REPAIR_ATTEMPTS = 2


class Agent:
    def __init__(
        self,
        *,
        llm: LLMProvider,
        tools: list[Tool],
        name: str = "agent",
        system_prompt: str | None = None,
        max_turns: int = DEFAULT_MAX_TURNS,
        checkpoint: CheckpointStore | None = None,
        trace: StepTracer | None = None,
        input_guardrails: list[Guardrail] | None = None,
        output_guardrails: list[Guardrail] | None = None,
    ) -> None:
        self.name = name
        self.tools = tools
        self.llm = llm
        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self._checkpoint_store = checkpoint
        self._tracer = trace
        self._input_guardrails = input_guardrails or []
        self._output_guardrails = output_guardrails or []

    async def run(
        self,
        input: str,
        *,
        run_id: str | None = None,
        on_text: Callable[[str], None] | None = None,
        response_schema: type[BaseModel] | None = None,
        max_repair_attempts: int = DEFAULT_MAX_REPAIR_ATTEMPTS,
    ) -> AgentRunResult:
        if self._input_guardrails:
            await run_guardrails(self._input_guardrails, input, "input")
        return await self._loop(
            [AgentMessage(role="user", text=input)],
            [],
            0,
            run_id,
            on_text,
            response_schema,
            max_repair_attempts,
        )

    async def resume(
        self,
        run_id: str,
        *,
        on_text: Callable[[str], None] | None = None,
        response_schema: type[BaseModel] | None = None,
        max_repair_attempts: int = DEFAULT_MAX_REPAIR_ATTEMPTS,
    ) -> AgentRunResult:
        """Continues a run a prior run()/resume() call persisted (via
        `checkpoint`) but never finished — a crashed process, anything that
        lost the original call stack. Needs `checkpoint` to have been passed
        to this Agent's constructor: that's what makes the prior progress
        reachable from a process that doesn't share any memory with the one
        that made it."""
        if not self._checkpoint_store:
            raise RuntimeError(
                f'Agent "{self.name}" has no checkpoint store configured — pass checkpoint= when constructing it to resume a run'
            )
        checkpoint = await self._checkpoint_store.load(run_id)
        if not checkpoint:
            raise RuntimeError(f'no checkpoint found for run "{run_id}"')
        if checkpoint.status == "done":
            return AgentRunResult(text=checkpoint.text or "", tool_calls=checkpoint.tool_calls)
        return await self._loop(
            checkpoint.messages,
            checkpoint.tool_calls,
            checkpoint.turn_count,
            run_id,
            on_text,
            response_schema,
            max_repair_attempts,
        )

    async def _loop(
        self,
        initial_messages: list[AgentMessage],
        initial_executed: list[ExecutedToolCall],
        start_turn: int,
        run_id: str | None,
        on_text: Callable[[str], None] | None,
        response_schema: type[BaseModel] | None,
        max_repair_attempts: int,
    ) -> AgentRunResult:
        messages = list(initial_messages)
        executed = list(initial_executed)
        repair_attempts = 0

        async def checkpoint(turn_count: int, status: str, text: str | None = None) -> None:
            if not self._checkpoint_store or not run_id:
                return
            await self._checkpoint_store.save(
                CheckpointedRun(
                    run_id=run_id,
                    agent_name=self.name,
                    status=status,
                    turn_count=turn_count,
                    messages=messages,
                    tool_calls=executed,
                    text=text,
                )
            )

        async def emit_trace(turn_count: int, kind: str, duration_ms: float, *, tool_name=None, error=None, usage=None) -> None:
            if not self._tracer or not run_id:
                return
            await self._tracer.emit(
                AgentStepEvent(
                    run_id=run_id,
                    agent_name=self.name,
                    turn=turn_count,
                    kind=kind,
                    duration_ms=duration_ms,
                    tool_name=tool_name,
                    error=error,
                    usage=usage,
                )
            )

        async def guard_output(text: str, turn_count: int) -> None:
            if not self._output_guardrails:
                return
            try:
                await run_guardrails(self._output_guardrails, text, "output")
            except Exception:
                await checkpoint(turn_count, "error", text)
                raise

        # chat_stream is an optional capability (see LLMProvider's docstring
        # in types.py) — absent means no incremental events, not an error.
        chat_stream = getattr(self.llm, "chat_stream", None)

        for turn_count in range(start_turn, self.max_turns):
            turn_start = time.monotonic()
            try:
                if on_text and chat_stream:
                    turn = await chat_stream(system=self.system_prompt, messages=messages, tools=self.tools, on_text=on_text)
                else:
                    turn = await self.llm.chat(system=self.system_prompt, messages=messages, tools=self.tools)
            except Exception as err:
                await emit_trace(turn_count, "llm-turn", (time.monotonic() - turn_start) * 1000, error=str(err))
                raise
            await emit_trace(turn_count, "llm-turn", (time.monotonic() - turn_start) * 1000, usage=turn.usage)

            if not turn.tool_calls:
                text = turn.text or ""

                if response_schema:
                    success, data, error = parse_structured_output(text, response_schema)
                    if success:
                        await guard_output(text, turn_count)
                        await checkpoint(turn_count, "done", text)
                        return AgentRunResult(text=text, tool_calls=executed)

                    if repair_attempts >= max_repair_attempts:
                        await checkpoint(turn_count, "error", text)
                        raise StructuredOutputError(
                            f'Agent "{self.name}" failed to produce output matching response_schema after '
                            f"{max_repair_attempts} repair attempt(s): {error}",
                            text,
                        )

                    repair_attempts += 1
                    messages.append(AgentMessage(role="assistant", text=text))
                    messages.append(AgentMessage(role="user", text=structured_output_repair_prompt(error)))
                    await checkpoint(turn_count + 1, "running")
                    continue

                await guard_output(text, turn_count)
                await checkpoint(turn_count, "done", text)
                return AgentRunResult(text=text, tool_calls=executed)

            messages.append(AgentMessage(role="assistant", text=turn.text, tool_calls=turn.tool_calls))

            for call in turn.tool_calls:
                call_start = time.monotonic()
                tool = next((t for t in self.tools if t.name == call.name), None)
                result: Any
                error: str | None = None
                if tool is None:
                    error = f'no such tool "{call.name}"'
                    result = {"error": error}
                else:
                    try:
                        result = await tool.invoke(call.input)
                    except Exception as err:  # noqa: BLE001 - fed back to the model, not re-raised
                        # A failing tool call feeds an {error} result back to the
                        # model, same as the "no such tool" case above, instead of
                        # raising out of the whole loop — the model gets a chance
                        # to retry with different input, try another tool, or
                        # surface the failure itself. format_tool_input_error()
                        # reformats a pydantic ValidationError the same way a
                        # response_schema repair prompt's issues are formatted.
                        error = format_tool_input_error(err)
                        result = {"error": error}

                await emit_trace(turn_count, "tool-call", (time.monotonic() - call_start) * 1000, tool_name=call.name, error=error)
                executed.append(ExecutedToolCall(name=call.name, input=call.input, result=result))
                messages.append(
                    AgentMessage(role="tool", tool_result=ToolResult(id=call.id, name=call.name, output=result))
                )

            await checkpoint(turn_count + 1, "running")

        await checkpoint(self.max_turns, "error")
        raise RuntimeError(f'Agent "{self.name}" exceeded its max_turns ({self.max_turns}) without reaching a final answer')

    def with_tools(self, extra_tools: list[Tool]) -> "Agent":
        """Returns a new Agent with the same identity/llm/system_prompt/
        checkpoint/trace/guardrails but an extended tool list — used by
        Crew's manager pattern to give a manager agent one Tool per worker
        without mutating either agent."""
        return Agent(
            llm=self.llm,
            tools=[*self.tools, *extra_tools],
            name=self.name,
            system_prompt=self.system_prompt,
            max_turns=self.max_turns,
            checkpoint=self._checkpoint_store,
            trace=self._tracer,
            input_guardrails=self._input_guardrails,
            output_guardrails=self._output_guardrails,
        )

    def as_tool(self, description: str) -> Tool:
        """Wraps this agent as a Tool — {"task": str} in, this.run(task).text
        out. The "agent-as-tool" delegation pattern: a manager agent's tool
        list can mix resident-app tools and other agents through the same
        Tool.invoke() dispatch path."""
        agent = self

        class _AgentTool:
            name = agent.name
            input_schema = {
                "type": "object",
                "properties": {"task": {"type": "string", "description": "the task to delegate to this agent"}},
                "required": ["task"],
            }

            def __init__(self) -> None:
                self.description = description

            async def invoke(self, input: Any) -> Any:
                result = await agent.run(input["task"])
                return result.text

        return _AgentTool()
