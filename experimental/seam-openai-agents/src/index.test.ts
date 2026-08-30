import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toOpenAIAgentTools, type BerthTool } from "./index.js";

/**
 * Every assertion here runs against the real `@openai/agents` package (a
 * devDependency), never a stub of it. That is the point: an adapter tested
 * against a hand-written idea of the target library's shape proves the idea,
 * not the adapter, and the shape is exactly what drifts.
 */

function fakeBerthTool(overrides: Partial<BerthTool> = {}): BerthTool & { calls: unknown[]; signals: (AbortSignal | undefined)[] } {
  const calls: unknown[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    name: "read_file",
    description: 'Berth resident app export "read_file" (from filesystem\'s berth.yml)',
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async invoke(input: unknown, ctx?: { signal?: AbortSignal }) {
      calls.push(input);
      signals.push(ctx?.signal);
      return { content: "hello" };
    },
    calls,
    signals,
    ...overrides,
  } as BerthTool & { calls: unknown[]; signals: (AbortSignal | undefined)[] };
}

describe("toOpenAIAgentTools", () => {
  it("produces one function tool per Berth tool, carrying the manifest's own name and schema", async () => {
    const berthTool = fakeBerthTool();
    const [converted] = (await toOpenAIAgentTools([berthTool])) as [{ name: string; description: string; parameters: unknown; type: string }];

    assert.equal(converted.type, "function");
    assert.equal(converted.name, "read_file");
    assert.equal(converted.description, berthTool.description);
    // The compiled berth.yml schema goes through untouched — no Zod round-trip,
    // nothing that could drift from what the resident app actually validates.
    assert.deepEqual(converted.parameters, berthTool.inputSchema);
  });

  it("does not claim strict mode, because Berth's IOSpec schemas cannot satisfy it", async () => {
    const [converted] = (await toOpenAIAgentTools([fakeBerthTool()])) as [{ strict: boolean }];
    // Claiming strict with a schema that has no `additionalProperties: false`
    // would either be rejected by the SDK or quietly send a schema the provider
    // won't honour. The real validation is the resident app's Zod schema at the
    // RPC boundary — a bad call is a denial, not a mis-parse.
    assert.equal(converted.strict, false);
  });

  it("invokes the Berth tool with the model's input and forwards the run's abort signal", async () => {
    const berthTool = fakeBerthTool();
    const [converted] = (await toOpenAIAgentTools([berthTool])) as [{ invoke: (ctx: unknown, input: string) => Promise<unknown> }];

    const controller = new AbortController();
    // The SDK invokes a FunctionTool as invoke(runContext, argsJsonString).
    const result = await converted.invoke({ signal: controller.signal }, JSON.stringify({ path: "/workspace/a.txt" }));

    assert.deepEqual(berthTool.calls, [{ path: "/workspace/a.txt" }]);
    assert.equal(berthTool.signals[0], controller.signal, "a cancelled run must abandon the in-flight resident-app call");
    assert.deepEqual(result, { content: "hello" });
  });

  it("defaults to no approval gate, and plumbs one through when asked", async () => {
    const tools = [fakeBerthTool({ name: "read_file" }), fakeBerthTool({ name: "write_file" })];
    // The SDK normalizes `needsApproval` into a function on the FunctionTool
    // rather than keeping the boolean, so the assertion is on what it decides,
    // not on the field's literal value. Checked against the real package —
    // asserting the boolean passes only against an imagined SDK.
    const decisions = async (converted: unknown[]) =>
      Promise.all(
        (converted as { needsApproval: (ctx: unknown, input: unknown, callId: string) => Promise<boolean> }[]).map((t) =>
          t.needsApproval({}, {}, "call_1"),
        ),
      );

    assert.deepEqual(await decisions(await toOpenAIAgentTools(tools)), [false, false]);

    const gated = await toOpenAIAgentTools(tools, { needsApproval: (tool) => tool.name.startsWith("write") });
    assert.deepEqual(await decisions(gated), [false, true]);
  });

  it("converts an empty tool list to an empty array rather than failing", async () => {
    assert.deepEqual(await toOpenAIAgentTools([]), []);
  });
});
