import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { createSemanticFsCheckpointStore, CheckpointReadError, type CheckpointedRun, type CheckpointStore } from "./checkpoint.js";
import type { ComputerHandle } from "./computer.js";
import type { LLMProvider, LLMTurn, Tool } from "./types.js";

/**
 * REMEDIATION 3.5. Three separate defects: checkpoints were written once per
 * turn rather than per tool call, so a crash partway through a multi-call
 * turn lost every call in it and re-executed them all on resume — side
 * effects included; save() has no atomicity; and load() swallowed every error
 * into null, so a transient read failure was indistinguishable from a fresh
 * run.
 */

function memoryStore(): CheckpointStore & { saved: CheckpointedRun[] } {
  const saved: CheckpointedRun[] = [];
  return {
    saved,
    async save(checkpoint) {
      // Deep-copied: the loop mutates its live messages array, so storing the
      // reference would make every past checkpoint look like the latest one.
      saved.push(JSON.parse(JSON.stringify(checkpoint)));
    },
    async load(runId) {
      return saved.filter((c) => c.runId === runId).at(-1) ?? null;
    },
  };
}

function countingTool(name: string, invocations: string[]): Tool {
  return {
    name,
    description: "",
    inputSchema: { type: "object" },
    invoke: async (input) => {
      invocations.push(`${name}:${JSON.stringify(input)}`);
      return { ok: name };
    },
  };
}

/** Asks for three tool calls in one turn, then finishes. */
function threeCallLLM(): LLMProvider {
  let turn = 0;
  return {
    name: "three-call",
    async chat(): Promise<LLMTurn> {
      if (turn++ === 0) {
        return {
          text: undefined,
          stop: false,
          toolCalls: [
            { id: "c1", name: "alpha", input: { n: 1 } },
            { id: "c2", name: "beta", input: { n: 2 } },
            { id: "c3", name: "gamma", input: { n: 3 } },
          ],
        };
      }
      return { text: "done", toolCalls: [], stop: true };
    },
  };
}

test("a multi-call turn checkpoints between calls, not only after the whole turn", async () => {
  const store = memoryStore();
  const invocations: string[] = [];
  const agent = new Agent({
    llm: threeCallLLM(),
    tools: ["alpha", "beta", "gamma"].map((n) => countingTool(n, invocations)),
    checkpoint: store,
  });

  await agent.run("go", { runId: "r1" });

  // Before the fix the first save landed only after all three calls had run.
  const firstRunning = store.saved[0]!;
  assert.equal(firstRunning.status, "running");
  assert.equal(firstRunning.toolCalls.length, 1, "the first checkpoint should capture one completed call, not three");
  assert.equal(store.saved[1]!.toolCalls.length, 2);
});

/**
 * The defect at the level it actually costs money: resume must not re-run a
 * side-effecting call the crashed process already completed.
 */
test("resume() finishes only the outstanding calls of a partially-executed turn", async () => {
  const store = memoryStore();
  const crashedInvocations: string[] = [];

  // Simulate a crash after call 1 of 3 by seeding exactly the checkpoint the
  // loop would have written at that point.
  await store.save({
    runId: "r2",
    agentName: "agent",
    status: "running",
    turnCount: 0,
    messages: [
      { role: "user", text: "go" },
      {
        role: "assistant",
        toolCalls: [
          { id: "c1", name: "alpha", input: { n: 1 } },
          { id: "c2", name: "beta", input: { n: 2 } },
          { id: "c3", name: "gamma", input: { n: 3 } },
        ],
      },
      { role: "tool", toolResult: { id: "c1", name: "alpha", output: { ok: "alpha" } } },
    ],
    toolCalls: [{ name: "alpha", input: { n: 1 }, result: { ok: "alpha" } }],
  });

  const agent = new Agent({
    llm: { name: "finisher", async chat() { return { text: "done", toolCalls: [], stop: true }; } },
    tools: ["alpha", "beta", "gamma"].map((n) => countingTool(n, crashedInvocations)),
    checkpoint: store,
  });

  const result = await agent.resume("r2");

  assert.equal(result.text, "done");
  // alpha already ran in the crashed process and must not run again.
  assert.deepEqual(crashedInvocations, ['beta:{"n":2}', 'gamma:{"n":3}']);
  // All three results are present in the final log, one each.
  assert.deepEqual(
    result.toolCalls.map((c) => c.name),
    ["alpha", "beta", "gamma"],
  );
});

/**
 * The reason the resume path exists at all: a provider rejects an assistant
 * message whose tool calls have no results. If the loop just re-asked the
 * model with the partial history, every resume of a partial turn would 400.
 */
