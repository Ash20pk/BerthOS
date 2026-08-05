import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent } from "./agent.js";
import type { CheckpointedRun, CheckpointStore } from "./checkpoint.js";
import type { AgentStepEvent, StepTracer } from "./tracing.js";
import { createInMemorySession } from "./session.js";
import { StructuredOutputError } from "./structured-output.js";
import type { LLMProvider, LLMTurn, Tool } from "./types.js";

function scriptedLLM(turns: LLMTurn[]): { llm: LLMProvider; callCount: () => number } {
  let i = 0;
  return {
    llm: {
      name: "fake",
      async chat() {
        const turn = turns[i];
        if (!turn) throw new Error("script exhausted — llm.chat() called more times than the test expected");
        i++;
        return turn;
      },
    },
    callCount: () => i,
  };
}

/** Each scripted turn also carries the text deltas its chatStream() should emit before resolving. */
function scriptedStreamingLLM(
  turns: { deltas: string[]; turn: LLMTurn }[],
): { llm: LLMProvider; chatCallCount: () => number; chatStreamCallCount: () => number } {
  let chatCalls = 0;
  let streamCalls = 0;
  return {
    llm: {
      name: "fake",
      async chat() {
        const scripted = turns[chatCalls];
        if (!scripted) throw new Error("script exhausted — llm.chat() called more times than the test expected");
        chatCalls++;
        return scripted.turn;
      },
      async chatStream(_params, onText) {
        const scripted = turns[streamCalls];
        if (!scripted) throw new Error("script exhausted — llm.chatStream() called more times than the test expected");
        streamCalls++;
        for (const delta of scripted.deltas) onText(delta);
        return scripted.turn;
      },
    },
    chatCallCount: () => chatCalls,
    chatStreamCallCount: () => streamCalls,
  };
}

function echoTool(name: string, result: unknown = "tool-result"): Tool {
  return { name, description: "", inputSchema: {}, invoke: async () => result };
}

function throwingTool(name: string, message: string): Tool {
  return {
    name,
    description: "",
    inputSchema: {},
    invoke: async () => {
      throw new Error(message);
    },
  };
}

function memoryStepTracer(): StepTracer & { events: AgentStepEvent[] } {
  const events: AgentStepEvent[] = [];
  return {
    events,
    async emit(event) {
      events.push(event);
    },
  };
}

function memoryCheckpointStore(): CheckpointStore & { saved: CheckpointedRun[] } {
  const byRunId = new Map<string, CheckpointedRun>();
  const saved: CheckpointedRun[] = [];
  return {
    saved,
    async save(checkpoint) {
      byRunId.set(checkpoint.runId, checkpoint);
      saved.push(checkpoint);
    },
    async load(runId) {
      return byRunId.get(runId) ?? null;
    },
  };
}

test("run() behaves exactly as before when no checkpoint store is configured", async () => {
  const { llm } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "search", input: {} }], stop: false },
    { text: "done", toolCalls: [], stop: true },
  ]);
  const agent = new Agent({ llm, tools: [echoTool("search")] });

  const result = await agent.run("do the thing");
  assert.equal(result.text, "done");
  assert.equal(result.toolCalls.length, 1);
});

test("run() with a checkpoint store + runId saves progress after every turn, ending in status done", async () => {
  const { llm } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "search", input: { q: "x" } }], stop: false },
    { text: "final answer", toolCalls: [], stop: true },
  ]);
  const checkpoint = memoryCheckpointStore();
  const agent = new Agent({ llm, tools: [echoTool("search")], checkpoint });

  const result = await agent.run("do the thing", { runId: "run-a" });

  assert.equal(result.text, "final answer");
  assert.equal(checkpoint.saved.length, 2, "one save after the tool-call turn, one after the final turn");
  assert.equal(checkpoint.saved[0]!.status, "running");
  assert.equal(checkpoint.saved[0]!.toolCalls.length, 1);
  assert.equal(checkpoint.saved[1]!.status, "done");
  assert.equal(checkpoint.saved[1]!.text, "final answer");
});

