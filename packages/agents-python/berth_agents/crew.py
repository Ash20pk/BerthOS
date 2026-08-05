"""Multi-agent composition — wiring over Agent, not a new execution
primitive: Agent's tool-use loop is identical whether its tools are hand-
built or other agents. Mirrors @berth/agents' crew.ts: `sequential`,
`with_manager`, `parallel`, `loop_until`, `route`, and `pipeline` are all
ported; `networked` isn't, since it needs independent agent-computers
(bootNetworkedAgent()) — a Computer/Docker concept this package doesn't
have yet. See docs/agents-python-reference.md."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Generic, Literal, TypeVar

from pydantic import BaseModel

from .agent import Agent, DEFAULT_MAX_REPAIR_ATTEMPTS
from .checkpoint import CheckpointStore
from .structured_output import StructuredOutputError, parse_structured_output, structured_output_repair_prompt
from .types import CrewRun

S = TypeVar("S")


@dataclass
class CheckpointedCrewRun(Generic[S]):
    """The composition-level counterpart to Agent's own CheckpointedRun —
    mirrors CrewCheckpoint<S> in crew.ts. `state` is whatever the
    composition threads between steps (a `str` for sequential/loop_until,
    the typed state dict for pipeline). Reuses the exact same CheckpointStore
    seam Agent itself uses — a caller wanting Crew-level checkpointing wires
    a FileCheckpointStore(dir, to_dict=lambda c: dataclasses.asdict(c),
    from_dict=lambda d: CheckpointedCrewRun(**d)) instead of the default
    CheckpointedRun-shaped one."""

    run_id: str
    kind: str
    status: Literal["running", "done", "error"]
    # Index of the next step to run — where a resumed run picks back up.
    completed_steps: int
    state: Any


def checkpoint_key_for(run_id: str) -> str:
    """Crew's own checkpoint is stored under a key namespaced away from the
    bare run_id — run_id itself may also be handed to a step's own Agent
    for its own, independent checkpoint store; namespacing Crew's key avoids
    the two colliding on the same storage path."""
    return f"crew__{run_id}"


async def _load_crew_checkpoint(checkpoint: CheckpointStore | None, run_id: str | None):
    if not checkpoint or not run_id:
        return None
    return await checkpoint.load(checkpoint_key_for(run_id))


async def _save_crew_checkpoint(
    checkpoint: CheckpointStore | None,
    run_id: str | None,
    *,
    kind: str,
    status: str,
    completed_steps: int,
    state: Any,
) -> None:
    if not checkpoint or not run_id:
        return
    await checkpoint.save(
        CheckpointedCrewRun(
            run_id=checkpoint_key_for(run_id),
            kind=kind,
            status=status,
            completed_steps=completed_steps,
            state=state,
        )
    )


async def _repair_structured_output(
    repair_agent: Agent,
    text: str,
    schema: type[BaseModel],
    max_repair_attempts: int,
    run_id: str | None,
    caller_name: str,
) -> str:
    """The Crew-level counterpart to Agent's own response_schema repair
    loop — reuses parse_structured_output()/structured_output_repair_prompt()
    /StructuredOutputError directly, re-running `repair_agent` (whichever
    Agent actually produced the composition's final text) instead of
    looping inside one Agent's own turn budget."""
    current = text
    success, _data, error = parse_structured_output(current, schema)
    attempts = 0
    while not success and attempts < max_repair_attempts:
        repaired = await repair_agent.run(structured_output_repair_prompt(error), run_id=run_id)
        current = repaired.text
        success, _data, error = parse_structured_output(current, schema)
        attempts += 1
    if not success:
        raise StructuredOutputError(
            f"{caller_name} failed to produce output matching response_schema after "
            f"{max_repair_attempts} repair attempt(s): {error}",
            current,
        )
    return current


def _default_parallel_merge(results: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"## {name}\n{text}" for name, text in results)


class CrewStateRun:
    def __init__(self, run: Callable[[dict], Awaitable[dict]]) -> None:
        self._run = run

    async def run(self, initial_state: dict) -> dict:
        return await self._run(initial_state)


class Crew:
    @staticmethod
    def sequential(
        agents: list[Agent],
        *,
        checkpoint: CheckpointStore | None = None,
        run_id: str | None = None,
        response_schema: type[BaseModel] | None = None,
        max_repair_attempts: int = DEFAULT_MAX_REPAIR_ATTEMPTS,
    ) -> CrewRun:
        """Pipes each agent's output text as the next agent's input; returns
        the last agent's output (or the input unchanged, for an empty
        list). `checkpoint`/`run_id` save which step just completed after
        every agent — a crash between two agents resumes from the next one
        instead of replaying the whole chain."""

        async def run(input: str) -> str:
            prior = await _load_crew_checkpoint(checkpoint, run_id)
            if prior and prior.status == "done":
                return prior.state
            start_index = prior.completed_steps if prior else 0
            current = prior.state if prior else input

            for i in range(start_index, len(agents)):
                result = await agents[i].run(current, run_id=run_id)
                current = result.text
                is_last_step = i == len(agents) - 1
                # The final step's checkpoint isn't saved as "done" until
                # after the optional repair pass below — a resumed run that
                # crashed mid-repair should re-attempt repair, not treat the
                # unrepaired text as already finished.
                await _save_crew_checkpoint(
                    checkpoint,
                    run_id,
                    kind="sequential",
                    status="done" if (is_last_step and not response_schema) else "running",
                    completed_steps=i + 1,
                    state=current,
                )

            if response_schema and agents:
                current = await _repair_structured_output(
                    agents[-1], current, response_schema, max_repair_attempts, run_id, "Crew.sequential"
                )
                await _save_crew_checkpoint(
                    checkpoint, run_id, kind="sequential", status="done", completed_steps=len(agents), state=current
                )

            return current

        return CrewRun(_run=run)

    @staticmethod
    def with_manager(*, manager: Agent, workers: list[Agent], run_id: str | None = None) -> CrewRun:
        """Gives the manager one Tool per worker (worker.as_tool()), so the
        manager's own LLM decides when/whether to delegate — the
        "agent-as-tool" pattern, reusing the exact same Tool dispatch path a
        plain hand-built tool uses."""
        worker_tools = [
            worker.as_tool(f'Delegate a task to the "{worker.name}" agent, then return what it reports back.')
            for worker in workers
        ]
        manager_with_tools = manager.with_tools(worker_tools)

        async def run(input: str) -> str:
            # Correlates only the manager's own turns/tool-calls under run_id
            # — a delegated worker.as_tool() call runs that worker via a
            # plain run(task) with no run_id of its own.
            result = await manager_with_tools.run(input, run_id=run_id)
            return result.text

        return CrewRun(_run=run)

    @staticmethod
    def parallel(
        agents: list[Agent],
        *,
        merge: Callable[[list[tuple[str, str]]], str] | None = None,
        run_id: str | None = None,
    ) -> CrewRun:
        """Runs every agent against the same input concurrently, then
        combines their outputs. Default `merge` concatenates each agent's
        output under a `## <name>` heading."""
        merge_fn = merge or _default_parallel_merge

        async def run(input: str) -> str:
            results = await asyncio.gather(*(agent.run(input, run_id=run_id) for agent in agents))
            return merge_fn([(agent.name, result.text) for agent, result in zip(agents, results)])

        return CrewRun(_run=run)

    @staticmethod
    def loop_until(
        *,
        agent: Agent,
        until: Callable[[str, int], bool],
        max_iterations: int = 10,
        checkpoint: CheckpointStore | None = None,
        run_id: str | None = None,
    ) -> CrewRun:
        """Runs `agent` repeatedly, feeding its own output back in as the
        next input. Checked *after* each run (so it always runs at least
        once), stops as soon as `until(result, iteration)` returns True, or
        after `max_iterations` (default 10) if it never does."""

        async def run(input: str) -> str:
            prior = await _load_crew_checkpoint(checkpoint, run_id)
            if prior and prior.status == "done":
                return prior.state
            start_iteration = prior.completed_steps if prior else 0
            current = prior.state if prior else input

            for iteration in range(start_iteration, max_iterations):
                result = await agent.run(current, run_id=run_id)
                current = result.text
                finished = until(current, iteration)
                await _save_crew_checkpoint(
                    checkpoint,
                    run_id,
                    kind="loop_until",
                    status="done" if finished else "running",
                    completed_steps=iteration + 1,
                    state=current,
                )
                if finished:
                    return current

            return current

        return CrewRun(_run=run)

    @staticmethod
    def route(
        *,
        router: Agent,
        routes: dict[str, Agent],
        fallback: Agent | None = None,
        run_id: str | None = None,
        response_schema: type[BaseModel] | None = None,
        max_repair_attempts: int = DEFAULT_MAX_REPAIR_ATTEMPTS,
    ) -> CrewRun:
        """Conditional branching: `router` is asked to classify the input as
        exactly one of `routes`'s keys, and only that one branch's agent
        runs against the *original* input. Falls back to `fallback` (or
        raises, naming what the router actually said) when its answer
        doesn't match any route."""

        async def run(input: str) -> str:
            labels = list(routes.keys())
            classification = await router.run(
                f"Classify the input below into exactly one of these labels: {', '.join(labels)}.\n"
                "Respond with only the label, nothing else.\n\n"
                f"Input:\n{input}",
                run_id=run_id,
            )
            answer = classification.text.strip()
            label = next((candidate for candidate in labels if candidate.lower() == answer.lower()), None)
            target = routes[label] if label else fallback
            if target is None:
                raise ValueError(
                    f'Crew.route: router "{router.name}" returned "{answer}", which matches none of '
                    f"[{', '.join(labels)}] and no fallback was given"
                )
            result = (await target.run(input, run_id=run_id)).text
            if response_schema:
                result = await _repair_structured_output(
                    target, result, response_schema, max_repair_attempts, run_id, "Crew.route"
                )
            return result

        return CrewRun(_run=run)

    @staticmethod
    def pipeline(
        steps: list[Callable[[dict, str | None], Any]],
        *,
        checkpoint: CheckpointStore | None = None,
        run_id: str | None = None,
    ) -> CrewStateRun:
        """Threads a typed state dict across steps instead of only a
        string — the gap sequential/parallel/loop_until/route all have,
        since they pipe plain text. Each step reads the accumulated state
        (built from every prior step's return, not just the last one) and
        returns a partial update merged shallowly into that state for the
        next step. Not a graph: steps still run in the fixed order given.
        A step is called as `step(state, run_id)` and may return a plain
        dict or an awaitable of one, matching a sync or async function."""

        async def run(initial_state: dict) -> dict:
            prior = await _load_crew_checkpoint(checkpoint, run_id)
            if prior and prior.status == "done":
                return prior.state
            start_index = prior.completed_steps if prior else 0
            state = dict(prior.state) if prior else dict(initial_state)

            for i in range(start_index, len(steps)):
                update = steps[i](state, run_id)
                if isinstance(update, Awaitable):
                    update = await update
                state = {**state, **update}
                await _save_crew_checkpoint(
                    checkpoint,
                    run_id,
                    kind="pipeline",
                    status="done" if i == len(steps) - 1 else "running",
                    completed_steps=i + 1,
                    state=state,
                )

            return state

        return CrewStateRun(run)
