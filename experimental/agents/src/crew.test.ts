import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent } from "./agent.js";
import { Crew, checkpointKeyFor, type CrewCheckpoint } from "./crew.js";
import type { CheckpointStore } from "./checkpoint.js";
import type { AgentStepEvent, StepTracer } from "./tracing.js";
import { StructuredOutputError } from "./structured-output.js";
import type { LLMProvider, LLMTurn } from "./types.js";
import type { NetworkedAgent } from "./network.js";

function memoryStepTracer(): StepTracer & { events: AgentStepEvent[] } {
  const events: AgentStepEvent[] = [];
  return {
    events,
    async emit(event) {
      events.push(event);
    },
  };
}

/** An Agent wired to a shared tracer — for asserting every step of a Crew composition traces under one correlated runId. */
function tracedAgent(name: string, text: string, tracer: StepTracer): Agent {
  return new Agent({ name, llm: { name: "fake", async chat() { return { text, toolCalls: [], stop: true }; } }, tools: [], trace: tracer });
}

/** A plain in-memory CheckpointStore — Crew doesn't care about the backend, so tests don't need a fakeComputer/Semantic FS round-trip. */
function inMemoryCheckpointStore<T extends { runId: string }>(): CheckpointStore<T> {
  const store = new Map<string, T>();
  return {
    async save(checkpoint) {
      store.set(checkpoint.runId, checkpoint);
    },
    async load(runId) {
      return store.get(runId) ?? null;
    },
  };
}

/** An Agent that counts how many times its LLM was actually called — lets a resume test assert a completed step didn't re-run. */
function countingAgent(name: string, text: string, calls: { count: number }): Agent {
  return new Agent({
    name,
    llm: {
      name: "fake",
      async chat() {
        calls.count++;
        return { text, toolCalls: [], stop: true };
      },
    },
    tools: [],
  });
}

function scriptedLLM(turns: LLMTurn[]): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    async chat() {
      const turn = turns[i];
      if (!turn) throw new Error("script exhausted — llm.chat() called more times than the test expected");
      i++;
      return turn;
    },
  };
}

function textAgent(name: string, text: string): Agent {
  return new Agent({ name, llm: scriptedLLM([{ text, toolCalls: [], stop: true }]), tools: [] });
}

/** Echoes the last user-turn text back, prefixed with its own name — lets a test see exactly what task a delegating agent passed down. */
function echoAgent(name: string): Agent {
  return new Agent({
    name,
    llm: {
      name: "fake",
      async chat(params) {
        const text = params.messages.at(-1)?.text ?? "";
        return { text: `${name} received: ${text}`, toolCalls: [], stop: true };
      },
    },
    tools: [],
  });
}

/** A manager-shaped Agent: first turn delegates to `toolName` with `{task}`, second turn answers from that tool call's result. */
function managerAgent(toolName: string, task: string, finalText: (toolOutput: unknown) => string): Agent {
  let call = 0;
  return new Agent({
    name: "manager",
    llm: {
      name: "fake",
      async chat(params) {
        call++;
        if (call === 1) {
          return { toolCalls: [{ id: "1", name: toolName, input: { task } }], stop: false };
        }
        return { text: finalText(params.messages.at(-1)?.toolResult?.output), toolCalls: [], stop: true };
      },
    },
    tools: [],
  });
}

/** A fake NetworkedAgent peer — Crew.networked() only ever reads `.tool`, so the rest of the shape is unused filler. */
function fakePeer(name: string, invoke: (input: unknown) => Promise<unknown>): NetworkedAgent {
  return {
    computer: undefined as unknown as NetworkedAgent["computer"],
    transport: "local",
    async stop() {},
    tool: {
      name,
      description: `delegate to ${name}`,
      inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      invoke,
    },
  };
}