test("resume() picks the loop back up from the saved turn instead of replaying it", async () => {
  const checkpoint = memoryCheckpointStore();
  await checkpoint.save({
    runId: "run-b",
    agentName: "agent",
    status: "running",
    turnCount: 1,
    messages: [
      { role: "user", text: "do the thing" },
      { role: "assistant", toolCalls: [{ id: "1", name: "search", input: { q: "x" } }] },
      { role: "tool", toolResult: { id: "1", name: "search", output: "tool-result" } },
    ],
    toolCalls: [{ name: "search", input: { q: "x" }, result: "tool-result" }],
  });

  // Only one turn left in the script — if resume() replayed from scratch it
  // would need a second scripted turn for the already-completed tool call
  // and the fake LLM would throw "script exhausted".
  const { llm, callCount } = scriptedLLM([{ text: "final answer", toolCalls: [], stop: true }]);
  const agent = new Agent({ llm, tools: [echoTool("search")], checkpoint });

  const result = await agent.resume("run-b");

  assert.equal(callCount(), 1);
  assert.equal(result.text, "final answer");
  assert.equal(result.toolCalls.length, 1, "the tool call from before the crash is preserved, not re-executed");
});

test("resume() on an already-done checkpoint returns the stored answer without calling the LLM", async () => {
  const checkpoint = memoryCheckpointStore();
  await checkpoint.save({
    runId: "run-c",
    agentName: "agent",
    status: "done",
    turnCount: 2,
    messages: [],
    toolCalls: [],
    text: "already finished",
  });

  const { llm, callCount } = scriptedLLM([]);
  const agent = new Agent({ llm, tools: [], checkpoint });

  const result = await agent.resume("run-c");
  assert.equal(result.text, "already finished");
  assert.equal(callCount(), 0);
});

test("resume() throws a clear error when no checkpoint store is configured", async () => {
  const { llm } = scriptedLLM([]);
  const agent = new Agent({ llm, tools: [] });
  await assert.rejects(() => agent.resume("run-d"), /no checkpoint store configured/);
});

test("a tool call that throws feeds an {error} result back to the model instead of ending the run", async () => {
  const { llm, callCount } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "flaky", input: {} }], stop: false },
    { text: "recovered", toolCalls: [], stop: true },
  ]);
  const agent = new Agent({ llm, tools: [throwingTool("flaky", "boom")] });

  const result = await agent.run("do the thing");

  assert.equal(callCount(), 2, "the model gets a second turn instead of the run throwing");
  assert.equal(result.text, "recovered");
  assert.deepEqual(result.toolCalls[0]!.result, { error: "boom" });
});

test("a tool call that throws a real ZodError feeds back the reformatted per-field error, not the raw JSON array", async () => {
  const toolInputSchema = z.object({ path: z.string(), content: z.string() });
  const zodValidatedTool: Tool = {
    name: "write_file",
    description: "",
    inputSchema: {},
    invoke: async (input) => {
      const parsed = toolInputSchema.parse(input); // throws a real ZodError on bad input
      return { wrote: parsed.path };
    },
  };
  const { llm } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "write_file", input: { path: 123 } }], stop: false },
    { text: "recovered", toolCalls: [], stop: true },
  ]);
  const agent = new Agent({ llm, tools: [zodValidatedTool] });

  const result = await agent.run("write something");

  const { error } = result.toolCalls[0]!.result as { error: string };
  assert.match(error, /^path:/, "reformatted into the compact path: message shape, not the raw ZodError JSON");
  assert.ok(!error.trimStart().startsWith("["), "must not still be the raw JSON issues array");
});

test("resume() throws a clear error when the runId has no saved checkpoint", async () => {
  const { llm } = scriptedLLM([]);
  const agent = new Agent({ llm, tools: [], checkpoint: memoryCheckpointStore() });
  await assert.rejects(() => agent.resume("never-saved"), /no checkpoint found/);
});

