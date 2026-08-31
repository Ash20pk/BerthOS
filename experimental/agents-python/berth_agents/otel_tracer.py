"""A fourth StepTracer backend, alongside Context Bus/Semantic FS/both
(create_agent_tracer() in TypeScript's tracing.ts — not yet ported to
Python, see docs/agents-python-reference.md) — this one doesn't store
anything itself. It emits real spans through opentelemetry-api's global
tracer, so whatever OTel SDK + exporter you configure (Langfuse, Phoenix,
Honeycomb, Datadog, a plain OTel Collector, ...) receives them.
opentelemetry-api alone has no exporter and does nothing without a real SDK
registered — wiring one up is on the caller. Mirrors @berth/agents'
otel-tracer.ts field-for-field."""

from __future__ import annotations

import time
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import StatusCode

from .tracing import AgentStepEvent


def _now_ns() -> int:
    return time.time_ns()


class OtelStepTracer:
    """Attribute names follow the OTel GenAI semantic conventions
    (https://opentelemetry.io/docs/specs/semconv/gen-ai/) where one
    applies — hand-written as literal strings rather than importing
    opentelemetry-semantic-conventions' GenAI constants, which are still
    marked experimental/unstable and move between module paths across SDK
    versions; the attribute name strings themselves are what's actually
    stable across a semconv version."""

    def __init__(self, tracer_name: str = "berth_agents") -> None:
        self._tracer = trace.get_tracer(tracer_name)

    async def emit(self, event: AgentStepEvent) -> None:
        end_time = _now_ns()
        start_time = end_time - event.duration_ms * 1_000_000

        if event.kind == "llm-turn":
            span_name = f"chat {event.agent_name}"
            operation = "chat"
        else:
            span_name = f"execute_tool {event.tool_name or 'unknown'}"
            operation = "execute_tool"

        attributes: dict[str, Any] = {
            "gen_ai.operation.name": operation,
            "gen_ai.agent.name": event.agent_name,
            # Not part of any OTel semantic convention — Berth-specific, and
            # the one thing that lets a backend correlate every span from
            # the same Agent.run()/Crew composition. There's no single
            # parent span linking them: emit() has no signal for when a run
            # begins or ends to build one.
            "berth.run_id": event.run_id,
            "berth.turn": event.turn,
        }
        if event.tool_name:
            attributes["gen_ai.tool.name"] = event.tool_name
        if event.usage:
            attributes["gen_ai.usage.input_tokens"] = event.usage.input_tokens
            attributes["gen_ai.usage.output_tokens"] = event.usage.output_tokens

        span = self._tracer.start_span(span_name, start_time=start_time, attributes=attributes)
        if event.error:
            span.record_exception(Exception(event.error), timestamp=end_time)
            span.set_status(StatusCode.ERROR, event.error)
        else:
            span.set_status(StatusCode.OK)
        span.end(end_time)


def create_otel_step_tracer(*, tracer_name: str = "berth_agents") -> OtelStepTracer:
    return OtelStepTracer(tracer_name=tracer_name)