test("resume() completes pending calls before the model is asked anything", async () => {
  const store = memoryStore();
  const invocations: string[] = [];
  let messagesAtFirstChat: number | undefined;

  await store.save({
    runId: "r3",
    agentName: "agent",
    status: "running",
    turnCount: 0,
    messages: [
      { role: "user", text: "go" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "alpha", input: {} }] },
    ],
    toolCalls: [],
  });

  const agent = new Agent({
    llm: {
      name: "inspector",
      async chat({ messages }) {
        messagesAtFirstChat ??= messages.length;
        // No assistant turn may reach a provider with an unanswered tool call.
        for (const m of messages) {
          if (m.role === "assistant" && m.toolCalls?.length) {
            const answered = messages.filter((x) => x.role === "tool").map((x) => x.toolResult!.id);
            for (const call of m.toolCalls) {
              assert.ok(answered.includes(call.id), `tool call ${call.id} reached the provider unanswered`);
            }
          }
        }
        return { text: "done", toolCalls: [], stop: true };
      },
    },
    tools: [countingTool("alpha", invocations)],
    checkpoint: store,
  });

  await agent.resume("r3");
  assert.deepEqual(invocations, ["alpha:{}"]);
  assert.equal(messagesAtFirstChat, 3, "the pending call's result should be in the history before the first chat()");
});

/**
 * The positive control for the whole resume path: a *complete* history must
 * not have anything re-executed, or every ordinary resume would double-run
 * its last turn.
 */
test("resume() of a turn whose calls all completed re-runs nothing", async () => {
  const store = memoryStore();
  const invocations: string[] = [];

  await store.save({
    runId: "r4",
    agentName: "agent",
    status: "running",
    turnCount: 1,
    messages: [
      { role: "user", text: "go" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "alpha", input: {} }] },
      { role: "tool", toolResult: { id: "c1", name: "alpha", output: { ok: "alpha" } } },
    ],
    toolCalls: [{ name: "alpha", input: {}, result: { ok: "alpha" } }],
  });

  const agent = new Agent({
    llm: { name: "finisher", async chat() { return { text: "done", toolCalls: [], stop: true }; } },
    tools: [countingTool("alpha", invocations)],
    checkpoint: store,
  });

  await agent.resume("r4");
  assert.deepEqual(invocations, []);
});

// --- load() must distinguish "no checkpoint" from "could not read it" ---

function fakeComputer(readImpl: () => Promise<unknown>): ComputerHandle {
  const tool = (name: string, invoke: (input: unknown) => Promise<unknown>): Tool => ({
    name,
    description: "",
    inputSchema: { type: "object" },
    invoke,
  });
  return {
    tools: [
      tool("write_context_file", async () => ({})),
      tool("read_context_file", readImpl),
      tool("tag_context_file", async () => ({})),
    ],
  } as unknown as ComputerHandle;
}

test("load() returns null when the checkpoint genuinely does not exist", async () => {
  const store = createSemanticFsCheckpointStore(
    fakeComputer(async () => {
      throw new Error("ENOENT: no such file or directory, open '/context/agent-runs/nope.json'");
    }),
  );
  assert.equal(await store.load("nope"), null);
});

test("load() throws rather than reporting a fresh run when the read itself fails", async () => {
  const store = createSemanticFsCheckpointStore(
    fakeComputer(async () => {
      throw new Error("rpc call timed out after 3000ms");
    }),
  );

  await assert.rejects(
    () => store.load("r5"),
    (err: unknown) => {
      assert.ok(err instanceof CheckpointReadError);
      assert.equal(err.runId, "r5");
      assert.match(err.message, /timed out/);
      return true;
    },
  );
});

/**
 * The failure mode save()'s missing rename primitive can't rule out: a
 * half-written checkpoint. It can't be prevented at this seam, so it has to
 * be loud — silently returning null here would restart the run and re-execute
 * everything.
 */
test("load() throws on a torn or corrupt checkpoint instead of silently restarting", async () => {
  const store = createSemanticFsCheckpointStore(
    fakeComputer(async () => ({ content: '{"runId":"r6","messages":[{"role":"use' })),
  );

  await assert.rejects(() => store.load("r6"), CheckpointReadError);
});

test("load() still reads a well-formed checkpoint back", async () => {
  const record = { runId: "r7", agentName: "a", status: "running", turnCount: 2, messages: [], toolCalls: [] };
  const store = createSemanticFsCheckpointStore(fakeComputer(async () => ({ content: JSON.stringify(record) })));

  assert.deepEqual(await store.load("r7"), record);
});
