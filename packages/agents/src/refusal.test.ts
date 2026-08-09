import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { HumanApprovalDeniedError } from "./approval.js";
import { GuardrailTripwireError } from "./guardrails.js";
import { GovernanceDeniedError } from "./governance.js";
import type { CheckpointStore } from "./checkpoint.js";
import type { LLMProvider, Tool, LLMTurn } from "./types.js";

/**
 * REMEDIATION 3.4. HumanApprovalDeniedError was thrown from inside
 * tool.invoke, so the loop's own tool-error handling caught it and fed it
 * back as an `{error}` tool result — the model could then re-issue the
 * identical call and open a fresh grant request. Documented as fail-closed,
 * behaving as advisory.
 */

/** An LLM that asks for the same tool call on every turn until told to stop. */
function insistentLLM(toolName: string, calls: { count: number }): LLMProvider {
  return {
    name: "insistent",
    async chat(): Promise<LLMTurn> {
      calls.count++;
      if (calls.count > 5) return { text: "giving up", toolCalls: [], stop: true };
      return {
        text: undefined,
        toolCalls: [{ id: `t${calls.count}`, name: toolName, input: {} }],
        stop: false,
      };
    },
  };
}

function toolThatThrows(name: string, err: Error, invocations: { count: number }): Tool {
  return {
    name,
    description: "",
    inputSchema: { type: "object" },
    invoke: async () => {
      invocations.count++;
      throw err;
    },
  };
}

test("a denied human approval ends the run instead of becoming a tool result", async () => {
  const turns = { count: 0 };
  const invocations = { count: 0 };
  const agent = new Agent({
    name: "gated",
    llm: insistentLLM("deploy", turns),
    tools: [toolThatThrows("deploy", new HumanApprovalDeniedError("deploy", "not on a Friday"), invocations)],
  });

  await assert.rejects(
    () => agent.run("ship it"),
    (err: unknown) => {
      assert.ok(err instanceof HumanApprovalDeniedError);
      assert.equal(err.toolName, "deploy");
      assert.equal(err.reason, "not on a Friday");
      return true;
    },
  );

  // The heart of the bug: before this, the denial came back as a tool result
  // and the model simply asked again, opening a fresh grant each time.
  assert.equal(invocations.count, 1, `the denied tool was re-invoked ${invocations.count} times`);
  assert.equal(turns.count, 1, "the model got another turn after being refused");
});

test("a guardrail tripped inside a nested agent-as-tool ends the outer run too", async () => {
  const turns = { count: 0 };
  const invocations = { count: 0 };
  const agent = new Agent({
    name: "outer",
    llm: insistentLLM("inner", turns),
    tools: [toolThatThrows("inner", new GuardrailTripwireError("output", "leaked a secret"), invocations)],
  });

  await assert.rejects(() => agent.run("go"), GuardrailTripwireError);
  assert.equal(invocations.count, 1);
});

/**
 * The deliberate exclusion, asserted so it can't drift into a refusal by
 * accident. A governance gate is a policy engine shaping which actions an
 * agent may take; an agent denied one action and trying another is the
 * intended behaviour, and governance.ts is explicitly advisory (it even
 * fails open). A human saying no is a different thing.
 */
test("a governance denial still feeds back as a tool result the model can work around", async () => {
  let toolCalls = 0;
  const llm: LLMProvider = {
    name: "two-step",
    async chat({ messages }): Promise<LLMTurn> {
      const sawToolResult = messages.some((m) => m.role === "tool");
      if (!sawToolResult) {
        return { text: undefined, toolCalls: [{ id: "t1", name: "blocked", input: {} }], stop: false };
      }
      return { text: "understood, doing something else", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({
    name: "governed",
    llm,
    tools: [
      {
        name: "blocked",
        description: "",
        inputSchema: { type: "object" },
        invoke: async () => {
          toolCalls++;
          throw new GovernanceDeniedError("some-app", "blocked", "policy says no");
        },
      },
    ],
  });

  const result = await agent.run("go");

  assert.equal(result.text, "understood, doing something else");
  assert.equal(toolCalls, 1);
  // The denial reached the model as a result rather than ending the run.
  assert.match(JSON.stringify(result.toolCalls[0]!.result), /policy says no/);
});

/**
 * The positive control: an ordinary tool failure must still be recoverable,
 * or this change would have converted every transient error into a dead run.
 */
test("an ordinary tool failure still feeds back to the model and the run continues", async () => {
  let attempts = 0;
  const llm: LLMProvider = {
    name: "retrying",
    async chat({ messages }): Promise<LLMTurn> {
      const sawToolResult = messages.some((m) => m.role === "tool");
      if (!sawToolResult) {
        return { text: undefined, toolCalls: [{ id: "t1", name: "flaky", input: {} }], stop: false };
      }
      return { text: "recovered", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({
    name: "resilient",
    llm,
    tools: [
      {
        name: "flaky",
        description: "",
        inputSchema: { type: "object" },
        invoke: async () => {
          attempts++;
          throw new Error("connection reset");
        },
      },
    ],
  });

  const result = await agent.run("go");
  assert.equal(result.text, "recovered");
  assert.equal(attempts, 1);
});

/**
 * A refusal is a terminal outcome, so it checkpoints as "error" — the same
 * treatment a tripped output guardrail and an exhausted responseSchema
 * repair budget already get. Without this, a resumed run would restart from
 * a stale "running" checkpoint and re-request the denied action.
 */
test("a refusal checkpoints the run as an error rather than leaving it running", async () => {
  const saved: { runId: string; status: string }[] = [];
  const store: CheckpointStore = {
    async save(checkpoint) {
      saved.push({ runId: checkpoint.runId, status: checkpoint.status });
    },
    async load() {
      return null;
    },
  };

  const agent = new Agent({
    name: "gated",
    llm: insistentLLM("deploy", { count: 0 }),
    tools: [toolThatThrows("deploy", new HumanApprovalDeniedError("deploy", "no"), { count: 0 })],
    checkpoint: store,
  });

  await assert.rejects(() => agent.run("ship it", { runId: "run-9" }), HumanApprovalDeniedError);
  assert.equal(saved.at(-1)?.status, "error", `last checkpoint was ${JSON.stringify(saved.at(-1))}`);
});
