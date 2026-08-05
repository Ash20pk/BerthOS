import { test } from "node:test";
import assert from "node:assert/strict";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createOtelStepTracer } from "./otel-tracer.js";
import type { AgentStepEvent } from "./tracing.js";

/**
 * A real OpenTelemetry SDK pipeline (BasicTracerProvider + a real
 * SimpleSpanProcessor + InMemorySpanExporter), registered as the actual
 * global tracer provider `@opentelemetry/api`'s `trace.getTracer()` reads
 * from — not a mock of the OTel API. Proves createOtelStepTracer() produces
 * real, correctly-shaped spans a real SDK/exporter pipeline would receive.
 */
function withRealOtelPipeline(fn: (exporter: InMemorySpanExporter) => Promise<void>) {
  return async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    try {
      await fn(exporter);
    } finally {
      trace.disable();
      await provider.shutdown();
    }
  };
}

test(
  "emits a real span for an llm-turn event with GenAI-convention attributes",
  withRealOtelPipeline(async (exporter) => {
    const tracer = createOtelStepTracer();
    const event: AgentStepEvent = {
      runId: "run-1",
      agentName: "my-agent",
      turn: 0,
      kind: "llm-turn",
      durationMs: 150,
      usage: { inputTokens: 10, outputTokens: 5 },
    };

    await tracer.emit(event);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const span = spans[0]!;
    assert.equal(span.name, "chat my-agent");
    assert.equal(span.attributes["gen_ai.operation.name"], "chat");
    assert.equal(span.attributes["gen_ai.agent.name"], "my-agent");
    assert.equal(span.attributes["berth.run_id"], "run-1");
    assert.equal(span.attributes["berth.turn"], 0);
    assert.equal(span.attributes["gen_ai.usage.input_tokens"], 10);
    assert.equal(span.attributes["gen_ai.usage.output_tokens"], 5);
    assert.equal(span.status.code, SpanStatusCode.OK);
  }),
);

test(
  "emits a real span for a tool-call event, named and tagged with the tool",
  withRealOtelPipeline(async (exporter) => {
    const tracer = createOtelStepTracer();
    await tracer.emit({
      runId: "run-1",
      agentName: "my-agent",
      turn: 1,
      kind: "tool-call",
      toolName: "search",
      durationMs: 42,
    });

    const span = exporter.getFinishedSpans()[0]!;
    assert.equal(span.name, "execute_tool search");
    assert.equal(span.attributes["gen_ai.operation.name"], "execute_tool");
    assert.equal(span.attributes["gen_ai.tool.name"], "search");
    assert.equal(span.attributes["gen_ai.usage.input_tokens"], undefined, "tool-call events carry no usage");
  }),
);

test(
  "records an error status and exception when the event carries one",
  withRealOtelPipeline(async (exporter) => {
    const tracer = createOtelStepTracer();
    await tracer.emit({
      runId: "run-1",
      agentName: "my-agent",
      turn: 2,
      kind: "tool-call",
      toolName: "boom",
      durationMs: 5,
      error: "kaboom",
    });

    const span = exporter.getFinishedSpans()[0]!;
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, "kaboom");
    assert.equal(span.events.some((e) => e.name === "exception"), true);
  }),
);

test(
  "backdates the span's start time using durationMs, since emit() fires after the step already finished",
  withRealOtelPipeline(async (exporter) => {
    const tracer = createOtelStepTracer();
    const before = Date.now();
    await tracer.emit({ runId: "run-1", agentName: "a", turn: 0, kind: "llm-turn", durationMs: 1000 });
    const after = Date.now();

    const span = exporter.getFinishedSpans()[0]!;
    const [startSeconds, startNanos] = span.startTime;
    const startMs = startSeconds * 1000 + startNanos / 1e6;
    // The span should have started ~1000ms before "now" (when emit() ran), not at emit()-call time.
    assert.ok(startMs <= before - 1000 + 50, `expected a backdated start time, got ${startMs} vs before=${before}`);
    assert.ok(startMs >= before - 1000 - 50, `expected a backdated start time, got ${startMs} vs before=${before}`);
    void after;
  }),
);

test(
  "respects a custom tracerName",
  withRealOtelPipeline(async (exporter) => {
    const tracer = createOtelStepTracer({ tracerName: "my-custom-scope" });
    await tracer.emit({ runId: "run-1", agentName: "a", turn: 0, kind: "llm-turn", durationMs: 1 });

    const span = exporter.getFinishedSpans()[0]!;
    assert.equal(span.instrumentationScope.name, "my-custom-scope");
  }),
);
