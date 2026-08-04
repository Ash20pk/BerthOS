import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import type { CheckpointedRun, CheckpointStore } from "./checkpoint.js";
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

function echoTool(name: string, result: unknown = "tool-result"): Tool {
  return { name, description: "", inputSchema: {}, invoke: async () => result };
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