test("exceeding maxTurns saves a status: error checkpoint before throwing", async () => {
  const { llm } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "search", input: {} }], stop: false },
    { toolCalls: [{ id: "2", name: "search", input: {} }], stop: false },
  ]);
  const checkpoint = memoryCheckpointStore();
  const agent = new Agent({ llm, tools: [echoTool("search")], checkpoint, maxTurns: 2 });

  await assert.rejects(() => agent.run("do the thing", { runId: "run-e" }), /exceeded its maxTurns/);

  const last = checkpoint.saved.at(-1)!;
  assert.equal(last.status, "error");
});

test("run() with onText drives chatStream() instead of chat(), delivering deltas as they arrive", async () => {
  const { llm, chatCallCount, chatStreamCallCount } = scriptedStreamingLLM([
    { deltas: ["Hel", "lo, ", "world"], turn: { text: "Hello, world", toolCalls: [], stop: true } },
  ]);
  const agent = new Agent({ llm, tools: [] });

  const seen: string[] = [];
  const result = await agent.run("say hi", { onText: (delta) => seen.push(delta) });

  assert.deepEqual(seen, ["Hel", "lo, ", "world"]);
  assert.equal(result.text, "Hello, world");
  assert.equal(chatStreamCallCount(), 1);
  assert.equal(chatCallCount(), 0);
});

test("run() without onText never calls chatStream(), even when the provider supports it", async () => {
  const { llm, chatCallCount, chatStreamCallCount } = scriptedStreamingLLM([
    { deltas: ["ignored"], turn: { text: "done", toolCalls: [], stop: true } },
  ]);
  const agent = new Agent({ llm, tools: [] });

  const result = await agent.run("say hi");

  assert.equal(result.text, "done");
  assert.equal(chatCallCount(), 1);
  assert.equal(chatStreamCallCount(), 0);
});

test("run() with onText falls back to chat() when the provider has no chatStream, instead of throwing", async () => {
  const { llm, callCount } = scriptedLLM([{ text: "done", toolCalls: [], stop: true }]);
  const agent = new Agent({ llm, tools: [] });

  const seen: string[] = [];
  const result = await agent.run("say hi", { onText: (delta) => seen.push(delta) });

  assert.equal(result.text, "done");
  assert.equal(callCount(), 1);
  assert.deepEqual(seen, [], "no chatStream on the provider means no incremental events, not an error");
});

test("run() without a runId never calls the tracer, even when one is configured", async () => {
  const { llm } = scriptedLLM([{ text: "done", toolCalls: [], stop: true }]);
  const tracer = memoryStepTracer();
  const agent = new Agent({ llm, tools: [], trace: tracer });

  await agent.run("do the thing");

  assert.equal(tracer.events.length, 0);
});

test("run() with a tracer + runId emits an llm-turn step and a tool-call step per turn", async () => {
  const { llm } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "search", input: { q: "x" } }], stop: false },
    { text: "final answer", toolCalls: [], stop: true },
  ]);
  const tracer = memoryStepTracer();
  const agent = new Agent({ llm, tools: [echoTool("search")], trace: tracer });

  await agent.run("do the thing", { runId: "run-a" });

  assert.deepEqual(
    tracer.events.map((e) => [e.turn, e.kind, e.toolName]),
    [
      [0, "llm-turn", undefined],
      [0, "tool-call", "search"],
      [1, "llm-turn", undefined],
    ],
  );
  assert.ok(tracer.events.every((e) => typeof e.durationMs === "number"));
  assert.ok(tracer.events.every((e) => e.runId === "run-a" && e.agentName === "agent"));
});

test("run() forwards LLMTurn.usage onto the llm-turn step, when the provider reports it", async () => {
  const { llm } = scriptedLLM([{ text: "done", toolCalls: [], stop: true, usage: { inputTokens: 12, outputTokens: 4 } }]);
  const tracer = memoryStepTracer();
  const agent = new Agent({ llm, tools: [], trace: tracer });

  await agent.run("do the thing", { runId: "run-usage" });

  assert.deepEqual(tracer.events[0]?.usage, { inputTokens: 12, outputTokens: 4 });
});

