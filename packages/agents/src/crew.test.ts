import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { Crew } from "./crew.js";
import type { LLMProvider, LLMTurn } from "./types.js";
import type { NetworkedAgent } from "./network.js";

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
