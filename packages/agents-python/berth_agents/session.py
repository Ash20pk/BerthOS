"""Checkpointing (checkpoint.py) is durable *run* resume — the same logical
task, picked back up after a crash. A Session is a different thing
entirely: shared conversation history across *separate* run() calls (a chat
UI's turns, say), the seam OpenAI SDK Sessions, ADK's
SessionService/MemoryService, and CrewAI's short-term memory all cover. A
direct port of @berth/agents' session.ts. Deliberately narrow, the same
"save/load, nothing fancier" posture CheckpointStore has: no summarization,
no entity/long-term memory, no automatic trimming."""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any, Protocol

from .types import AgentMessage, ToolCall, ToolResult


class Session(Protocol):
    async def get_items(self) -> list[AgentMessage]:
        """Every item recorded so far, oldest first."""
        ...

    async def add_items(self, items: list[AgentMessage]) -> None:
        """Appends new items — never replaces what's already there."""
        ...

    async def clear(self) -> None:
        """Drops every item — starts the next run() call with no prior history."""
        ...


class InMemorySession:
    """The default, ephemeral backend — history lives only as long as this
    process does. Good for a dev loop or a single-process chat server; a
    restart loses it, same tradeoff any in-memory store has."""

    def __init__(self, initial: list[AgentMessage] | None = None) -> None:
        self._items: list[AgentMessage] = list(initial) if initial else []

    async def get_items(self) -> list[AgentMessage]:
        return list(self._items)

    async def add_items(self, items: list[AgentMessage]) -> None:
        self._items.extend(items)

    async def clear(self) -> None:
        self._items = []


def create_in_memory_session(initial: list[AgentMessage] | None = None) -> InMemorySession:
    return InMemorySession(initial)


_CONTEXT_DIR = "agent-sessions"


def _find_export_tool(tools: list[Any], export_name: str) -> Any:
    """Computer.connect() only ever reaches the single app `--http-rpc`
    designated, so — unlike TypeScript's findExportTool(), which also
    matches a `<app>__name`-namespaced tool for a multi-app Computer —
    every tool name here is already bare."""
    for tool in tools:
        if tool.name == export_name:
            return tool
    available = ", ".join(t.name for t in tools) or "(none)"
    raise RuntimeError(
        f'create_semantic_fs_session() needs a resident app exposing "{export_name}" '
        f"in this Computer's app list (apps/filesystem does) — got tools: {available}"
    )


class SemanticFsSession:
    """A Session backed by Semantic FS, reached the same way
    create_semantic_fs_checkpoint_store() would: through a resident app's
    write_context_file/read_context_file/tag_context_file exports. One JSON
    array per session_id at /context/agent-sessions/<session_id>.json,
    read-modify-write on every add_items() call. Resolves its three tools
    eagerly, at construction, so a Computer missing them fails fast rather
    than on the first get_items()/add_items() call deep inside a run."""

    def __init__(self, computer: Any, session_id: str) -> None:
        self._write_tool = _find_export_tool(computer.tools, "write_context_file")
        self._read_tool = _find_export_tool(computer.tools, "read_context_file")
        self._tag_tool = _find_export_tool(computer.tools, "tag_context_file")
        self._path = f"{_CONTEXT_DIR}/{session_id}.json"
        self._session_id = session_id

    async def get_items(self) -> list[AgentMessage]:
        try:
            result = await self._read_tool.invoke({"path": self._path})
            raw = json.loads(result["content"])
            return [_message_from_dict(item) for item in raw]
        except Exception:
            # Same "can't tell missing from a real read error" caveat
            # CheckpointStore.load() already has, for the same reason: a
            # resident-app export error crosses the RPC wire as a plain
            # string, not a typed error code.
            return []

    async def add_items(self, items: list[AgentMessage]) -> None:
        existing = await self.get_items()
        combined = existing + items
        await self._write_tool.invoke({"path": self._path, "content": json.dumps([asdict(m) for m in combined])})
        await self._tag_tool.invoke({"path": self._path, "task": self._session_id, "relatedApps": []})

    async def clear(self) -> None:
        await self._write_tool.invoke({"path": self._path, "content": "[]"})


def _message_from_dict(data: dict[str, Any]) -> AgentMessage:
    # Same reconstruction checkpoint.py's _checkpointed_run_from_dict() does
    # for its own `messages` field — dataclasses.asdict() flattens
    # ToolCall/ToolResult into plain dicts on the way out, so they need
    # rebuilding into real dataclass instances on the way back in.
    return AgentMessage(
        role=data["role"],
        text=data.get("text"),
        tool_calls=[ToolCall(**c) for c in data["tool_calls"]] if data.get("tool_calls") else None,
        tool_result=ToolResult(**data["tool_result"]) if data.get("tool_result") else None,
    )


def create_semantic_fs_session(computer: Any, session_id: str) -> SemanticFsSession:
    return SemanticFsSession(computer, session_id)