test("run() leaves usage unset on the llm-turn step when the provider doesn't report it", async () => {
  const { llm } = scriptedLLM([{ text: "done", toolCalls: [], stop: true }]);
  const tracer = memoryStepTracer();
  const agent = new Agent({ llm, tools: [], trace: tracer });

  await agent.run("do the thing", { runId: "run-no-usage" });

  assert.equal(tracer.events[0]?.usage, undefined);
});

test("a tool call that throws emits a tool-call step carrying the error message", async () => {
  const { llm } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "flaky", input: {} }], stop: false },
    { text: "recovered", toolCalls: [], stop: true },
  ]);
  const tracer = memoryStepTracer();
  const agent = new Agent({ llm, tools: [throwingTool("flaky", "boom")], trace: tracer });

  await agent.run("do the thing", { runId: "run-b" });

  const toolStep = tracer.events.find((e) => e.kind === "tool-call");
  assert.equal(toolStep?.error, "boom");
});

test("an LLM call that throws emits an llm-turn step carrying the error, then still rethrows", async () => {
  const tracer = memoryStepTracer();
  const agent = new Agent({
    llm: {
      name: "fake",
      async chat() {
        throw new Error("rate limited");
      },
    },
    tools: [],
    trace: tracer,
  });

  await assert.rejects(() => agent.run("do the thing", { runId: "run-c" }), /rate limited/);

  assert.equal(tracer.events.length, 1);
  assert.equal(tracer.events[0]!.kind, "llm-turn");
  assert.equal(tracer.events[0]!.error, "rate limited");
});

test("resume() with onText streams the remaining turns after a checkpointed crash", async () => {
  const checkpoint = memoryCheckpointStore();
  await checkpoint.save({
    runId: "run-f",
    agentName: "agent",
    status: "running",
    turnCount: 1,
    messages: [{ role: "user", text: "do the thing" }],
    toolCalls: [],
  });

  const { llm, chatStreamCallCount } = scriptedStreamingLLM([
    { deltas: ["fin", "ished"], turn: { text: "finished", toolCalls: [], stop: true } },
  ]);
  const agent = new Agent({ llm, tools: [], checkpoint });

  const seen: string[] = [];
  const result = await agent.resume("run-f", { onText: (delta) => seen.push(delta) });

  assert.deepEqual(seen, ["fin", "ished"]);
  assert.equal(result.text, "finished");
  assert.equal(chatStreamCallCount(), 1);
});

const personSchema = z.object({ name: z.string(), age: z.number() });

test("run() with a responseSchema returns parsed data when the first attempt already matches", async () => {
  const { llm, callCount } = scriptedLLM([{ text: '{"name": "ash", "age": 5}', toolCalls: [], stop: true }]);
  const agent = new Agent({ llm, tools: [] });

  const result = await agent.run("describe ash", { responseSchema: personSchema });

  assert.equal(callCount(), 1, "a valid first attempt needs no repair turn");
  assert.deepEqual(result.data, { name: "ash", age: 5 });
  assert.equal(result.text, '{"name": "ash", "age": 5}');
});

test("run() with a responseSchema feeds a repair prompt back to the model and succeeds on retry", async () => {
  const { llm, callCount } = scriptedLLM([
    { text: "not json at all", toolCalls: [], stop: true },
    { text: '{"name": "ash", "age": 5}', toolCalls: [], stop: true },
  ]);
  const agent = new Agent({ llm, tools: [] });

  const result = await agent.run("describe ash", { responseSchema: personSchema });

  assert.equal(callCount(), 2, "one initial attempt, one after the repair prompt");
  assert.deepEqual(result.data, { name: "ash", age: 5 });
});

