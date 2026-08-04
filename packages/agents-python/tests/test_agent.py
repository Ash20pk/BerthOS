import pytest

from berth_agents import Agent, LLMTurn, ToolCall


class ScriptedLLM:
    """Pops the next scripted LLMTurn off a list on each chat() call, same
    pattern as agent.test.ts's scriptedLLM()."""

    name = "fake"

    def __init__(self, turns: list[LLMTurn]) -> None:
        self._turns = turns
        self._i = 0

    async def chat(self, *, system, messages, tools):
        if self._i >= len(self._turns):
            raise AssertionError("script exhausted — chat() called more times than the test expected")
        turn = self._turns[self._i]
        self._i += 1
        return turn

    @property
    def call_count(self) -> int:
        return self._i


class EchoTool:
    def __init__(self, name: str, result=None) -> None:
        self.name = name
        self.description = ""
        self.input_schema: dict = {}
        self._result = result if result is not None else "tool-result"

    async def invoke(self, input):
        return self._result


class ThrowingTool:
    def __init__(self, name: str, message: str) -> None:
        self.name = name
        self.description = ""
        self.input_schema: dict = {}
        self._message = message

    async def invoke(self, input):
        raise RuntimeError(self._message)


@pytest.mark.asyncio
async def test_run_answers_after_a_tool_call_turn():
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="search", input={})], stop=False),
            LLMTurn(text="done", tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[EchoTool("search")])

    result = await agent.run("do the thing")

    assert result.text == "done"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "search"


@pytest.mark.asyncio
async def test_run_with_no_tool_calls_returns_the_first_turns_text():
    llm = ScriptedLLM([LLMTurn(text="hello", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[])

    result = await agent.run("hi")

    assert result.text == "hello"
    assert result.tool_calls == []


@pytest.mark.asyncio
async def test_a_missing_tool_feeds_an_error_back_instead_of_raising():
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="nonexistent", input={})], stop=False),
            LLMTurn(text="recovered", tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[])

    result = await agent.run("do the thing")

    assert result.text == "recovered"
    assert result.tool_calls[0].result == {"error": 'no such tool "nonexistent"'}


@pytest.mark.asyncio
async def test_a_throwing_tool_feeds_an_error_back_instead_of_killing_the_run():
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="boom", input={})], stop=False),
            LLMTurn(text="recovered", tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[ThrowingTool("boom", "kaboom")])

    result = await agent.run("do the thing")

    assert result.text == "recovered"
    assert result.tool_calls[0].result == {"error": "kaboom"}


@pytest.mark.asyncio
async def test_exceeding_max_turns_raises():
    llm = ScriptedLLM(
        [LLMTurn(tool_calls=[ToolCall(id=str(i), name="search", input={})], stop=False) for i in range(3)]
    )
    agent = Agent(llm=llm, tools=[EchoTool("search")], max_turns=3)

    with pytest.raises(RuntimeError, match="exceeded its max_turns"):
        await agent.run("do the thing")


@pytest.mark.asyncio
async def test_as_tool_delegates_the_task_and_returns_the_agents_text():
    llm = ScriptedLLM([LLMTurn(text="delegated answer", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[], name="worker")
    tool = agent.as_tool("delegate to the worker")

    output = await tool.invoke({"task": "do the thing"})

    assert output == "delegated answer"
    assert tool.name == "worker"


@pytest.mark.asyncio
async def test_with_tools_extends_the_tool_list_without_mutating_the_original():
    llm = ScriptedLLM([LLMTurn(text="ok", tool_calls=[], stop=True)])
    original = Agent(llm=llm, tools=[EchoTool("a")])
    extended = original.with_tools([EchoTool("b")])

    assert [t.name for t in original.tools] == ["a"]
    assert [t.name for t in extended.tools] == ["a", "b"]
