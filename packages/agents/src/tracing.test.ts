import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputerHandle } from "./computer.js";
import type { Tool } from "./types.js";
import {
  createAgentTracer,
  createContextBusStepTracer,
  createSemanticFsStepTracer,
  readAgentTrace,
  listAgentTraces,
  type AgentStepEvent,
} from "./tracing.js";

function fakeTool(name: string, invoke: Tool["invoke"]): Tool {
  return { name, description: "", inputSchema: {}, invoke };
}

function fakeComputer(tools: Tool[]): ComputerHandle {
  return {
    tools,
    call: async (toolName, input) => {
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) throw new Error(`no such tool "${toolName}"`);
      return tool.invoke(input);
    },
    stop: async () => {},
  };
}

function sampleEvent(overrides: Partial<AgentStepEvent> = {}): AgentStepEvent {
  return { runId: "run-1", agentName: "agent", turn: 0, kind: "llm-turn", durationMs: 12, ...overrides };
}

/**
 * A minimal in-memory stand-in for Semantic FS's write/read/tag/query
 * quartet — enough to exercise listAgentTraces()' actual query_context call
 * (matching on relatedApps, the way the real keyword-overlap ranking would
 * for an exact marker string) without needing the real daemon.
 */
function fakeSemanticFs(): Tool[] {
  const files = new Map<string, string>();
  const tags = new Map<string, { task?: string; relatedApps?: string[]; updatedAt: number }>();
  let clock = 0;
  return [
    fakeTool("write_context_file", async (input) => {
      const { path, content } = input as { path: string; content: string };
      files.set(path, content);
    }),
    fakeTool("read_context_file", async (input) => {
      const { path } = input as { path: string };
      if (!files.has(path)) throw new Error("ENOENT");
      return { content: files.get(path) };
    }),
    fakeTool("tag_context_file", async (input) => {
      const { path, task, relatedApps } = input as { path: string; task?: string; relatedApps?: string[] };
      clock++;
      tags.set(path, { task, relatedApps, updatedAt: clock });
    }),
    fakeTool("query_context", async (input) => {
      const { text } = input as { text: string };
      const results = [...tags.entries()]
        .filter(([, meta]) => meta.task === text || meta.relatedApps?.includes(text))
        .map(([path, meta]) => ({ path, task: meta.task, relatedApps: meta.relatedApps, updatedAt: meta.updatedAt }));
      return { results };
    }),
  ];
}

test("createContextBusStepTracer throws immediately when the Computer has no publish_context_event tool", () => {
  const computer = fakeComputer([]);
  assert.throws(() => createContextBusStepTracer(computer), /publish_context_event/);
});

test("createContextBusStepTracer.emit() publishes the event as the payload on topic agent.step", async () => {
  const published: { topic: string; payload: unknown }[] = [];
  const computer = fakeComputer([
    fakeTool("publish_context_event", async (input) => {
      published.push(input as { topic: string; payload: unknown });
    }),
  ]);

  const tracer = createContextBusStepTracer(computer);
  const event = sampleEvent();
  await tracer.emit(event);

  assert.equal(published.length, 1);
  assert.equal(published[0]!.topic, "agent.step");
  assert.deepEqual(published[0]!.payload, event);
});

test("createSemanticFsStepTracer throws immediately when the Computer is missing any of the three context-file tools", () => {
  const computer = fakeComputer([fakeTool("write_context_file", async () => {})]);
  assert.throws(() => createSemanticFsStepTracer(computer), /read_context_file/);
});

test("createSemanticFsStepTracer.emit() appends to a single per-runId file, readable back via readAgentTrace()", async () => {
  const files = new Map<string, string>();
  const tagCalls: unknown[] = [];
  const computer = fakeComputer([
    fakeTool("write_context_file", async (input) => {
      const { path, content } = input as { path: string; content: string };
      files.set(path, content);
    }),
    fakeTool("read_context_file", async (input) => {
      const { path } = input as { path: string };
      if (!files.has(path)) throw new Error("ENOENT");
      return { content: files.get(path) };
    }),
    fakeTool("tag_context_file", async (input) => {
      tagCalls.push(input);
    }),
  ]);

  const tracer = createSemanticFsStepTracer(computer);
  await tracer.emit(sampleEvent({ turn: 0, kind: "llm-turn" }));
  await tracer.emit(sampleEvent({ turn: 0, kind: "tool-call", toolName: "search" }));

  const trace = await readAgentTrace(computer, "run-1");
  assert.equal(trace.length, 2);
  assert.equal(trace[0]!.kind, "llm-turn");
  assert.equal(trace[1]!.kind, "tool-call");
  assert.equal(trace[1]!.toolName, "search");
  assert.equal(tagCalls.length, 2, "each emit() tags the file again, same as CheckpointStore.save()");
});

test("readAgentTrace() returns [] (not an error) when nothing has been traced for that runId", async () => {
  const computer = fakeComputer([
    fakeTool("read_context_file", async () => {
      throw new Error("ENOENT: no such file");
    }),
  ]);

  assert.deepEqual(await readAgentTrace(computer, "never-traced"), []);
});

test("createAgentTracer.emit() writes to both the Context Bus and Semantic FS", async () => {
  const published: unknown[] = [];
  const files = new Map<string, string>();
  const computer = fakeComputer([
    fakeTool("publish_context_event", async (input) => {
      published.push(input);
    }),
    fakeTool("write_context_file", async (input) => {
      const { path, content } = input as { path: string; content: string };
      files.set(path, content);
    }),
    fakeTool("read_context_file", async (input) => {
      const { path } = input as { path: string };
      if (!files.has(path)) throw new Error("ENOENT");
      return { content: files.get(path) };
    }),
    fakeTool("tag_context_file", async () => {}),
  ]);

  const tracer = createAgentTracer(computer);
  await tracer.emit(sampleEvent());

  assert.equal(published.length, 1);
  assert.equal((await readAgentTrace(computer, "run-1")).length, 1);
});

test("createAgentTracer throws immediately if any of the four required tools is missing", () => {
  const computer = fakeComputer([
    fakeTool("write_context_file", async () => {}),
    fakeTool("read_context_file", async () => ({ content: "[]" })),
    fakeTool("tag_context_file", async () => {}),
    // publish_context_event missing
  ]);

  assert.throws(() => createAgentTracer(computer), /publish_context_event/);
});

test("listAgentTraces() returns [] when nothing has ever been traced", async () => {
  const computer = fakeComputer(fakeSemanticFs());
  assert.deepEqual(await listAgentTraces(computer), []);
});

test("listAgentTraces() finds every traced runId without needing any of them up front, newest first", async () => {
  const computer = fakeComputer(fakeSemanticFs());
  const tracer = createSemanticFsStepTracer(computer);

  await tracer.emit(sampleEvent({ runId: "run-older" }));
  await tracer.emit(sampleEvent({ runId: "run-newer" }));

  const traces = await listAgentTraces(computer);

  assert.deepEqual(
    traces.map((t) => t.runId),
    ["run-newer", "run-older"],
  );
});

test("listAgentTraces() respects limit", async () => {
  const computer = fakeComputer(fakeSemanticFs());
  const tracer = createSemanticFsStepTracer(computer);

  await tracer.emit(sampleEvent({ runId: "run-a" }));
  await tracer.emit(sampleEvent({ runId: "run-b" }));
  await tracer.emit(sampleEvent({ runId: "run-c" }));

  const traces = await listAgentTraces(computer, { limit: 2 });

  assert.equal(traces.length, 2);
});
