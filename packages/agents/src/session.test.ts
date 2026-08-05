import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputerHandle } from "./computer.js";
import type { Tool } from "./types.js";
import { createInMemorySession, createSemanticFsSession } from "./session.js";

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

test("createInMemorySession starts empty and accumulates items across addItems() calls", async () => {
  const session = createInMemorySession();
  assert.deepEqual(await session.getItems(), []);

  await session.addItems([{ role: "user", text: "hi" }]);
  await session.addItems([{ role: "assistant", text: "hello" }]);

  assert.deepEqual(await session.getItems(), [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]);
});

test("createInMemorySession accepts initial items", async () => {
  const session = createInMemorySession([{ role: "user", text: "seed" }]);
  assert.deepEqual(await session.getItems(), [{ role: "user", text: "seed" }]);
});

test("createInMemorySession's clear() drops every item", async () => {
  const session = createInMemorySession([{ role: "user", text: "seed" }]);
  await session.clear();
  assert.deepEqual(await session.getItems(), []);
});

test("getItems() returns a fresh copy each time, not a live reference", async () => {
  const session = createInMemorySession();
  const first = await session.getItems();
  first.push({ role: "user", text: "mutated from outside" });
  assert.deepEqual(await session.getItems(), []);
});

test("createSemanticFsSession throws immediately when the Computer has no write_context_file/read_context_file/tag_context_file tools", () => {
  const computer = fakeComputer([fakeTool("read_file", async () => ({ content: "" }))]);
  assert.throws(() => createSemanticFsSession(computer, "session-1"), /write_context_file/);
});

test("createSemanticFsSession round-trips items through write_context_file/read_context_file", async () => {
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

  const session = createSemanticFsSession(computer, "session-1");
  assert.deepEqual(await session.getItems(), []);

  await session.addItems([{ role: "user", text: "hi" }]);
  await session.addItems([{ role: "assistant", text: "hello" }]);

  assert.deepEqual(await session.getItems(), [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]);
  assert.equal(tagCalls.length, 2);
});

test("createSemanticFsSession's getItems() returns [] (not an error) when nothing has been saved for that sessionId", async () => {
  const computer = fakeComputer([
    fakeTool("write_context_file", async () => {}),
    fakeTool("read_context_file", async () => {
      throw new Error("ENOENT: no such file");
    }),
    fakeTool("tag_context_file", async () => {}),
  ]);

  const session = createSemanticFsSession(computer, "never-saved");
  assert.deepEqual(await session.getItems(), []);
});

test("createSemanticFsSession's clear() writes an empty array", async () => {
  const files = new Map<string, string>();
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
    fakeTool("tag_context_file", async () => {}),
  ]);

  const session = createSemanticFsSession(computer, "session-1");
  await session.addItems([{ role: "user", text: "hi" }]);
  await session.clear();

  assert.deepEqual(await session.getItems(), []);
});

test("createSemanticFsSession resolves namespaced tool names (multi-app Computer) as well as bare ones", () => {
  const computer = fakeComputer([
    fakeTool("filesystem__write_context_file", async () => {}),
    fakeTool("filesystem__read_context_file", async () => ({ content: "[]" })),
    fakeTool("filesystem__tag_context_file", async () => {}),
  ]);

  assert.ok(createSemanticFsSession(computer, "session-1"));
});
