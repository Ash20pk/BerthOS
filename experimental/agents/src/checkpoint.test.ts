import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputerHandle } from "./computer.js";
import type { Tool } from "./types.js";
import { createSemanticFsCheckpointStore, type CheckpointedRun } from "./checkpoint.js";

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

function sampleCheckpoint(overrides: Partial<CheckpointedRun> = {}): CheckpointedRun {
  return {
    runId: "run-1",
    agentName: "agent",
    status: "running",
    turnCount: 1,
    messages: [{ role: "user", text: "hi" }],
    toolCalls: [],
    ...overrides,
  };
}

test("throws immediately when the Computer has no write_context_file/read_context_file/tag_context_file tools", () => {
  const computer = fakeComputer([fakeTool("read_file", async () => ({ content: "" }))]);
  assert.throws(() => createSemanticFsCheckpointStore(computer), /write_context_file/);
});

test("resolves namespaced tool names (multi-app Computer) as well as bare ones", () => {
  const files = new Map<string, string>();
  const computer = fakeComputer([
    fakeTool("filesystem__write_context_file", async (input) => {
      const { path, content } = input as { path: string; content: string };
      files.set(path, content);
    }),
    fakeTool("filesystem__read_context_file", async (input) => {
      const { path } = input as { path: string };
      if (!files.has(path)) throw new Error("ENOENT");
      return { content: files.get(path) };
    }),
    fakeTool("filesystem__tag_context_file", async () => {}),
  ]);

  const store = createSemanticFsCheckpointStore(computer);
  assert.ok(store);
});

test("save() then load() round-trips a checkpoint through write_context_file/read_context_file", async () => {
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

  const store = createSemanticFsCheckpointStore(computer);
  const checkpoint = sampleCheckpoint();
  await store.save(checkpoint);

  const loaded = await store.load("run-1");
  assert.deepEqual(loaded, checkpoint);
  assert.equal(tagCalls.length, 1);
});

test("load() returns null (not an error) when nothing has been saved for that runId", async () => {
  const computer = fakeComputer([
    fakeTool("write_context_file", async () => {}),
    fakeTool("read_context_file", async () => {
      throw new Error("ENOENT: no such file");
    }),
    fakeTool("tag_context_file", async () => {}),
  ]);

  const store = createSemanticFsCheckpointStore(computer);
  assert.equal(await store.load("never-saved"), null);
});

test("save() persists the latest state when called again for the same runId", async () => {
  const files = new Map<string, string>();
  const computer = fakeComputer([
    fakeTool("write_context_file", async (input) => {
      const { path, content } = input as { path: string; content: string };
      files.set(path, content);
    }),
    fakeTool("read_context_file", async (input) => {
      const { path } = input as { path: string };
      return { content: files.get(path) };
    }),
    fakeTool("tag_context_file", async () => {}),
  ]);

  const store = createSemanticFsCheckpointStore(computer);
  await store.save(sampleCheckpoint({ turnCount: 1 }));
  await store.save(sampleCheckpoint({ turnCount: 2, status: "done", text: "final answer" }));

  const loaded = await store.load("run-1");
  assert.equal(loaded?.turnCount, 2);
  assert.equal(loaded?.status, "done");
  assert.equal(loaded?.text, "final answer");
});