test("run() with a responseSchema throws StructuredOutputError once maxRepairAttempts is exhausted", async () => {
  const { llm, callCount } = scriptedLLM([
    { text: "still not json", toolCalls: [], stop: true },
    { text: "still not json either", toolCalls: [], stop: true },
  ]);
  const agent = new Agent({ llm, tools: [] });

  await assert.rejects(
    () => agent.run("describe ash", { responseSchema: personSchema, maxRepairAttempts: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof StructuredOutputError);
      assert.equal(err.rawText, "still not json either");
      return true;
    },
  );
  assert.equal(callCount(), 2, "one initial attempt, one repair attempt, then give up");
});

test("run() with a responseSchema doesn't apply schema validation to intermediate tool-call turns", async () => {
  const { llm, callCount } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "search", input: {} }], stop: false },
    { text: '{"name": "ash", "age": 5}', toolCalls: [], stop: true },
  ]);
  const agent = new Agent({ llm, tools: [echoTool("search")] });

  const result = await agent.run("describe ash", { responseSchema: personSchema });

  assert.equal(callCount(), 2);
  assert.deepEqual(result.data, { name: "ash", age: 5 });
  assert.equal(result.toolCalls.length, 1);
});

test("resume() with a responseSchema still validates the final answer after picking the loop back up", async () => {
  const checkpoint = memoryCheckpointStore();
  await checkpoint.save({
    runId: "run-g",
    agentName: "agent",
    status: "running",
    turnCount: 1,
    messages: [{ role: "user", text: "describe ash" }],
    toolCalls: [],
  });

  const { llm } = scriptedLLM([{ text: '{"name": "ash", "age": 5}', toolCalls: [], stop: true }]);
  const agent = new Agent({ llm, tools: [], checkpoint });

  const result = await agent.resume("run-g", { responseSchema: personSchema });

  assert.deepEqual(result.data, { name: "ash", age: 5 });
});

test("a tripped input guardrail throws before the LLM is ever called", async () => {
  const { llm, callCount } = scriptedLLM([{ text: "should never be reached", toolCalls: [], stop: true }]);
  const agent = new Agent({
    llm,
    tools: [],
    inputGuardrails: [() => ({ tripwireTriggered: true, message: "banned phrase" })],
  });

  await assert.rejects(() => agent.run("do something bad"), /input guardrail tripped: banned phrase/);
  assert.equal(callCount(), 0);
});

test("an untripped input guardrail lets the run proceed as normal", async () => {
  const { llm } = scriptedLLM([{ text: "all good", toolCalls: [], stop: true }]);
  const agent = new Agent({ llm, tools: [], inputGuardrails: [() => ({ tripwireTriggered: false })] });

  const result = await agent.run("a fine request");

  assert.equal(result.text, "all good");
});

test("a tripped output guardrail throws instead of returning the flagged final answer", async () => {
  const { llm } = scriptedLLM([{ text: "leaked secret", toolCalls: [], stop: true }]);
  const agent = new Agent({
    llm,
    tools: [],
    outputGuardrails: [(text) => ({ tripwireTriggered: text.includes("secret"), message: "looked like a secret" })],
  });

  await assert.rejects(() => agent.run("tell me a secret"), /output guardrail tripped: looked like a secret/);
});

test("a tripped output guardrail checkpoints the run as error rather than done", async () => {
  const { llm } = scriptedLLM([{ text: "leaked secret", toolCalls: [], stop: true }]);
  const checkpoint = memoryCheckpointStore();
  const agent = new Agent({
    llm,
    tools: [],
    checkpoint,
    outputGuardrails: [() => ({ tripwireTriggered: true, message: "nope" })],
  });

  await assert.rejects(() => agent.run("do it", { runId: "run-guard" }));

  const last = checkpoint.saved.at(-1)!;
  assert.equal(last.status, "error");
});

test("multiple guardrails run in order and stop at the first tripped one", async () => {
  const { llm } = scriptedLLM([{ text: "fine", toolCalls: [], stop: true }]);
  const calls: string[] = [];
  const agent = new Agent({
    llm,
    tools: [],
    inputGuardrails: [
      (text) => {
        calls.push("first");
        return { tripwireTriggered: true, message: "first guardrail tripped" };
      },
      (text) => {
        calls.push("second");
        return { tripwireTriggered: false };
      },
    ],
  });

  await assert.rejects(() => agent.run("input"), /first guardrail tripped/);
  assert.deepEqual(calls, ["first"]);
});

