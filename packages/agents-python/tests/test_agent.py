import pytest
from pydantic import BaseModel

from berth_agents import Agent, FileCheckpointStore, LLMTurn, StructuredOutputError, ToolCall


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


class ScriptedStreamingLLM(ScriptedLLM):
    """Same scripted-turn behavior as ScriptedLLM, but also exposes
    chat_stream() — Agent._loop() only takes the streaming path when both
    on_text and this method are present."""

    def __init__(self, turns: list[LLMTurn], deltas: list[str] | None = None) -> None:
        super().__init__(turns)
        self._deltas = deltas or []

    async def chat_stream(self, *, system, messages, tools, on_text):
        for delta in self._deltas:
            on_text(delta)
        return await self.chat(system=system, messages=messages, tools=tools)


class Answer(BaseModel):
    label: str


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


@pytest.mark.asyncio
async def test_chat_stream_is_used_when_on_text_is_given():
    received: list[str] = []
    llm = ScriptedStreamingLLM([LLMTurn(text="streamed", tool_calls=[], stop=True)], deltas=["str", "eamed"])
    agent = Agent(llm=llm, tools=[])

    result = await agent.run("hi", on_text=received.append)

    assert result.text == "streamed"
    assert received == ["str", "eamed"]


@pytest.mark.asyncio
async def test_plain_chat_is_used_when_the_provider_has_no_chat_stream():
    llm = ScriptedLLM([LLMTurn(text="ok", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[])

    result = await agent.run("hi", on_text=lambda _delta: None)

    assert result.text == "ok"


@pytest.mark.asyncio
async def test_a_crashed_run_resumes_from_its_last_checkpoint(tmp_path):
    store = FileCheckpointStore(tmp_path)
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="search", input={})], stop=False),
            LLMTurn(text="finished", tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[EchoTool("search")], checkpoint=store)

    # Only run the first turn "for real" by handing a max_turns of 1, then
    # resume with a fresh Agent instance sharing the same store — proving
    # the checkpoint (not in-memory state) is what makes resume() work.
    capped_agent = Agent(llm=llm, tools=[EchoTool("search")], max_turns=1, checkpoint=store)
    with pytest.raises(RuntimeError, match="exceeded its max_turns"):
        await capped_agent.run("do the thing", run_id="run-1")

    result = await agent.resume("run-1")

    assert result.text == "finished"


@pytest.mark.asyncio
async def test_resume_without_a_checkpoint_store_raises():
    llm = ScriptedLLM([])
    agent = Agent(llm=llm, tools=[])

    with pytest.raises(RuntimeError, match="no checkpoint store configured"):
        await agent.resume("run-1")


@pytest.mark.asyncio
async def test_resume_with_no_saved_checkpoint_raises(tmp_path):
    store = FileCheckpointStore(tmp_path)
    llm = ScriptedLLM([])
    agent = Agent(llm=llm, tools=[], checkpoint=store)

    with pytest.raises(RuntimeError, match="no checkpoint found"):
        await agent.resume("nonexistent")


@pytest.mark.asyncio
async def test_resume_on_an_already_done_run_replays_without_calling_the_model(tmp_path):
    store = FileCheckpointStore(tmp_path)
    llm = ScriptedLLM([LLMTurn(text="the answer", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[], checkpoint=store)

    await agent.run("do the thing", run_id="run-2")
    result = await agent.resume("run-2")

    assert result.text == "the answer"
    assert llm.call_count == 1


@pytest.mark.asyncio
async def test_response_schema_accepts_a_first_valid_answer():
    llm = ScriptedLLM([LLMTurn(text='{"label": "cat"}', tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[])

    result = await agent.run("classify", response_schema=Answer)

    assert result.text == '{"label": "cat"}'


@pytest.mark.asyncio
async def test_response_schema_repairs_an_invalid_first_answer():
    llm = ScriptedLLM(
        [
            LLMTurn(text="not json", tool_calls=[], stop=True),
            LLMTurn(text='{"label": "dog"}', tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[])

    result = await agent.run("classify", response_schema=Answer)

    assert result.text == '{"label": "dog"}'
    assert llm.call_count == 2


@pytest.mark.asyncio
async def test_response_schema_raises_after_exhausting_repair_attempts():
    llm = ScriptedLLM([LLMTurn(text="not json", tool_calls=[], stop=True) for _ in range(3)])
    agent = Agent(llm=llm, tools=[])

    with pytest.raises(StructuredOutputError):
        await agent.run("classify", response_schema=Answer, max_repair_attempts=2)
