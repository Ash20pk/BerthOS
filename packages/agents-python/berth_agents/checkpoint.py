"""The persistence seam Agent.run()/resume() write through — mirrors
@berth/agents' checkpoint.ts's CheckpointStore interface (save/load by id),
deliberately narrow enough that a backend other than Semantic FS can
implement it. There's no Python-reachable Computer/Semantic FS yet (see
docs/agents-python-reference.md — driving a Berth sandbox from Python needs
either a Docker-Engine-API client or an always-on HTTP RPC bridge, neither
built yet), so this slice ships a real local-filesystem-backed store instead
of a create_semantic_fs_checkpoint_store() equivalent — same interface, a
different, honestly-named backend."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

from .types import AgentMessage, ExecutedToolCall, ToolCall, ToolResult

CheckpointStatus = Literal["running", "done", "error"]


@dataclass
class CheckpointedRun:
    run_id: str
    agent_name: str
    status: CheckpointStatus
    # Index of the next turn to execute — where resume() picks the tool-use loop back up.
    turn_count: int
    messages: list[AgentMessage] = field(default_factory=list)
    tool_calls: list[ExecutedToolCall] = field(default_factory=list)
    # Set once status is "done" — the final answer, so resuming an already-finished run is a plain read, not a replay.
    text: str | None = None


class CheckpointStore(Protocol):
    """Generic over the checkpoint shape so the same seam also serves
    Crew-level composition checkpoints (crew.py's CrewCheckpoint) — one
    storage concept, not two, mirroring CheckpointStore<T> in checkpoint.ts."""

    async def save(self, checkpoint: Any) -> None: ...

    async def load(self, run_id: str) -> Any | None: ...


def _checkpointed_run_to_dict(checkpoint: CheckpointedRun) -> dict[str, Any]:
    return asdict(checkpoint)


def _checkpointed_run_from_dict(data: dict[str, Any]) -> CheckpointedRun:
    messages = [
        AgentMessage(
            role=m["role"],
            text=m.get("text"),
            tool_calls=[ToolCall(**c) for c in m["tool_calls"]] if m.get("tool_calls") else None,
            tool_result=ToolResult(**m["tool_result"]) if m.get("tool_result") else None,
        )
        for m in data["messages"]
    ]
    tool_calls = [ExecutedToolCall(**c) for c in data["tool_calls"]]
    return CheckpointedRun(
        run_id=data["run_id"],
        agent_name=data["agent_name"],
        status=data["status"],
        turn_count=data["turn_count"],
        messages=messages,
        tool_calls=tool_calls,
        text=data.get("text"),
    )


class FileCheckpointStore:
    """A CheckpointStore backed by plain JSON files on the local
    filesystem — one `<directory>/<run_id>.json` per run, the whole
    checkpoint serialized via dataclasses.asdict()/json.dumps(). Works for
    CheckpointedRun (the default, used directly) or, when constructed with
    to_dict/from_dict overrides, for any other `{run_id: str, ...}` shape
    (crew.py's CrewCheckpoint uses this to reuse the same store type)."""

    def __init__(
        self,
        directory: str | Path,
        *,
        to_dict=_checkpointed_run_to_dict,
        from_dict=_checkpointed_run_from_dict,
    ) -> None:
        self._directory = Path(directory)
        self._directory.mkdir(parents=True, exist_ok=True)
        self._to_dict = to_dict
        self._from_dict = from_dict

    def _path_for(self, run_id: str) -> Path:
        return self._directory / f"{run_id}.json"

    async def save(self, checkpoint: Any) -> None:
        path = self._path_for(checkpoint.run_id)
        path.write_text(json.dumps(self._to_dict(checkpoint)))

    async def load(self, run_id: str) -> Any | None:
        path = self._path_for(run_id)
        if not path.exists():
            return None
        return self._from_dict(json.loads(path.read_text()))