test("withTools() carries guardrails over to the extended agent", async () => {
  const { llm, callCount } = scriptedLLM([{ text: "unreachable", toolCalls: [], stop: true }]);
  const original = new Agent({
    llm,
    tools: [],
    inputGuardrails: [() => ({ tripwireTriggered: true, message: "blocked" })],
  });
  const extended = original.withTools([echoTool("extra")]);

  await assert.rejects(() => extended.run("anything"), /blocked/);
  assert.equal(callCount(), 0);
});

test("output guardrails still apply to a resumed run's final answer", async () => {
  const checkpoint = memoryCheckpointStore();
  await checkpoint.save({
    runId: "run-resumed-guard",
    agentName: "agent",
    status: "running",
    turnCount: 0,
    messages: [{ role: "user", text: "hi" }],
    toolCalls: [],
  });
  const { llm } = scriptedLLM([{ text: "leaked secret", toolCalls: [], stop: true }]);
  const agent = new Agent({
    llm,
    tools: [],
    checkpoint,
    outputGuardrails: [(text) => ({ tripwireTriggered: text.includes("secret") })],
  });

  await assert.rejects(() => agent.resume("run-resumed-guard"), /output guardrail tripped/);
});

test("run() with a session prepends its prior items before the new input", async () => {
  const session = createInMemorySession([
    { role: "user", text: "what's the capital of France?" },
    { role: "assistant", text: "Paris" },
  ]);
  let seenMessages: unknown;
  const llm: LLMProvider = {
    name: "fake",
    async chat({ messages }) {
      seenMessages = [...messages]; // a copy — loop() keeps mutating the same array after this call returns
      return { text: "38 million", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({ llm, tools: [] });

  await agent.run("and its population?", { session });

  assert.deepEqual(seenMessages, [
    { role: "user", text: "what's the capital of France?" },
    { role: "assistant", text: "Paris" },
    { role: "user", text: "and its population?" },
  ]);
});

test("run() with a session appends the new turn's messages after a successful run", async () => {
  const session = createInMemorySession();
  const { llm } = scriptedLLM([{ text: "hello there", toolCalls: [], stop: true }]);
  const agent = new Agent({ llm, tools: [] });

  await agent.run("hi", { session });

  assert.deepEqual(await session.getItems(), [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello there" },
  ]);
});

test("run() with a session persists tool-call turns too, not just the final answer", async () => {
  const session = createInMemorySession();
  const { llm } = scriptedLLM([
    { toolCalls: [{ id: "1", name: "search", input: {} }], stop: false },
    { text: "done", toolCalls: [], stop: true },
  ]);
  const agent = new Agent({ llm, tools: [echoTool("search")] });

  await agent.run("look something up", { session });

  const items = await session.getItems();
  assert.equal(items.length, 4); // user input, assistant tool-call turn, tool result, final assistant answer
  assert.equal(items[0]?.role, "user");
  assert.equal(items.at(-1)?.text, "done");
});

test("a run a tripped output guardrail kills does not persist anything to the session", async () => {
  const session = createInMemorySession();
  const { llm } = scriptedLLM([{ text: "leaked secret", toolCalls: [], stop: true }]);
  const agent = new Agent({
    llm,
    tools: [],
    outputGuardrails: [() => ({ tripwireTriggered: true, message: "nope" })],
  });

  await assert.rejects(() => agent.run("do it", { session }));

  assert.deepEqual(await session.getItems(), []);
});

test("run() without a session behaves exactly as before — no session, no prior-history lookup", async () => {
  const { llm, callCount } = scriptedLLM([{ text: "hello", toolCalls: [], stop: true }]);
  const agent = new Agent({ llm, tools: [] });

  const result = await agent.run("hi");

  assert.equal(result.text, "hello");
  assert.equal(callCount(), 1);
});
