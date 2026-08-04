"""Multi-agent composition — wiring over Agent, not a new execution
primitive. Mirrors Crew.sequential from @berth/agents' crew.ts; the other
five Crew shapes there (parallel, loop_until, route, with_manager, networked)
aren't ported in this first slice — see docs/agents-python-reference.md."""

from __future__ import annotations

from .agent import Agent
from .types import CrewRun


class Crew:
    @staticmethod
    def sequential(agents: list[Agent]) -> CrewRun:
        """Pipes each agent's output text as the next agent's input; returns
        the last agent's output (or the original input unchanged, for an
        empty list)."""

        async def run(input: str) -> str:
            current = input
            for agent in agents:
                result = await agent.run(current)
                current = result.text
            return current

        return CrewRun(_run=run)
