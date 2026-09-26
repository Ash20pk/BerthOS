import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputerHandle } from "./computer.js";
import type { Tool } from "./types.js";
import { createSemanticFsRetriever, chunkText, ingest } from "./retrieval.js";

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

test("chunkText() returns [] for empty or whitespace-only text", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n  "), []);
});

test("chunkText() returns the whole (trimmed) text as one chunk when it already fits", () => {
  assert.deepEqual(chunkText("  short text  ", { maxChars: 100 }), ["short text"]);
});

test("chunkText() splits long text into multiple chunks, none exceeding maxChars", () => {
  const text = Array.from({ length: 50 }, (_, i) => `sentence number ${i}.`).join(" ");
  const chunks = chunkText(text, { maxChars: 100, overlapChars: 10 });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 100));
});

test("chunkText() prefers breaking at a paragraph boundary over a hard mid-word cut", () => {
  const text = `${"a".repeat(500)}\n\n${"b".repeat(500)}`;
  const chunks = chunkText(text, { maxChars: 600, overlapChars: 0 });

  assert.equal(chunks[0], "a".repeat(500));
  assert.ok(chunks[1]?.startsWith("b"), "the second chunk must start clean at the paragraph break, not mid-run of a's");
});

test("chunkText() gives adjacent chunks overlapping text, so no boundary silently drops content", () => {
  const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkText(text, { maxChars: 60, overlapChars: 20 });

  assert.ok(chunks.length > 1);
  for (let i = 0; i < chunks.length - 1; i++) {
    const tailOfCurrent = chunks[i]!.slice(-10);
    assert.ok(chunks[i + 1]!.includes(tailOfCurrent.trim().split(" ").pop() ?? ""), `chunk ${i} and ${i + 1} should share some overlapping text`);
  }
});

test("ingest() writes one chunk per chunkText() split, tags each, and returns their paths in order", async () => {
  const written: { path: string; content: string }[] = [];
  const tagged: unknown[] = [];
  const computer = fakeComputer([
    fakeTool("write_context_file", async (input) => {
      written.push(input as { path: string; content: string });
    }),
    fakeTool("tag_context_file", async (input) => {
      tagged.push(input);
    }),
  ]);

  const text = Array.from({ length: 50 }, (_, i) => `sentence number ${i}.`).join(" ");
  const paths = await ingest(computer, "my source doc", text, { chunk: (t) => chunkText(t, { maxChars: 100 }) });

  assert.ok(paths.length > 1);
  assert.equal(written.length, paths.length);
  assert.equal(tagged.length, paths.length);
  assert.deepEqual(written.map((w) => w.path), paths);
  assert.ok(paths.every((p) => p.startsWith("ingested/my-source-doc")));
});

test("ingest() writes a single chunk under one clean path (no -0 suffix) when the text needs no splitting", async () => {
  const written: { path: string; content: string }[] = [];
  const computer = fakeComputer([
    fakeTool("write_context_file", async (input) => {
      written.push(input as { path: string; content: string });
    }),
    fakeTool("tag_context_file", async () => {}),
  ]);

  const paths = await ingest(computer, "short-doc", "just a short document");

  assert.deepEqual(paths, ["ingested/short-doc.txt"]);
  assert.equal(written[0]?.content, "just a short document");
});

test("ingest() tags each chunk with the given task/relatedApps, defaulting task to source", async () => {
  const tagged: { task?: string; relatedApps?: string[] }[] = [];
  const computer = fakeComputer([
    fakeTool("write_context_file", async () => {}),
    fakeTool("tag_context_file", async (input) => {
      tagged.push(input as { task?: string; relatedApps?: string[] });
    }),
  ]);

  await ingest(computer, "my-doc", "short text");
  await ingest(computer, "my-doc-2", "short text", { task: "custom-task", relatedApps: ["notes"] });

  assert.equal(tagged[0]?.task, "my-doc");
  assert.deepEqual(tagged[1], { path: "ingested/my-doc-2.txt", task: "custom-task", relatedApps: ["notes"] });
});

test("ingest() respects a custom pathPrefix", async () => {
  const computer = fakeComputer([
    fakeTool("write_context_file", async () => {}),
    fakeTool("tag_context_file", async () => {}),
  ]);

  const paths = await ingest(computer, "irrelevant-source-name", "short text", { pathPrefix: "docs/custom" });

  assert.deepEqual(paths, ["docs/custom.txt"]);
});
