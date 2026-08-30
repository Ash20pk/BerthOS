import pytest
from pydantic import BaseModel

from berth_agents import (
    Agent,
    AgentMessage,
    AgentStepEvent,
    FileCheckpointStore,
    GuardrailResult,
    LLMTurn,
    StructuredOutputError,
    ToolCall,
    create_in_memory_session,
)


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


class RecordingTracer:
    """A plain fake StepTracer — no OTel/SDK involved — used to assert on
    exactly what Agent._loop() emits, same role as agent.test.ts's
    recordingTracer()."""

    def __init__(self) -> None:
        self.events: list[AgentStepEvent] = []

    async def emit(self, event: AgentStepEvent) -> None:
        self.events.append(event)


@pytest.mark.asyncio
async def test_run_emits_an_llm_turn_event_and_a_tool_call_event_when_a_run_id_is_given():
    tracer = RecordingTracer()
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="search", input={})], stop=False),
            LLMTurn(text="done", tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[EchoTool("search")], name="my-agent", trace=tracer)

    await agent.run("do the thing", run_id="run-1")

    kinds = [e.kind for e in tracer.events]
    assert kinds == ["llm-turn", "tool-call", "llm-turn"]
    assert all(e.run_id == "run-1" and e.agent_name == "my-agent" for e in tracer.events)
    assert all(e.duration_ms >= 0 for e in tracer.events)
    assert tracer.events[1].tool_name == "search"
    assert tracer.events[1].error is None


@pytest.mark.asyncio
async def test_run_emits_no_trace_events_without_a_run_id():
    tracer = RecordingTracer()
    llm = ScriptedLLM([LLMTurn(text="hi", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[], trace=tracer)

    await agent.run("hi")

    assert tracer.events == []


@pytest.mark.asyncio
async def test_a_throwing_tool_call_is_traced_with_its_error():
    tracer = RecordingTracer()
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="boom", input={})], stop=False),
            LLMTurn(text="recovered", tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[ThrowingTool("boom", "kaboom")], trace=tracer)

    await agent.run("do the thing", run_id="run-1")

    tool_events = [e for e in tracer.events if e.kind == "tool-call"]
    assert tool_events[0].error == "kaboom"


@pytest.mark.asyncio
async def test_a_failing_llm_call_is_traced_with_its_error_and_reraised():
    class FailingLLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            raise RuntimeError("model unavailable")

    tracer = RecordingTracer()
    agent = Agent(llm=FailingLLM(), tools=[], trace=tracer)

    with pytest.raises(RuntimeError, match="model unavailable"):
        await agent.run("do the thing", run_id="run-1")

    assert len(tracer.events) == 1
    assert tracer.events[0].kind == "llm-turn"
    assert tracer.events[0].error == "model unavailable"


@pytest.mark.asyncio
async def test_with_tools_carries_the_tracer_over_to_the_new_agent():
    tracer = RecordingTracer()
    llm = ScriptedLLM([LLMTurn(text="ok", tool_calls=[], stop=True)])
    original = Agent(llm=llm, tools=[], trace=tracer)
    extended = original.with_tools([EchoTool("a")])

    await extended.run("hi", run_id="run-1")

    assert len(tracer.events) == 1


@pytest.mark.asyncio
async def test_a_tripped_input_guardrail_raises_before_the_llm_is_ever_called():
    llm = ScriptedLLM([LLMTurn(text="should never be reached", tool_calls=[], stop=True)])
    agent = Agent(
        llm=llm,
        tools=[],
        input_guardrails=[lambda text: GuardrailResult(tripwire_triggered=True, message="banned phrase")],
    )

    with pytest.raises(Exception, match="input guardrail tripped: banned phrase"):
        await agent.run("do something bad")
    assert llm.call_count == 0


