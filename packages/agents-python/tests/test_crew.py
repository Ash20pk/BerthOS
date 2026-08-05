import dataclasses

import pytest
from pydantic import BaseModel

from berth_agents import Agent, Crew, FileCheckpointStore, LLMTurn, StructuredOutputError, ToolCall
from berth_agents.crew import CheckpointedCrewRun, checkpoint_key_for


def crew_checkpoint_store(tmp_path):
    """A FileCheckpointStore configured for CrewCheckpoint's shape instead
    of the default CheckpointedRun one — same pattern
    docs/agents-python-reference.md documents for Crew-level checkpointing."""
    return FileCheckpointStore(tmp_path, to_dict=dataclasses.asdict, from_dict=lambda d: CheckpointedCrewRun(**d))


class ScriptedLLM:
    name = "fake"

    def __init__(self, turns: list[LLMTurn]) -> None:
        self._turns = turns
        self._i = 0

    async def chat(self, *, system, messages, tools):
        turn = self._turns[self._i]
        self._i += 1
        return turn

    @property
    def call_count(self) -> int:
        return self._i


def text_agent(name: str, output: str) -> Agent:
    return Agent(llm=ScriptedLLM([LLMTurn(text=output, tool_calls=[], stop=True)]), tools=[], name=name)


def echo_agent(name: str) -> Agent:
    """Echoes the last user-turn text back — proves a delegated task's text
    actually reaches the agent, not just that *some* text comes back."""

    class _EchoLLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            last_user = next(m for m in reversed(messages) if m.role == "user")
            return LLMTurn(text=last_user.text, tool_calls=[], stop=True)

    return Agent(llm=_EchoLLM(), tools=[], name=name)


class Answer(BaseModel):
    label: str


@pytest.mark.asyncio
async def test_sequential_chains_output_into_input_in_order():
    crew = Crew.sequential(
        [
            text_agent("first", "step one"),
            text_agent("second", "step two"),
            text_agent("third", "step three"),
        ]
    )

    result = await crew.run("start")

    assert result == "step three"


@pytest.mark.asyncio
async def test_sequential_returns_input_unchanged_for_an_empty_list():
    crew = Crew.sequential([])

    result = await crew.run("unchanged")

    assert result == "unchanged"


@pytest.mark.asyncio
async def test_sequential_resumes_from_a_checkpoint_without_rerunning_completed_steps(tmp_path):
    store = crew_checkpoint_store(tmp_path)

    class _ExplodingLLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            raise AssertionError("this step should never run — resume() should have skipped it")

    exploding_agent = Agent(llm=_ExplodingLLM(), tools=[], name="should-not-run")

    # completed_steps=1 means step 0 already ran and produced "step one" —
    # a resumed run should skip straight to step 1, never calling step 0's
    # agent again.
    await store.save(
        CheckpointedCrewRun(
            run_id=checkpoint_key_for("run-1"), kind="sequential", status="running", completed_steps=1, state="step one"
        )
    )

    crew = Crew.sequential([exploding_agent, text_agent("second", "step two")], checkpoint=store, run_id="run-1")

    result = await crew.run("start")

    assert result == "step two"


@pytest.mark.asyncio
async def test_sequential_repairs_an_invalid_final_answer():
    repair_llm = ScriptedLLM(
        [
            LLMTurn(text="not json", tool_calls=[], stop=True),
            LLMTurn(text='{"label": "cat"}', tool_calls=[], stop=True),
        ]
    )
    last_agent = Agent(llm=repair_llm, tools=[], name="last")
    crew = Crew.sequential([text_agent("first", "irrelevant"), last_agent], response_schema=Answer)

    result = await crew.run("start")

    assert result == '{"label": "cat"}'


@pytest.mark.asyncio
async def test_sequential_raises_after_exhausting_repair_attempts():
    repair_llm = ScriptedLLM([LLMTurn(text="not json", tool_calls=[], stop=True) for _ in range(3)])
    last_agent = Agent(llm=repair_llm, tools=[], name="last")
    crew = Crew.sequential([last_agent], response_schema=Answer, max_repair_attempts=2)

    with pytest.raises(StructuredOutputError):
        await crew.run("start")


@pytest.mark.asyncio
async def test_with_manager_delegates_to_the_named_worker():
    class _ManagerLLM:
        name = "fake"

        def __init__(self) -> None:
            self._i = 0

        async def chat(self, *, system, messages, tools):
            self._i += 1
            if self._i == 1:
                return LLMTurn(tool_calls=[ToolCall(id="1", name="worker", input={"task": "do the thing"})], stop=False)
            last_result = next(m for m in reversed(messages) if m.role == "tool").tool_result
            return LLMTurn(text=f"worker said: {last_result.output}", tool_calls=[], stop=True)

    manager = Agent(llm=_ManagerLLM(), tools=[], name="manager")
    worker = echo_agent("worker")
    crew = Crew.with_manager(manager=manager, workers=[worker])

    result = await crew.run("do the thing")

    assert result == "worker said: do the thing"


