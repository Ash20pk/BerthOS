"""The provider-agnostic tool-use loop: identical regardless of which
LLMProvider or which Tool implementations are plugged in. Mirrors the core
loop in @berth/agents' agent.ts — none of that file's enhancements
(checkpointing, tracing, streaming, structured-output repair, Computer/Docker
boot glue) are ported here; see docs/agents-python-reference.md for why."""

from __future__ import annotations

from typing import Any

from .types import AgentMessage, AgentRunResult, ExecutedToolCall, LLMProvider, Tool, ToolResult

DEFAULT_MAX_TURNS = 25


class Agent:
    def __init__(
        self,
        *,
        llm: LLMProvider,
        tools: list[Tool],
        name: str = "agent",
        system_prompt: str | None = None,
        max_turns: int = DEFAULT_MAX_TURNS,
    ) -> None:
        self.name = name
        self.tools = tools
        self.llm = llm
        self.system_prompt = system_prompt
        self.max_turns = max_turns

    async def run(self, input: str) -> AgentRunResult:
        messages: list[AgentMessage] = [AgentMessage(role="user", text=input)]
        executed: list[ExecutedToolCall] = []

        for _turn_count in range(self.max_turns):
            turn = await self.llm.chat(system=self.system_prompt, messages=messages, tools=self.tools)

            if not turn.tool_calls:
                return AgentRunResult(text=turn.text or "", tool_calls=executed)

            messages.append(AgentMessage(role="assistant", text=turn.text, tool_calls=turn.tool_calls))

            for call in turn.tool_calls:
                tool = next((t for t in self.tools if t.name == call.name), None)
                result: Any
                if tool is None:
                    result = {"error": f'no such tool "{call.name}"'}
                else:
                    try:
                        result = await tool.invoke(call.input)
                    except Exception as err:  # noqa: BLE001 - fed back to the model, not re-raised
                        # A failing tool call feeds an {error} result back to the
                        # model, same as the "no such tool" case above, instead of
                        # raising out of the whole loop — the model gets a chance
                        # to retry with different input, try another tool, or
                        # surface the failure itself.
                        result = {"error": str(err)}

                executed.append(ExecutedToolCall(name=call.name, input=call.input, result=result))
                messages.append(
                    AgentMessage(role="tool", tool_result=ToolResult(id=call.id, name=call.name, output=result))
                )

        raise RuntimeError(f'Agent "{self.name}" exceeded its max_turns ({self.max_turns}) without reaching a final answer')

    def with_tools(self, extra_tools: list[Tool]) -> "Agent":
        """Returns a new Agent with the same identity/llm/system_prompt but an
        extended tool list — used by Crew's manager pattern to give a manager
        agent one Tool per worker without mutating either agent."""
        return Agent(
            llm=self.llm,
            tools=[*self.tools, *extra_tools],
            name=self.name,
            system_prompt=self.system_prompt,
            max_turns=self.max_turns,
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