test("Crew.parallel runs every agent against the same input and merges with the default merge", async () => {
  const crew = Crew.parallel([textAgent("a", "output-a"), textAgent("b", "output-b")]);

  const result = await crew.run("shared input");

  assert.match(result, /## a\noutput-a/);
  assert.match(result, /## b\noutput-b/);
});

test("Crew.parallel uses a custom merge function when given one", async () => {
  const crew = Crew.parallel([textAgent("a", "output-a"), textAgent("b", "output-b")], {
    merge: (results) => results.map((r) => r.text).join("|"),
  });

  const result = await crew.run("shared input");

  assert.equal(result, "output-a|output-b");
});

test("Crew.loopUntil stops as soon as until() returns true, feeding output back in as input", async () => {
  let calls = 0;
  const agent = new Agent({
    llm: {
      name: "fake",
      async chat(params) {
        calls++;
        const lastUserText = params.messages.at(-1)?.text ?? "";
        return { text: `${lastUserText}!`, toolCalls: [], stop: true };
      },
    },
    tools: [],
  });

  const crew = Crew.loopUntil({
    agent,
    until: (result) => result === "seed!!!",
  });

  const result = await crew.run("seed");

  assert.equal(result, "seed!!!");
  assert.equal(calls, 3, "one call per '!' appended, stopping the run it first satisfies until()");
});

test("Crew.loopUntil stops at maxIterations if until() never returns true", async () => {
  const agent = new Agent({
    llm: {
      name: "fake",
      async chat() {
        return { text: "never satisfied", toolCalls: [], stop: true };
      },
    },
    tools: [],
  });
  let untilCalls = 0;

  const crew = Crew.loopUntil({ agent, until: () => (untilCalls++, false), maxIterations: 3 });
  const result = await crew.run("seed");

  assert.equal(result, "never satisfied");
  assert.equal(untilCalls, 3);
});

test("Crew.route dispatches to the branch matching the router's answer, run against the original input", async () => {
  const router = textAgent("router", "billing");
  const billing = textAgent("billing-agent", "handled by billing");
  const support = textAgent("support-agent", "handled by support");

  const crew = Crew.route({ router, routes: { billing, support } });
  const result = await crew.run("where's my refund?");

  assert.equal(result, "handled by billing");
});

test("Crew.route falls back to fallback when the router's answer matches no route", async () => {
  const router = textAgent("router", "something unexpected");
  const billing = textAgent("billing-agent", "handled by billing");
  const fallback = textAgent("fallback-agent", "handled by fallback");

  const crew = Crew.route({ router, routes: { billing }, fallback });
  const result = await crew.run("???");

  assert.equal(result, "handled by fallback");
});

test("Crew.route throws, naming the router's answer, when no route matches and no fallback is given", async () => {
  const router = textAgent("router", "something unexpected");
  const billing = textAgent("billing-agent", "handled by billing");

  const crew = Crew.route({ router, routes: { billing } });

  await assert.rejects(() => crew.run("???"), /something unexpected/);
});

test("Crew.sequential pipes each agent's output text as the next agent's input, in order", async () => {
  const upper = new Agent({
    name: "upper",
    llm: {
      name: "fake",
      async chat(params) {
        return { text: (params.messages.at(-1)?.text ?? "").toUpperCase(), toolCalls: [], stop: true };
      },
    },
    tools: [],
  });
  const exclaim = new Agent({
    name: "exclaim",
    llm: {
      name: "fake",
      async chat(params) {
        return { text: `${params.messages.at(-1)?.text ?? ""}!`, toolCalls: [], stop: true };
      },
    },
    tools: [],
  });

  const crew = Crew.sequential([upper, exclaim]);
  const result = await crew.run("hello");

  assert.equal(result, "HELLO!", "exclaim must see upper's output, not the original input");
});

test("Crew.sequential with no agents returns the input unchanged", async () => {
  const crew = Crew.sequential([]);
  const result = await crew.run("unchanged");
  assert.equal(result, "unchanged");
});

test("Crew.withManager gives the manager one Tool per worker and returns the manager's final answer", async () => {
  const worker = echoAgent("writer");
  const manager = managerAgent("writer", "write a poem", (output) => `manager says: ${output}`);

  const crew = Crew.withManager({ manager, workers: [worker] });
  const result = await crew.run("please get a poem written");

  assert.equal(result, "manager says: writer received: write a poem", "the task from the tool call must reach the worker's own run()");
});

test("Crew.withManager delegates to the worker matching the tool call's name, not just the first worker", async () => {
  const writer = echoAgent("writer");
  const reviewer = echoAgent("reviewer");
  const manager = managerAgent("reviewer", "check this draft", (output) => String(output));

  const crew = Crew.withManager({ manager, workers: [writer, reviewer] });
  const result = await crew.run("please review this");

  assert.equal(result, "reviewer received: check this draft");
});

test("Crew.withManager does not mutate the original manager Agent in place", async () => {
  const worker = echoAgent("writer");
  const manager = managerAgent("writer", "write it", (output) => (output as { error?: string }).error ?? String(output));

  Crew.withManager({ manager, workers: [worker] });
  const result = await manager.run("solo, no crew");

  assert.match(
    result.text ?? "",
    /no such tool "writer"/,
    "the original manager must still lack the worker tool — withManager()'s withTools() must return a new Agent, not mutate this one",
  );
});

test("Crew.networked delegates to a peer's tool exactly like an in-process worker", async () => {
  const peer = fakePeer("remote-writer", async (input) => `remote got: ${(input as { task: string }).task}`);
  const manager = managerAgent("remote-writer", "draft the memo", (output) => `manager says: ${output}`);

  const crew = Crew.networked({ manager, peers: [peer] });
  const result = await crew.run("please draft a memo");

  assert.equal(result, "manager says: remote got: draft the memo");
});

test("Crew.networked dispatches to the peer matching the tool call's name among several", async () => {
  const a = fakePeer("peer-a", async () => "from a");
  const b = fakePeer("peer-b", async () => "from b");
  const manager = managerAgent("peer-b", "task for b", (output) => String(output));

  const crew = Crew.networked({ manager, peers: [a, b] });
  const result = await crew.run("dispatch");

  assert.equal(result, "from b");
});

test("Crew.pipeline accumulates each step's partial update into the shared state", async () => {
  type State = { draft?: string; wordCount?: number };
  const crew = Crew.pipeline<State>([
    () => ({ draft: "hello world" }),
    (state) => ({ wordCount: state.draft?.split(" ").length ?? 0 }),
  ]);

  const result = await crew.run({});

  assert.deepEqual(result, { draft: "hello world", wordCount: 2 });
});

test("Crew.pipeline lets a later step read a field an earlier step wrote, not just the last return", async () => {
  type State = { a?: string; b?: string; combined?: string };
  const crew = Crew.pipeline<State>([
    () => ({ a: "first" }),
    () => ({ b: "second" }),
    (state) => ({ combined: `${state.a}-${state.b}` }),
  ]);

  const result = await crew.run({});

  assert.equal(result.combined, "first-second");
});

test("Crew.pipeline steps can call real Agents, threading their output into state", async () => {
  type State = { input: string; summary?: string };
  const summarizer = textAgent("summarizer", "a short summary");
  const crew = Crew.pipeline<State>([
    async (state) => ({ summary: (await summarizer.run(state.input)).text }),
  ]);

  const result = await crew.run({ input: "a long document" });

  assert.equal(result.summary, "a short summary");
  assert.equal(result.input, "a long document", "fields no step touched must survive unchanged");
});

test("Crew.pipeline with zero steps returns the initial state unchanged", async () => {
  const crew = Crew.pipeline<{ x: number }>([]);
  const result = await crew.run({ x: 1 });
  assert.deepEqual(result, { x: 1 });
});

test("Crew.sequential resumes from a checkpoint instead of re-running completed steps", async () => {
  const store = inMemoryCheckpointStore<CrewCheckpoint<string>>();
  const firstCalls = { count: 0 };
  const secondCalls = { count: 0 };
  const agents = [countingAgent("a", "a-out", firstCalls), countingAgent("b", "b-out", secondCalls)];
  await store.save({ runId: checkpointKeyFor("seq-1"), kind: "sequential", status: "running", completedSteps: 1, state: "a-out" });

  const crew = Crew.sequential(agents, { checkpoint: store, runId: "seq-1" });
  const result = await crew.run("original input");

  assert.equal(result, "b-out");
  assert.equal(firstCalls.count, 0, "step already marked completed must not re-run");
  assert.equal(secondCalls.count, 1);
});

test("Crew.sequential returns the saved result immediately when the checkpoint is already done, without running any agent", async () => {
  const store = inMemoryCheckpointStore<CrewCheckpoint<string>>();
  const calls = { count: 0 };
  await store.save({ runId: checkpointKeyFor("seq-done"), kind: "sequential", status: "done", completedSteps: 1, state: "final" });

  const crew = Crew.sequential([countingAgent("a", "a-out", calls)], { checkpoint: store, runId: "seq-done" });
  const result = await crew.run("ignored");

  assert.equal(result, "final");
  assert.equal(calls.count, 0);
});

test('Crew.sequential saves a checkpoint after each step, ending in status "done"', async () => {
  const store = inMemoryCheckpointStore<CrewCheckpoint<string>>();
  const agents = [textAgent("a", "a-out"), textAgent("b", "b-out")];
  const crew = Crew.sequential(agents, { checkpoint: store, runId: "seq-2" });

  await crew.run("start");

  const loaded = await store.load(checkpointKeyFor("seq-2"));
  assert.equal(loaded?.status, "done");
  assert.equal(loaded?.completedSteps, 2);
  assert.equal(loaded?.state, "b-out");
});

test("Crew.pipeline resumes from a checkpoint, skipping already-completed steps", async () => {
  type State = { a?: string; b?: string };
  const store = inMemoryCheckpointStore<CrewCheckpoint<State>>();
  let secondStepCalls = 0;
  await store.save({ runId: checkpointKeyFor("pipe-1"), kind: "pipeline", status: "running", completedSteps: 1, state: { a: "first" } });

  const crew = Crew.pipeline<State>(
    [
      () => {
        throw new Error("must not run — this step was already marked completed");
      },
      (state) => {
        secondStepCalls++;
        return { b: `${state.a}-second` };
      },
    ],
    { checkpoint: store, runId: "pipe-1" },
  );

  const result = await crew.run({});

  assert.deepEqual(result, { a: "first", b: "first-second" });
  assert.equal(secondStepCalls, 1);
});

test("Crew.loopUntil resumes from the saved iteration count, not from zero", async () => {
  const store = inMemoryCheckpointStore<CrewCheckpoint<string>>();
  let calls = 0;
  await store.save({ runId: checkpointKeyFor("loop-1"), kind: "loopUntil", status: "running", completedSteps: 2, state: "iter-2" });

  const agent = new Agent({
    name: "looper",
    llm: {
      name: "fake",
      async chat() {
        calls++;
        return { text: `iter-${calls + 2}`, toolCalls: [], stop: true };
      },
    },
    tools: [],
  });

  const crew = Crew.loopUntil({
    agent,
    until: (_result, iteration) => iteration >= 2,
    maxIterations: 5,
    checkpoint: store,
    runId: "loop-1",
  });

  const result = await crew.run("start");

  assert.equal(calls, 1, "must resume at iteration 2, not restart from 0");
  assert.equal(result, "iter-3");
});

test("Crew.sequential threads runId into every agent's run(), correlating all their trace events", async () => {
  const tracer = memoryStepTracer();
  const agents = [tracedAgent("a", "a-out", tracer), tracedAgent("b", "b-out", tracer)];

  await Crew.sequential(agents, { runId: "corr-1" }).run("start");

  assert.deepEqual(tracer.events.map((e) => e.agentName), ["a", "b"]);
  assert.ok(tracer.events.every((e) => e.runId === "corr-1"));
});

/**
 * This test previously asserted every parallel agent traced under the *same*
 * runId — which was the bug (REMEDIATION 3.3), not the contract: one runId
 * across N concurrent agents meant N writers to one checkpoint key and one
 * trace blob. Correlation is still available, as a prefix rather than an
 * exact match, which is what this now asserts.
 */
test("Crew.parallel gives each agent a distinct runId that still correlates by prefix", async () => {
  const tracer = memoryStepTracer();
  const agents = [tracedAgent("a", "a-out", tracer), tracedAgent("b", "b-out", tracer)];

  await Crew.parallel(agents, { runId: "corr-2" }).run("start");

  assert.equal(tracer.events.length, 2);
  const runIds = tracer.events.map((e) => e.runId);
  assert.equal(new Set(runIds).size, 2, `expected distinct runIds, got ${JSON.stringify(runIds)}`);
  assert.ok(runIds.every((id) => id!.startsWith("corr-2:")));
});

/**
 * The defect itself, at the level it actually bit: two concurrent agents each
 * with their own checkpoint store. Before the fix both wrote the key
 * "corr-3", so one run's messages silently replaced the other's and
 * resume("corr-3") replayed a mixture.
 */
test("Crew.parallel agents do not overwrite each other's checkpoints", async () => {
  const store = inMemoryCheckpointStore<any>();
  const saved: string[] = [];
  const recordingStore: CheckpointStore<any> = {
    async save(checkpoint) {
      saved.push(checkpoint.runId);
      return store.save(checkpoint);
    },
    load: store.load,
  };

  const agentWith = (name: string, text: string) =>
    new Agent({
      name,
      llm: { name: "fake", async chat() { return { text, toolCalls: [], stop: true }; } },
      tools: [],
      checkpoint: recordingStore,
    });

  await Crew.parallel([agentWith("alpha", "a-out"), agentWith("beta", "b-out")], { runId: "corr-3" }).run("go");

  assert.equal(new Set(saved).size, 2, `both agents wrote the same checkpoint key: ${JSON.stringify(saved)}`);
  const alpha = await recordingStore.load("corr-3:0:alpha");
  const beta = await recordingStore.load("corr-3:1:beta");
  assert.equal(alpha?.text, "a-out");
  assert.equal(beta?.text, "b-out");
});

/**
 * Agent's default name is "agent", so a crew of agents nobody named is the
 * case where a name-keyed id would collide exactly as the bare runId did.
 * The index is what makes this safe.
 */
test("Crew.parallel keeps runIds distinct even when every agent has the same name", async () => {
  const tracer = memoryStepTracer();
  const agents = [tracedAgent("agent", "1", tracer), tracedAgent("agent", "2", tracer), tracedAgent("agent", "3", tracer)];

  await Crew.parallel(agents, { runId: "same-name" }).run("start");

  assert.equal(new Set(tracer.events.map((e) => e.runId)).size, 3);
});

/**
 * The positive control for the no-runId path: a crew run without one must not
 * start fabricating ids, or agents that were deliberately untraced and
 * uncheckpointed would begin writing.
 */
test("Crew.parallel passes no runId through when the crew was given none", async () => {
  const tracer = memoryStepTracer();
  const agents = [tracedAgent("a", "a-out", tracer), tracedAgent("b", "b-out", tracer)];

  await Crew.parallel(agents).run("start");

  assert.equal(tracer.events.length, 0);
});

test("Crew.loopUntil threads runId into every iteration's run()", async () => {
  const tracer = memoryStepTracer();
  const agent = tracedAgent("looper", "again", tracer);
  let iterations = 0;

  await Crew.loopUntil({
    agent,
    until: () => (iterations++, iterations >= 2),
    runId: "corr-3",
  }).run("start");

  assert.equal(tracer.events.length, 2);
  assert.ok(tracer.events.every((e) => e.runId === "corr-3"));
});

test("Crew.route threads runId into both the router's classification call and the chosen branch", async () => {
  const tracer = memoryStepTracer();
  const router = tracedAgent("router", "billing", tracer);
  const billing = tracedAgent("billing-agent", "handled", tracer);

  await Crew.route({ router, routes: { billing }, runId: "corr-4" }).run("where's my refund?");

  assert.deepEqual(tracer.events.map((e) => e.agentName), ["router", "billing-agent"]);
  assert.ok(tracer.events.every((e) => e.runId === "corr-4"));
});

test("Crew.withManager threads runId into the manager's own run(), not into a delegated worker's", async () => {
  const managerTracer = memoryStepTracer();
  const workerTracer = memoryStepTracer();
  const worker = tracedAgent("writer", "draft", workerTracer);
  const manager = new Agent({
    name: "manager",
    llm: {
      name: "fake",
      async chat(params) {
        if (params.messages.some((m) => m.toolResult)) {
          return { text: "done", toolCalls: [], stop: true };
        }
        return { toolCalls: [{ id: "1", name: "writer", input: { task: "write it" } }], stop: false };
      },
    },
    tools: [],
    trace: managerTracer,
  });

  await Crew.withManager({ manager, workers: [worker], runId: "corr-5" }).run("please write something");

  assert.ok(managerTracer.events.every((e) => e.runId === "corr-5"), "manager's own turns correlate under runId");
  assert.equal(workerTracer.events.length, 0, "a delegated worker's own run() gets no runId, so it never traces");
});

test("Crew.pipeline passes runId as each step function's second argument", async () => {
  const seen: (string | undefined)[] = [];
  const crew = Crew.pipeline<{ x: number }>(
    [
      (_state, runId) => {
        seen.push(runId);
        return {};
      },
    ],
    { runId: "corr-6" },
  );

  await crew.run({ x: 1 });

  assert.deepEqual(seen, ["corr-6"]);
});

test("Crew.sequential repairs the last agent's output against responseSchema, then returns the valid result", async () => {
  const schema = z.object({ name: z.string() });
  const first = textAgent("first", "first-out");
  const repairable = new Agent({
    name: "last",
    llm: scriptedLLM([
      { text: "not json", toolCalls: [], stop: true },
      { text: '{"name": "ash"}', toolCalls: [], stop: true },
    ]),
    tools: [],
  });

  const crew = Crew.sequential([first, repairable], { responseSchema: schema });
  const result = await crew.run("start");

  assert.equal(result, '{"name": "ash"}');
});

test("Crew.sequential's responseSchema repair leaves a passing first attempt untouched (no extra LLM call)", async () => {
  const schema = z.object({ name: z.string() });
  // Only one turn scripted — scriptedLLM() itself throws "script exhausted"
  // if repair incorrectly fires a second chat() call, so a clean pass here
  // already proves no extra call happened.
  const agent = new Agent({ name: "solo", llm: scriptedLLM([{ text: '{"name": "ash"}', toolCalls: [], stop: true }]), tools: [] });

  const result = await Crew.sequential([agent], { responseSchema: schema }).run("start");

  assert.equal(result, '{"name": "ash"}');
});

test("Crew.sequential throws StructuredOutputError once repair attempts are exhausted", async () => {
  const schema = z.object({ name: z.string() });
  const agent = new Agent({
    name: "solo",
    llm: scriptedLLM([
      { text: "nope", toolCalls: [], stop: true },
      { text: "still nope", toolCalls: [], stop: true },
      { text: "still nope again", toolCalls: [], stop: true },
    ]),
    tools: [],
  });

  const crew = Crew.sequential([agent], { responseSchema: schema, maxRepairAttempts: 2 });

  await assert.rejects(() => crew.run("start"), StructuredOutputError);
});

test("Crew.route repairs the chosen branch's output against responseSchema", async () => {
  const schema = z.object({ ok: z.boolean() });
  const router = textAgent("router", "billing");
  const billing = new Agent({
    name: "billing-agent",
    llm: scriptedLLM([
      { text: "bad", toolCalls: [], stop: true },
      { text: '{"ok": true}', toolCalls: [], stop: true },
    ]),
    tools: [],
  });

  const crew = Crew.route({ router, routes: { billing }, responseSchema: schema });
  const result = await crew.run("where's my refund?");

  assert.equal(result, '{"ok": true}');
});
