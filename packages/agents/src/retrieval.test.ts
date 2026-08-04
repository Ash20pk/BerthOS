import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputerHandle } from "./computer.js";
import type { Tool } from "./types.js";
import { createSemanticFsRetriever } from "./retrieval.js";

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

test("throws immediately when the Computer has no query_context/read_context_file tools", () => {
  const computer = fakeComputer([fakeTool("read_file", async () => ({ content: "" }))]);
  assert.throws(() => createSemanticFsRetriever(computer), /query_context/);
});

test("resolves namespaced tool names (multi-app Computer) as well as bare ones", () => {
  const computer = fakeComputer([
    fakeTool("filesystem__query_context", async () => ({ results: [] })),
    fakeTool("filesystem__read_context_file", async () => ({ content: "" })),
  ]);
  assert.ok(createSemanticFsRetriever(computer));
});

test("retrieve() fetches content for each query_context hit via read_context_file", async () => {
  const files = new Map([
    ["notes/a.md", "content of a"],
    ["notes/b.md", "content of b"],
  ]);
  const computer = fakeComputer([
    fakeTool("query_context", async () => ({
      results: [
        { path: "notes/a.md", task: "task-a", relatedApps: ["notes"] },
        { path: "notes/b.md", task: "task-b", relatedApps: [] },
      ],
    })),
    fakeTool("read_context_file", async (input) => {
      const { path } = input as { path: string };
      return { content: files.get(path) };
    }),
  ]);

  const retriever = createSemanticFsRetriever(computer);
  const documents = await retriever.retrieve("something");

  assert.deepEqual(documents, [
    { path: "notes/a.md", content: "content of a", task: "task-a", relatedApps: ["notes"] },
    { path: "notes/b.md", content: "content of b", task: "task-b", relatedApps: [] },
  ]);
});

test("retrieve() respects topK, never reading past the cutoff", async () => {
  const readCalls: string[] = [];
  const computer = fakeComputer([
    fakeTool("query_context", async () => ({
      results: [{ path: "a" }, { path: "b" }, { path: "c" }],
    })),
    fakeTool("read_context_file", async (input) => {
      const { path } = input as { path: string };
      readCalls.push(path);
      return { content: path };
    }),
  ]);

  const retriever = createSemanticFsRetriever(computer);
  const documents = await retriever.retrieve("something", { topK: 2 });

  assert.equal(documents.length, 2);
  assert.deepEqual(readCalls, ["a", "b"]);
});

test("retrieve() drops a hit whose read_context_file throws instead of failing the whole call", async () => {
  const computer = fakeComputer([
    fakeTool("query_context", async () => ({
      results: [{ path: "stale.md" }, { path: "fresh.md" }],
    })),
    fakeTool("read_context_file", async (input) => {
      const { path } = input as { path: string };
      if (path === "stale.md") throw new Error("ENOENT");
      return { content: "still here" };
    }),
  ]);

  const retriever = createSemanticFsRetriever(computer);
  const documents = await retriever.retrieve("something");

  assert.deepEqual(documents, [{ path: "fresh.md", content: "still here", task: undefined, relatedApps: undefined }]);
});

test("asTool() wraps retrieve() as a Tool returning {documents}", async () => {
  const computer = fakeComputer([
    fakeTool("query_context", async (input) => {
      assert.deepEqual(input, { text: "hello" });
      return { results: [{ path: "a.md" }] };
    }),
    fakeTool("read_context_file", async () => ({ content: "hi" })),
  ]);

  const retriever = createSemanticFsRetriever(computer);
  const tool = retriever.asTool();

  assert.equal(tool.name, "search_context");
  const result = await tool.invoke({ query: "hello", topK: 3 });
  assert.deepEqual(result, { documents: [{ path: "a.md", content: "hi", task: undefined, relatedApps: undefined }] });
});

test("asTool() accepts a custom tool name", () => {
  const computer = fakeComputer([
    fakeTool("query_context", async () => ({ results: [] })),
    fakeTool("read_context_file", async () => ({ content: "" })),
  ]);
  const retriever = createSemanticFsRetriever(computer);
  assert.equal(retriever.asTool("lookup_docs").name, "lookup_docs");
});
