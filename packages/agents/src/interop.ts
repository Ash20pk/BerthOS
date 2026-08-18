/**
 * Berth tools, usable from the agent frameworks people already run.
 *
 * The premise of this module is that `@berth/agents` should not be the price
 * of admission for the thing Berth is actually differentiated on. A team on
 * the Vercel AI SDK, on LangGraph, or on the Claude Agent SDK has a working
 * loop already, and no appetite for swapping it. What they don't have is a
 * filesystem tool whose write scope is enforced by the kernel, a shell whose
 * blast radius is a manifest, or a browser scoped by an egress broker.
 *
 * So: boot a `Computer`, hand its tools to whatever loop you already have.
 *
 *   const computer = await Computer.boot({ apps: ["apps/filesystem"] });
 *   const result = await generateText({
 *     model: openai("gpt-4o"),
 *     tools: toAiSdkTools(computer.tools),
 *     prompt: "summarize every file in /workspace",
 *   });
 *
 * `berth mcp` is the third door and predates this module — an MCP server
 * reaches Claude Code, Cursor, and anything else speaking the protocol with
 * no adapter at all. These two exist for the in-process case, where MCP's
 * subprocess/HTTP hop is overhead rather than a feature.
 *
 * **Both target packages are optional peer dependencies, imported
 * dynamically.** Nothing here is on the import path of `Computer` or `Agent`,
 * so a caller who uses neither framework never installs either, and a caller
 * who uses one never installs the other. Both are devDependencies of this
 * package, so both adapters are tested against the real library rather than
 * against a hand-written idea of its shape — which is what the
 * REMEDIATION 3.7 work established as the bar for an adapter.
 */

import type { Tool } from "./types.js";

/** JSON Schema shape a Tool carries, narrowed just enough to read its properties. Berth's own schemas come from `berth.yml`'s flat IOSpec, so this is always an object schema. */
type JsonSchemaObject = { type?: string; properties?: Record<string, unknown>; required?: string[] };

/**
 * A Berth Tool as a Vercel AI SDK tool, keyed by tool name — the shape
 * `generateText`/`streamText`/`useChat` take as their `tools` option.
 *
 * The schema goes through the SDK's `jsonSchema()` wrapper, which is how it
 * accepts a JSON Schema where it otherwise expects a Zod schema — Berth's
 * schemas are compiled from `berth.yml`'s IOSpec and are JSON Schema by the
 * time they reach here.
 *
 * **That wrapper does not add validation**, which is worth stating because
 * it looks like it should: `jsonSchema()` leaves its `validate` hook
 * undefined unless you supply one, so the AI SDK forwards whatever the model
 * produced straight to `execute`. Checked against the real package rather
 * than assumed, after this module's first draft claimed the opposite.
 *
 * No validator is supplied here, deliberately. The resident app already
 * validates: an export's own Zod schema rejects malformed input at the RPC
 * boundary, and `Agent`'s loop has `formatToolInputError()` precisely to
 * reformat those failures. Adding a second, weaker check in this process
 * would mean shipping a JSON Schema validator dependency to duplicate a
 * check that already happens where the capability actually lives.
 *
 * `execute` forwards the AI SDK's own `abortSignal`, so a cancelled
 * `generateText` really does abandon an in-flight resident-app call — the
 * same contract REMEDIATION 4.2 gave `Agent`'s loop, reached from someone
 * else's loop.
 */
export async function toAiSdkTools(tools: Tool[]): Promise<Record<string, unknown>> {
  const { jsonSchema, tool: aiTool } = await importAi();
  return Object.fromEntries(
    tools.map((berthTool) => [
      berthTool.name,
      aiTool({
        description: berthTool.description,
        inputSchema: jsonSchema(berthTool.inputSchema as Record<string, unknown>),
        execute: async (input: unknown, options?: { abortSignal?: AbortSignal }) =>
          berthTool.invoke(input, { signal: options?.abortSignal }),
      }),
    ]),
  );
}

/**
 * A Berth Tool as a LangChain `DynamicStructuredTool`, usable anywhere
 * LangChain or LangGraph takes a tool — `createReactAgent({ tools })`,
 * `ToolNode`, `bindTools`.
 *
 * LangChain wants a Zod schema, and Berth's schemas are JSON Schema. Rather
 * than translate — a lossy exercise, and one this repo already does in the
 * other direction in `tools.ts` — the JSON Schema is passed through
 * LangChain's own support for it, which its tool constructor accepts
 * directly.
 *
 * The result is stringified when it isn't already a string, because
 * LangChain's tool contract expects string content and a resident app's
 * exports return structured JSON. Returning an object where a string is
 * expected surfaces much later as an unreadable message in a model's context.
 */
export async function toLangChainTools(tools: Tool[]): Promise<unknown[]> {
  const { DynamicStructuredTool } = await importLangChain();
  return tools.map(
    (berthTool) =>
      new DynamicStructuredTool({
        name: berthTool.name,
        description: berthTool.description,
        schema: berthTool.inputSchema,
        func: async (input: unknown, _runManager?: unknown, config?: { signal?: AbortSignal }) => {
          const result = await berthTool.invoke(input, { signal: config?.signal });
          return typeof result === "string" ? result : JSON.stringify(result);
        },
      }),
  );
}

/**
 * The framework-neutral form: name, description, JSON Schema, and a call
 * function.
 *
 * Every adapter above is a few lines on top of this, and so is the one for
 * whichever framework isn't covered here — Anthropic's raw tool-use API,
 * OpenAI's function calling, a bespoke loop. Exported so that "my framework
 * isn't in the list" is a five-line problem rather than a fork.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input, exactly as compiled from the app's `berth.yml`. */
  parameters: JsonSchemaObject;
  call(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Berth tools as plain specs, with no framework dependency at all. */
export function toToolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((berthTool) => ({
    name: berthTool.name,
    description: berthTool.description,
    parameters: berthTool.inputSchema as JsonSchemaObject,
    call: (input: unknown, signal?: AbortSignal) => berthTool.invoke(input, { signal }),
  }));
}

/**
 * A single error message for a missing optional peer, rather than the
 * module-not-found a bare dynamic import would produce — which names an
 * internal file path and doesn't tell the reader that the package is
 * deliberately not a dependency.
 */
async function importOptional<T>(specifier: string, usedFor: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (err) {
    throw new Error(
      `${usedFor} needs the "${specifier}" package, which @berth/agents deliberately does not depend on — ` +
        `install it alongside @berth/agents to use this adapter. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

type AiModule = {
  jsonSchema: (schema: Record<string, unknown>) => unknown;
  tool: (definition: Record<string, unknown>) => unknown;
};

type LangChainModule = {
  DynamicStructuredTool: new (fields: Record<string, unknown>) => unknown;
};

function importAi(): Promise<AiModule> {
  return importOptional<AiModule>("ai", "toAiSdkTools()");
}

function importLangChain(): Promise<LangChainModule> {
  return importOptional<LangChainModule>("@langchain/core/tools", "toLangChainTools()");
}