@pytest.mark.asyncio
async def test_parallel_runs_every_agent_and_merges_under_a_heading():
    crew = Crew.parallel([text_agent("alpha", "a-output"), text_agent("beta", "b-output")])

    result = await crew.run("start")

    assert "## alpha\na-output" in result
    assert "## beta\nb-output" in result


@pytest.mark.asyncio
async def test_parallel_accepts_a_custom_merge_function():
    crew = Crew.parallel(
        [text_agent("alpha", "a-output"), text_agent("beta", "b-output")],
        merge=lambda results: " | ".join(text for _name, text in results),
    )

    result = await crew.run("start")

    assert result == "a-output | b-output"


@pytest.mark.asyncio
async def test_loop_until_stops_as_soon_as_the_predicate_is_satisfied():
    llm = ScriptedLLM([LLMTurn(text=str(i), tool_calls=[], stop=True) for i in range(1, 6)])
    agent = Agent(llm=llm, tools=[])
    crew = Crew.loop_until(agent=agent, until=lambda result, _iteration: result == "3")

    result = await crew.run("0")

    assert result == "3"
    assert llm.call_count == 3


@pytest.mark.asyncio
async def test_loop_until_stops_at_max_iterations_if_the_predicate_never_fires():
    llm = ScriptedLLM([LLMTurn(text="never", tool_calls=[], stop=True) for _ in range(3)])
    agent = Agent(llm=llm, tools=[])
    crew = Crew.loop_until(agent=agent, until=lambda _result, _iteration: False, max_iterations=3)

    result = await crew.run("start")

    assert result == "never"
    assert llm.call_count == 3


@pytest.mark.asyncio
async def test_loop_until_resumes_from_a_saved_iteration_count(tmp_path):
    store = crew_checkpoint_store(tmp_path)
    await store.save(
        CheckpointedCrewRun(
            run_id=checkpoint_key_for("run-2"), kind="loop_until", status="running", completed_steps=2, state="1"
        )
    )
    llm = ScriptedLLM([LLMTurn(text="2", tool_calls=[], stop=True)])
    agent = Agent(llm=llm, tools=[])
    crew = Crew.loop_until(agent=agent, until=lambda result, _iteration: True, checkpoint=store, run_id="run-2")

    result = await crew.run("start")

    assert result == "2"
    assert llm.call_count == 1


@pytest.mark.asyncio
async def test_route_runs_only_the_matching_branch():
    class _RouterLLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            return LLMTurn(text="billing", tool_calls=[], stop=True)

    router = Agent(llm=_RouterLLM(), tools=[], name="router")
    billing = text_agent("billing-agent", "billing answer")
    tech = text_agent("tech-agent", "tech answer")
    crew = Crew.route(router=router, routes={"billing": billing, "technical": tech})

    result = await crew.run("where is my invoice?")

    assert result == "billing answer"


@pytest.mark.asyncio
async def test_route_falls_back_when_the_router_answer_matches_no_route():
    class _RouterLLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            return LLMTurn(text="something else entirely", tool_calls=[], stop=True)

    router = Agent(llm=_RouterLLM(), tools=[], name="router")
    fallback = text_agent("fallback-agent", "fallback answer")
    crew = Crew.route(router=router, routes={"billing": text_agent("billing", "x")}, fallback=fallback)

    result = await crew.run("???")

    assert result == "fallback answer"


@pytest.mark.asyncio
async def test_route_raises_when_no_route_matches_and_no_fallback_is_given():
    class _RouterLLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            return LLMTurn(text="nonexistent-label", tool_calls=[], stop=True)

    router = Agent(llm=_RouterLLM(), tools=[], name="router")
    crew = Crew.route(router=router, routes={"billing": text_agent("billing", "x")})

    with pytest.raises(ValueError, match="matches none of"):
        await crew.run("???")


@pytest.mark.asyncio
async def test_pipeline_threads_state_across_steps():
    async def step_one(state, run_id):
        return {"first": "a"}

    def step_two(state, run_id):
        return {"second": state["first"] + "b"}

    crew = Crew.pipeline([step_one, step_two])

    result = await crew.run({})

    assert result == {"first": "a", "second": "ab"}


@pytest.mark.asyncio
async def test_pipeline_resumes_past_a_step_that_would_otherwise_explode(tmp_path):
    store = crew_checkpoint_store(tmp_path)
    await store.save(
        CheckpointedCrewRun(
            run_id=checkpoint_key_for("run-3"), kind="pipeline", status="running", completed_steps=1, state={"first": "a"}
        )
    )

    def exploding_step(state, run_id):
        raise AssertionError("this step should never run — resume should have skipped it")

    def step_two(state, run_id):
        return {"second": state["first"] + "b"}

    crew = Crew.pipeline([exploding_step, step_two], checkpoint=store, run_id="run-3")

    result = await crew.run({"first": "a"})

    assert result == {"first": "a", "second": "ab"}
