"""Mirrors @berth/agents' tracing.ts's core AgentStepEvent/StepTracer seam —
only the OTel backend (otel_tracer.py) is ported so far. The Context
Bus/Semantic FS backends (create_context_bus_step_tracer()/
create_semantic_fs_step_tracer()/create_agent_tracer()/read_agent_trace()/
list_agent_traces()) need a Python-reachable Computer exposing specific
resident-app exports — the same boundary checkpointing/retrieval originally
had before Computer.connect() existed — and aren't built yet; a real,
tractable follow-up now that computer.py exists, not a new blocker."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .types import Usage

StepKind = Literal["llm-turn", "tool-call"]


@dataclass
class AgentStepEvent:
    run_id: str
    agent_name: str
    # Index of the turn this step happened in — same numbering as CheckpointedRun.turn_count.
    turn: int
    kind: StepKind
    duration_ms: float
    # Set only on kind "tool-call".
    tool_name: str | None = None
    # Set when the LLM call or tool.invoke() raised — the same message Agent.run()'s {error} tool result carries for tool-calls.
    error: str | None = None
    # Set only on kind "llm-turn", when the LLMProvider reports it (LLMTurn.usage) — absent, not zero, for a provider that doesn't.
    usage: Usage | None = None


class StepTracer(Protocol):
    async def emit(self, event: AgentStepEvent) -> None: ...
