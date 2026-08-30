import { test } from "node:test";
import assert from "node:assert/strict";
import { generateText, stepCountIs, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { toAiSdkTools, toLangChainTools, toToolSpecs } from "./interop.js";
import type { Tool } from "./types.js";

/**
 * Stands in for a resident-app export: a JSON Schema compiled from a
 * berth.yml IOSpec, and an invoke() that records what it was handed.
 */
function fakeBerthTool(overrides: Partial<Tool> = {}): Tool & { calls: { input: unknown; signal?: AbortSignal }[] } {
  const calls: { input: unknown; signal?: AbortSignal }[] = [];
  return {
    name: "read_file",
    description: 'Berth resident app export "read_file" (from filesystem\'s berth.yml)',
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    invoke: async (input, ctx) => {
      calls.push({ input, signal: ctx?.signal });
      return { content: "hello from a sandbox" };
    },
    calls,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Vercel AI SDK
// ---------------------------------------------------------------------------

test("a Berth tool drives a real AI SDK generateText loop end to end", async () => {
  // The assertion that matters for this module: a tool defined by a
  // berth.yml, with no @berth/agents Agent anywhere, executed by someone
  // else's loop. Run against the real `ai` package rather than a stub of it,
  // because what's being checked is whether the SDK accepts the shape.
  const berthTool = fakeBerthTool();
  let step = 0;

  const model = new MockLanguageModelV3({
    doGenerate: async () =>
      step++ === 0
        ? {
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "read_file",
                input: JSON.stringify({ path: "/workspace/notes.txt" }),
              },
            ],
            warnings: [],
          }
        : {
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            content: [{ type: "text", text: "the file says hello" }],
            warnings: [],
          },
  } as never) as unknown as LanguageModel;

  // The options object is cast, not the tools: the AI SDK's generics require
  // fields (`toolsContext`) that are irrelevant here, and casting `tools`
  // itself would defeat the point of running this against the real package.
  const tools = await toAiSdkTools([berthTool]);
  const result = await generateText({ model, tools, prompt: "read notes.txt", stopWhen: stepCountIs(3) } as never);

  assert.equal(result.text, "the file says hello");
  assert.deepEqual(berthTool.calls[0]?.input, { path: "/workspace/notes.txt" });
});

test("the Berth JSON Schema reaches the SDK intact, as a schema rather than an opaque object", async () => {
  // jsonSchema() is how the AI SDK accepts JSON Schema where it otherwise
  // wants Zod. It does NOT add validation — its `validate` hook is undefined
  // unless you supply one — so this asserts the schema survives the trip,
  // not that the SDK polices it. Input validation happens in the resident
  // app, where the capability is. See interop.ts.
  const berthTool = fakeBerthTool();
  const tools = (await toAiSdkTools([berthTool])) as Record<
    string,
    { description: string; inputSchema: { jsonSchema: { properties?: Record<string, unknown>; required?: string[] } } }
  >;

  assert.ok(tools.read_file, "tool should be keyed by its Berth name");
  assert.match(tools.read_file!.description, /berth\.yml/);
  assert.deepEqual(tools.read_file!.inputSchema.jsonSchema.properties, { path: { type: "string" } });
  assert.deepEqual(tools.read_file!.inputSchema.jsonSchema.required, ["path"]);
});

test("an AI SDK abort reaches the Berth tool's invoke", async () => {
  const berthTool = fakeBerthTool();
  const tools = (await toAiSdkTools([berthTool])) as Record<
    string,
    { execute: (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown> }
  >;

  const controller = new AbortController();
  await tools.read_file!.execute({ path: "/workspace/x" }, { abortSignal: controller.signal });

  // Otherwise a cancelled generateText leaves a resident-app RPC running with
  // nobody waiting on it — the same gap REMEDIATION 4.2 closed for Agent's
  // own loop, reached from someone else's.
  assert.equal(berthTool.calls[0]?.signal, controller.signal);
});

// ---------------------------------------------------------------------------
// LangChain / LangGraph
// ---------------------------------------------------------------------------

test("a Berth tool becomes a callable LangChain tool", async () => {
  const berthTool = fakeBerthTool();
  const [tool] = (await toLangChainTools([berthTool])) as {
    name: string;
    description: string;
    invoke(input: unknown): Promise<unknown>;
  }[];

  assert.equal(tool!.name, "read_file");
  const output = await tool!.invoke({ path: "/workspace/notes.txt" });

  assert.deepEqual(berthTool.calls[0]?.input, { path: "/workspace/notes.txt" });
  // LangChain's tool contract is string content; a resident app returns
  // structured JSON, and handing an object back surfaces much later as an
  // unreadable message in the model's context.
  assert.equal(typeof output, "string");
  assert.match(output as string, /hello from a sandbox/);
});

test("a LangChain tool rejects input the Berth schema forbids", async () => {
  const berthTool = fakeBerthTool();
  const [tool] = (await toLangChainTools([berthTool])) as { invoke(input: unknown): Promise<unknown> }[];

  await assert.rejects(tool!.invoke({ wrong: "field" }));
  assert.equal(berthTool.calls.length, 0, "invalid input should never reach the sandbox");
});

test("a string-returning tool is passed through unchanged rather than double-encoded", async () => {
  const berthTool = fakeBerthTool({ invoke: async () => "already a string" });
  const [tool] = (await toLangChainTools([berthTool])) as { invoke(input: unknown): Promise<unknown> }[];
  assert.equal(await tool!.invoke({ path: "/x" }), "already a string");
});

// ---------------------------------------------------------------------------
// Framework-neutral specs
// ---------------------------------------------------------------------------

test("toToolSpecs exposes the raw schema and a plain call function", async () => {
  const berthTool = fakeBerthTool();
  const [spec] = toToolSpecs([berthTool]);

  assert.equal(spec!.name, "read_file");
  assert.equal(spec!.parameters.properties?.path !== undefined, true);

  const controller = new AbortController();
  await spec!.call({ path: "/workspace/x" }, controller.signal);
  assert.equal(berthTool.calls[0]?.signal, controller.signal);
});

test("names survive multi-app namespacing untouched", async () => {
  // computerToolsFor() names a tool `<app>__<export>` when a Computer holds
  // more than one app. Rewriting that here would break the mapping
  // governance.ts uses to get from a Tool back to its owning app.
  const namespaced = fakeBerthTool({ name: "filesystem__read_file" });
  const tools = (await toAiSdkTools([namespaced])) as Record<string, unknown>;
  assert.ok(tools.filesystem__read_file);
});