@pytest.mark.asyncio
async def test_an_untripped_input_guardrail_lets_the_run_proceed_as_normal():
    llm = ScriptedLLM([LLMTurn(text="all good", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[], input_guardrails=[lambda text: GuardrailResult(tripwire_triggered=False)])

    result = await agent.run("a fine request")

    assert result.text == "all good"


@pytest.mark.asyncio
async def test_a_tripped_output_guardrail_raises_instead_of_returning_the_flagged_final_answer():
    llm = ScriptedLLM([LLMTurn(text="leaked secret", tool_calls=[], stop=True)])
    agent = Agent(
        llm=llm,
        tools=[],
        output_guardrails=[
            lambda text: GuardrailResult(tripwire_triggered="secret" in text, message="looked like a secret")
        ],
    )

    with pytest.raises(Exception, match="output guardrail tripped: looked like a secret"):
        await agent.run("tell me a secret")


@pytest.mark.asyncio
async def test_a_tripped_output_guardrail_checkpoints_the_run_as_error_rather_than_done(tmp_path):
    store = FileCheckpointStore(tmp_path)
    llm = ScriptedLLM([LLMTurn(text="leaked secret", tool_calls=[], stop=True)])
    agent = Agent(
        llm=llm,
        tools=[],
        checkpoint=store,
        output_guardrails=[lambda text: GuardrailResult(tripwire_triggered=True, message="nope")],
    )

    with pytest.raises(Exception):
        await agent.run("do it", run_id="run-guard")

    checkpoint = await store.load("run-guard")
    assert checkpoint.status == "error"


@pytest.mark.asyncio
async def test_multiple_guardrails_run_in_order_and_stop_at_the_first_tripped_one():
    llm = ScriptedLLM([LLMTurn(text="fine", tool_calls=[], stop=True)])
    calls = []

    def first(text):
        calls.append("first")
        return GuardrailResult(tripwire_triggered=True, message="first guardrail tripped")

    def second(text):
        calls.append("second")
        return GuardrailResult(tripwire_triggered=False)

    agent = Agent(llm=llm, tools=[], input_guardrails=[first, second])

    with pytest.raises(Exception, match="first guardrail tripped"):
        await agent.run("input")
    assert calls == ["first"]


@pytest.mark.asyncio
async def test_with_tools_carries_guardrails_over_to_the_extended_agent():
    llm = ScriptedLLM([LLMTurn(text="unreachable", tool_calls=[], stop=True)])
    original = Agent(
        llm=llm,
        tools=[],
        input_guardrails=[lambda text: GuardrailResult(tripwire_triggered=True, message="blocked")],
    )
    extended = original.with_tools([EchoTool("extra")])

    with pytest.raises(Exception, match="blocked"):
        await extended.run("anything")
    assert llm.call_count == 0


@pytest.mark.asyncio
async def test_output_guardrails_still_apply_to_a_resumed_runs_final_answer(tmp_path):
    store = FileCheckpointStore(tmp_path)
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="search", input={})], stop=False),
            LLMTurn(text="leaked secret", tool_calls=[], stop=True),
        ]
    )
    # Same two-agent trick test_a_crashed_run_resumes_from_its_last_checkpoint
    # uses above: force a real "running" checkpoint via an artificially
    # capped max_turns, then resume with a fresh Agent — this one configured
    # with an output guardrail — to prove the guardrail applies to the
    # *resumed* run's final answer, not just a fresh run() call's.
    capped_agent = Agent(llm=llm, tools=[EchoTool("search")], max_turns=1, checkpoint=store)
    with pytest.raises(RuntimeError, match="exceeded its max_turns"):
        await capped_agent.run("do the thing", run_id="run-resumed-guard")

    agent = Agent(
        llm=llm,
        tools=[EchoTool("search")],
        checkpoint=store,
        output_guardrails=[lambda text: GuardrailResult(tripwire_triggered="secret" in text)],
    )

    with pytest.raises(Exception, match="output guardrail tripped"):
        await agent.resume("run-resumed-guard")


@pytest.mark.asyncio
async def test_run_with_a_session_prepends_its_prior_items_before_the_new_input():
    session = create_in_memory_session(
        [
            AgentMessage(role="user", text="what's the capital of France?"),
            AgentMessage(role="assistant", text="Paris"),
        ]
    )
    seen_messages = None

    class RecordingLLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            nonlocal seen_messages
            seen_messages = list(messages)
            return LLMTurn(text="38 million", tool_calls=[], stop=True)

    agent = Agent(llm=RecordingLLM(), tools=[])

    await agent.run("and its population?", session=session)

    assert seen_messages == [
        AgentMessage(role="user", text="what's the capital of France?"),
        AgentMessage(role="assistant", text="Paris"),
        AgentMessage(role="user", text="and its population?"),
    ]


@pytest.mark.asyncio
async def test_run_with_a_session_appends_the_new_turns_messages_after_a_successful_run():
    session = create_in_memory_session()
    llm = ScriptedLLM([LLMTurn(text="hello there", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[])

    await agent.run("hi", session=session)

    assert await session.get_items() == [
        AgentMessage(role="user", text="hi"),
        AgentMessage(role="assistant", text="hello there"),
    ]


@pytest.mark.asyncio
async def test_run_with_a_session_persists_tool_call_turns_too():
    session = create_in_memory_session()
    llm = ScriptedLLM(
        [
            LLMTurn(tool_calls=[ToolCall(id="1", name="search", input={})], stop=False),
            LLMTurn(text="done", tool_calls=[], stop=True),
        ]
    )
    agent = Agent(llm=llm, tools=[EchoTool("search")])

    await agent.run("look something up", session=session)

    items = await session.get_items()
    assert len(items) == 4  # user input, assistant tool-call turn, tool result, final assistant answer
    assert items[0].role == "user"
    assert items[-1].text == "done"


@pytest.mark.asyncio
async def test_a_run_a_tripped_output_guardrail_kills_does_not_persist_anything_to_the_session():
    session = create_in_memory_session()
    llm = ScriptedLLM([LLMTurn(text="leaked secret", tool_calls=[], stop=True)])
    agent = Agent(
        llm=llm,
        tools=[],
        output_guardrails=[lambda text: GuardrailResult(tripwire_triggered=True, message="nope")],
    )

    with pytest.raises(Exception):
        await agent.run("do it", session=session)

    assert await session.get_items() == []


@pytest.mark.asyncio
async def test_run_without_a_session_behaves_exactly_as_before():
    llm = ScriptedLLM([LLMTurn(text="hello", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[])

    result = await agent.run("hi")

    assert result.text == "hello"
    assert llm.call_count == 1
