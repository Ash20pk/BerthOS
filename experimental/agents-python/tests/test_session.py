import pytest

from berth_agents import ToolCall, ToolResult, create_in_memory_session, create_semantic_fs_session
from berth_agents.types import AgentMessage


class FakeTool:
    def __init__(self, name, invoke):
        self.name = name
        self._invoke = invoke

    async def invoke(self, input):
        return await self._invoke(input)


class FakeComputer:
    def __init__(self, tools):
        self.tools = tools


async def _noop(input):
    pass


@pytest.mark.asyncio
async def test_in_memory_session_starts_empty_and_accumulates_items():
    session = create_in_memory_session()
    assert await session.get_items() == []

    await session.add_items([AgentMessage(role="user", text="hi")])
    await session.add_items([AgentMessage(role="assistant", text="hello")])

    assert await session.get_items() == [
        AgentMessage(role="user", text="hi"),
        AgentMessage(role="assistant", text="hello"),
    ]


@pytest.mark.asyncio
async def test_in_memory_session_accepts_initial_items():
    session = create_in_memory_session([AgentMessage(role="user", text="seed")])
    assert await session.get_items() == [AgentMessage(role="user", text="seed")]


@pytest.mark.asyncio
async def test_in_memory_session_clear_drops_every_item():
    session = create_in_memory_session([AgentMessage(role="user", text="seed")])
    await session.clear()
    assert await session.get_items() == []


@pytest.mark.asyncio
async def test_in_memory_session_get_items_returns_a_fresh_copy_not_a_live_reference():
    session = create_in_memory_session()
    first = await session.get_items()
    first.append(AgentMessage(role="user", text="mutated from outside"))
    assert await session.get_items() == []


def test_create_semantic_fs_session_raises_immediately_when_the_computer_has_no_required_tools():
    computer = FakeComputer([FakeTool("read_file", lambda input: {"content": ""})])
    with pytest.raises(RuntimeError, match="write_context_file"):
        create_semantic_fs_session(computer, "session-1")


@pytest.mark.asyncio
async def test_create_semantic_fs_session_round_trips_items_through_write_and_read():
    files: dict[str, str] = {}
    tag_calls = []

    async def write(input):
        files[input["path"]] = input["content"]

    async def read(input):
        if input["path"] not in files:
            raise RuntimeError("ENOENT")
        return {"content": files[input["path"]]}

    async def tag(input):
        tag_calls.append(input)

    computer = FakeComputer(
        [FakeTool("write_context_file", write), FakeTool("read_context_file", read), FakeTool("tag_context_file", tag)]
    )
    session = create_semantic_fs_session(computer, "session-1")
    assert await session.get_items() == []

    await session.add_items([AgentMessage(role="user", text="hi")])
    await session.add_items([AgentMessage(role="assistant", text="hello")])

    assert await session.get_items() == [
        AgentMessage(role="user", text="hi"),
        AgentMessage(role="assistant", text="hello"),
    ]
    assert len(tag_calls) == 2


@pytest.mark.asyncio
async def test_create_semantic_fs_session_get_items_returns_empty_list_when_nothing_saved():
    async def read(input):
        raise RuntimeError("ENOENT: no such file")

    computer = FakeComputer(
        [
            FakeTool("write_context_file", _noop),
            FakeTool("read_context_file", read),
            FakeTool("tag_context_file", _noop),
        ]
    )
    session = create_semantic_fs_session(computer, "never-saved")
    assert await session.get_items() == []


@pytest.mark.asyncio
async def test_create_semantic_fs_session_clear_writes_an_empty_array():
    files: dict[str, str] = {}

    async def write(input):
        files[input["path"]] = input["content"]

    async def read(input):
        if input["path"] not in files:
            raise RuntimeError("ENOENT")
        return {"content": files[input["path"]]}

    computer = FakeComputer(
        [FakeTool("write_context_file", write), FakeTool("read_context_file", read), FakeTool("tag_context_file", _noop)]
    )
    session = create_semantic_fs_session(computer, "session-1")
    await session.add_items([AgentMessage(role="user", text="hi")])
    await session.clear()

    assert await session.get_items() == []


@pytest.mark.asyncio
async def test_create_semantic_fs_session_round_trips_tool_calls_and_tool_results():
    files: dict[str, str] = {}

    async def write(input):
        files[input["path"]] = input["content"]

    async def read(input):
        if input["path"] not in files:
            raise RuntimeError("ENOENT")
        return {"content": files[input["path"]]}

    computer = FakeComputer(
        [FakeTool("write_context_file", write), FakeTool("read_context_file", read), FakeTool("tag_context_file", _noop)]
    )
    session = create_semantic_fs_session(computer, "session-1")

    await session.add_items(
        [
            AgentMessage(role="assistant", tool_calls=[ToolCall(id="1", name="search", input={"q": "x"})]),
            AgentMessage(role="tool", tool_result=ToolResult(id="1", name="search", output="result")),
        ]
    )

    items = await session.get_items()
    assert items[0].tool_calls == [ToolCall(id="1", name="search", input={"q": "x"})]
    assert items[1].tool_result == ToolResult(id="1", name="search", output="result")
