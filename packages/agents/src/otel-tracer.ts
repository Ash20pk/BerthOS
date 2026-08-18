import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import type { AgentStepEvent, StepTracer } from "./tracing.js";

export interface OtelStepTracerOptions {
  /** Registered as the instrumentation scope name with the global TracerProvider — cosmetic, shows up in most backends' UI as "where this span came from." */
  tracerName?: string;
}

/**
 * A fourth `StepTracer` backend, alongside Context Bus/Semantic FS/both
 * (`createAgentTracer()`) — this one doesn't store anything itself. It emits
 * real spans through `@opentelemetry/api`'s global tracer, so whatever OTel
 * SDK + exporter *you* configure (Langfuse, Phoenix, Honeycomb, Datadog, a
 * plain OTel Collector, ...) receives them. `@opentelemetry/api` alone has
 * no exporter and does nothing without a real SDK registered — same
 * "instrumentation library, not a vendored backend" posture every other
 * OTel-emitting library has; wiring up `@opentelemetry/sdk-node` (or
 * whatever your own app already uses) is on the caller, not this package.
 *
 * Attribute names follow the OTel GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/) where one applies —
 * hand-written as literal strings rather than importing
 * `@opentelemetry/semantic-conventions`'s GenAI constants, which are still
 * marked experimental/unstable and move between package paths across SDK
 * versions; the attribute name strings themselves are what's actually
 * stable across a semconv version, so this is the safer dependency to take.
 */
export function createOtelStepTracer(options: OtelStepTracerOptions = {}): StepTracer {
  const tracer = trace.getTracer(options.tracerName ?? "@berth/agents");

  return {
    async emit(event: AgentStepEvent): Promise<void> {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - event.durationMs);
      // The two-way ternary this replaces labelled anything that wasn't an
      // llm-turn as `execute_tool unknown`, so the compaction events
      // REMEDIATION 4.1 added would have arrived in every backend as
      // phantom tool calls to a tool named "unknown".
      const spanName =
        event.kind === "llm-turn"
          ? `chat ${event.agentName}`
          : event.kind === "tool-call"
            ? `execute_tool ${event.toolName ?? "unknown"}`
            : `compact_context ${event.agentName}`;

      const attributes: Attributes = {
        "gen_ai.agent.name": event.agentName,
        // Not part of any OTel semantic convention — Berth-specific, and
        // the one thing that lets a backend correlate every span from the
        // same Agent.run()/Crew composition. See the module doc comment in
        // tracing.ts for why there's no single parent span linking them:
        // emit() has no signal for when a run begins or ends to build one.
        "berth.run_id": event.runId,
        "berth.turn": event.turn,
      };
      // Only the two operations the GenAI semantic conventions actually
      // define get a `gen_ai.operation.name`. Compaction has no equivalent
      // there, and inventing a value would put a non-standard string in the
      // one attribute backends switch on to classify a span.
      if (event.kind === "llm-turn") attributes["gen_ai.operation.name"] = "chat";
      if (event.kind === "tool-call") attributes["gen_ai.operation.name"] = "execute_tool";
      if (event.droppedMessages !== undefined) attributes["berth.dropped_messages"] = event.droppedMessages;
      if (event.toolName) attributes["gen_ai.tool.name"] = event.toolName;
      if (event.usage) {
        attributes["gen_ai.usage.input_tokens"] = event.usage.inputTokens;
        attributes["gen_ai.usage.output_tokens"] = event.usage.outputTokens;
      }

      const span = tracer.startSpan(spanName, { startTime, attributes });
      if (event.error) {
        span.recordException(event.error, endTime);
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(endTime);
    },
  };
}
