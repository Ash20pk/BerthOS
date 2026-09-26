/**
 * Berth tools, usable from the OpenAI Agents SDK.
 *
 * BUILD_PLAN M3.3, seam 1. The premise is the same one `@berthos/agents`'s
 * `toAiSdkTools`/`toLangChainTools` were built on and which CONTRIBUTING.md
 * names as the supported path: `@berthos/agents` should not be the price of
 * admission for the thing Berth is differentiated on. A team already running
 * `@openai/agents` has a working loop; what they don't have is a filesystem
 * tool whose write scope is refused by the kernel, a shell whose blast radius
 * is a manifest, or a browser scoped by an egress broker.
 *
 *   const computer = await Computer.boot({ apps: ["apps/filesystem"] });
 *   const agent = new Agent({
 *     name: "assistant",
 *     tools: toOpenAIAgentTools(computer.tools),
 *   });
 *   const result = await run(agent, "summarize every file in /workspace");
 *
 * This lives in its own package rather than in `@berthos/agents/interop` for two
 * reasons. The agents package is frozen (CONTRIBUTING.md § "The agents packages
 * are frozen"), and a seam is a substrate concern, not a framework feature.
 * Nothing here imports `@berthos/agents` at runtime — only its `Tool` *type*,
 * which is three fields and a method.
 *
 * `@openai/agents` is an **optional peer dependency**, imported dynamically.
 * It is a devDependency of this package so the adapter is tested against the
 * real library rather than against a hand-written idea of its shape — the bar
 * REMEDIATION 3.7 set for an adapter, and the reason this file can state the
 * facts below about `parameters` and `strict` rather than guessing them.
 */

/**
 * The shape this adapter needs from a Berth tool. Structurally identical to
 * `@berthos/agents`'s `Tool`, restated rather than imported so that this package
 * has no runtime dependency on the frozen agents package — and so a caller
 * holding tools from anywhere else (the SDK directly, a future non-agents
 * `Computer`) can use the adapter unchanged.
 */
export interface BerthTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input, compiled from the app's `berth.yml` IOSpec. */
  inputSchema: object;
  invoke(input: unknown, ctx?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * The subset of `@openai/agents` this adapter calls, typed against the real
 * package rather than restated by hand. `import type` erases at runtime, so
 * this costs nothing at import time and keeps the package an optional peer —
 * but it means `tsc` checks the `tool()` call below against the actual
 * signature, which is the only way this file's claims about `parameters` and
 * `strict` stay true when the SDK moves.
 */
import type { tool as OpenAITool } from "@openai/agents";

type OpenAIAgentsModule = { tool: typeof OpenAITool };

export interface ToOpenAIAgentToolsOptions {
  /**
   * Per-tool human-approval gate, surfaced through the SDK's own
   * `needsApproval` option: a `true` here turns the tool call into a run
   * *interruption* the caller must approve or reject before Berth is invoked
   * at all.
   *
   * This is deliberately plumbed rather than left out. Berth already has a
   * human-in-the-loop story (the grants-server, `docs/capability-tokens-reference.md`),
   * and a caller running someone else's loop should be able to reach it
   * without leaving that loop. Note what it is and is not: an approval gate in
   * *this* process, in front of the RPC call — broker tier at best, and
   * bypassable by anything that can talk to the app socket directly. It is not
   * a substitute for the manifest, which is what the kernel enforces whether or
   * not this callback exists.
   */
  needsApproval?: (tool: BerthTool) => boolean;
}

/**
 * Berth tools as OpenAI Agents SDK function tools — the shape `new Agent({ tools })`
 * takes.
 *
 * Three details, each checked against `@openai/agents` 0.17.0 rather than
 * assumed:
 *
 * **`parameters` takes a JSON Schema directly.** `ToolInputParameters` is
 * `undefined | ZodObjectLike | StandardSchemaWithJSON | JsonObjectSchema`, so
 * Berth's compiled IOSpec schema goes in as-is with no Zod round-trip and no
 * schema translation layer that could drift from what the app actually
 * validates.
 *
 * **`strict` is set to `false`, on purpose.** The SDK's strict mode requires
 * `additionalProperties: false` and every property in `required`; Berth's
 * schemas come from `berth.yml`'s flat IOSpec and carry neither. Claiming
 * strict here would either make the SDK reject well-formed Berth manifests or
 * silently send a schema the model provider won't honour. The validation that
 * matters happens where the capability lives: the resident app's own Zod schema
 * rejects malformed input at the RPC boundary, and a bad call is a denial, not
 * a mis-parse.
 *
 * **`execute` forwards the run's `AbortSignal`.** A cancelled `run()` really
 * does abandon an in-flight resident-app call, the same contract
 * REMEDIATION 4.2 gave `Agent`'s loop — reached from someone else's loop.
 */
export async function toOpenAIAgentTools(
  tools: BerthTool[],
  options: ToOpenAIAgentToolsOptions = {},
): Promise<unknown[]> {
  const { tool: openaiTool } = await importOpenAIAgents();
  return tools.map((berthTool) =>
    openaiTool({
      name: berthTool.name,
      description: berthTool.description,
      // Berth's inputSchema is a JSON object schema by construction — it is
      // compiled from berth.yml's IOSpec by `inputSchemaFor()`. The cast tells
      // the compiler that; it does not paper over a shape mismatch.
      parameters: berthTool.inputSchema as Parameters<typeof openaiTool>[0]["parameters"],
      strict: false,
      needsApproval: options.needsApproval ? options.needsApproval(berthTool) : false,
      execute: async (input: unknown, runContext?: { signal?: AbortSignal }) =>
        berthTool.invoke(input, { signal: runContext?.signal }),
    } as Parameters<typeof openaiTool>[0]),
  );
}

/**
 * A single error message for a missing optional peer, rather than the
 * module-not-found a bare dynamic import produces — which names an internal
 * file path and doesn't tell the reader the package is deliberately not a
 * dependency. Same treatment `@berthos/agents`'s interop module gives `ai` and
 * `@langchain/core`.
 */
async function importOpenAIAgents(): Promise<OpenAIAgentsModule> {
  try {
    return (await import("@openai/agents")) as OpenAIAgentsModule;
  } catch (err) {
    throw new Error(
      `toOpenAIAgentTools() needs the "@openai/agents" package, which @berthos/seam-openai-agents ` +
        `deliberately does not depend on — install it alongside this package to use the adapter. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
