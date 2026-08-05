import dataclasses

import pytest

from berth_agents.checkpoint import CheckpointedRun, FileCheckpointStore
from berth_agents.crew import CheckpointedCrewRun
from berth_agents.types import AgentMessage, ExecutedToolCall, ToolCall, ToolResult


@pytest.mark.asyncio
async def test_round_trips_a_checkpointed_run(tmp_path):
    store = FileCheckpointStore(tmp_path)
    checkpoint = CheckpointedRun(
        run_id="run-1",
        agent_name="worker",
        status="running",
        turn_count=2,
        messages=[
            AgentMessage(role="user", text="hi"),
            AgentMessage(role="assistant", tool_calls=[ToolCall(id="1", name="search", input={"q": "x"})]),
            AgentMessage(role="tool", tool_result=ToolResult(id="1", name="search", output={"ok": True})),
        ],
        tool_calls=[ExecutedToolCall(name="search", input={"q": "x"}, result={"ok": True})],
    )

    await store.save(checkpoint)
    loaded = await store.load("run-1")

    assert loaded == checkpoint


@pytest.mark.asyncio
async def test_load_returns_none_for_an_unknown_run_id(tmp_path):
    store = FileCheckpointStore(tmp_path)

    assert await store.load("nonexistent") is None


@pytest.mark.asyncio
async def test_a_done_checkpoint_carries_its_final_text(tmp_path):
    store = FileCheckpointStore(tmp_path)
    checkpoint = CheckpointedRun(run_id="run-2", agent_name="worker", status="done", turn_count=1, text="the answer")

    await store.save(checkpoint)
    loaded = await store.load("run-2")

    assert loaded.status == "done"
    assert loaded.text == "the answer"


@pytest.mark.asyncio
async def test_file_checkpoint_store_also_serves_crew_level_checkpoints(tmp_path):
    store = FileCheckpointStore(
        tmp_path,
        to_dict=dataclasses.asdict,
        from_dict=lambda d: CheckpointedCrewRun(**d),
    )
    checkpoint = CheckpointedCrewRun(run_id="crew__run-3", kind="sequential", status="running", completed_steps=1, state="partial")

    await store.save(checkpoint)
    loaded = await store.load("crew__run-3")

    assert loaded == checkpoint
