import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { abortableSleep, createRunCancellation, withToolTimeout } from "./cancellation.js";
import { RunAbortedError, RunTimeoutError, ToolTimeoutError, isAbortError } from "./errors.js";
import type { LLMProvider, Tool } from "./types.js";

/** An LLM that keeps asking for the same tool, so the loop runs until something stops it. */
function loopingProvider(onCall: (signal: AbortSignal | undefined) => void = () => {}): LLMProvider {
  return {
    name: "looping",
    chat: async ({ signal }) => {
      onCall(signal);
      return { text: "working", toolCalls: [{ id: "1", name: "slow", input: {} }], stop: false };
    },
  };
}

function toolThat(invoke: Tool["invoke"], name = "slow"): Tool {
  return { name, description: name, inputSchema: { type: "object" }, invoke };
}

const never = () => new Promise<never>(() => {});

// ---------------------------------------------------------------------------
// createRunCancellation
// ---------------------------------------------------------------------------

test("costs nothing when a run has neither a signal nor a deadline", () => {
  const c = createRunCancellation("a", undefined, undefined);
  assert.equal(c.signal, undefined);
  c.throwIfCancelled();
});

test("distinguishes a caller's abort from an elapsed deadline", () => {
  const caller = new AbortController();
  const aborted = createRunCancellation("a", caller.signal, 10_000);
  caller.abort();
  assert.throws(() => aborted.throwIfCancelled(), RunAbortedError);
});

test("reports a deadline as a timeout even when the caller also aborted", async () => {
  // Merging the two signals into one would make these indistinguishable, and
  // the caller would be told "you cancelled this" about a run that overran.
  const caller = new AbortController();
  const c = createRunCancellation("a", caller.signal, 1);
  await new Promise((r) => setTimeout(r, 20));
  caller.abort();
  assert.throws(() => c.throwIfCancelled(), RunTimeoutError);
});

// ---------------------------------------------------------------------------
// withToolTimeout
// ---------------------------------------------------------------------------

test("bounds a tool that ignores its signal entirely", async () => {
  // Every tool written before 4.2 ignores the signal, including every
  // resident-app export. If the race waited for the tool to notice, the
  // timeout would be decorative for exactly the tools that need it most.
  await assert.rejects(
    withToolTimeout("slow", 20, undefined, never),
    (err: unknown) => err instanceof ToolTimeoutError && err.toolName === "slow",
  );
});

test("passes a composed signal to a tool that does honour one", async () => {
  let observed: AbortSignal | undefined;
  await assert.rejects(
    withToolTimeout("slow", 20, undefined, (signal) => {
      observed = signal;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }),
  );
  assert.ok(observed);
  assert.equal(observed!.aborted, true);
});

test("does not interfere when no timeout is set", async () => {
  assert.equal(await withToolTimeout("fast", undefined, undefined, async () => "ok"), "ok");
});

// ---------------------------------------------------------------------------
// abortableSleep
// ---------------------------------------------------------------------------

test("abortableSleep wakes on cancellation instead of sitting out its interval", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(abortableSleep(60_000, controller.signal));
  assert.ok(Date.now() - started < 1_000, "should not have waited the full interval");
});

test("abortableSleep rejects immediately for an already-aborted signal", async () => {
  await assert.rejects(abortableSleep(60_000, AbortSignal.abort()));
});

// ---------------------------------------------------------------------------
// Through a real Agent
// ---------------------------------------------------------------------------

test("aborting a run stops it, and reports the abort rather than a tool failure", async () => {
  const controller = new AbortController();
  const agent = new Agent({
    name: "cancellable",
    llm: loopingProvider(),
    tools: [toolThat(never)],
    maxTurns: 100,
  });

  setTimeout(() => controller.abort(), 20);
  await assert.rejects(agent.run("go", { signal: controller.signal }), (err: unknown) => {
    // Not a ToolTimeoutError and not an {error} tool result quietly fed back:
    // cancelling has to end the run, or "stop" means "keep going".
    assert.ok(err instanceof RunAbortedError);
    assert.equal(err.code, "run_aborted");
    // Named AbortError so every layer that checks for a cancellation — the
    // fallback chain, withProviderErrors, a caller's catch — agrees.
    assert.ok(isAbortError(err));
    return true;
  });
});

test("a run's wall-clock deadline ends it with RunTimeoutError", async () => {
  const agent = new Agent({
    name: "slowpoke",
    llm: loopingProvider(),
    tools: [toolThat(never)],
    maxTurns: 100,
    timeoutMs: 30,
  });
  await assert.rejects(agent.run("go"), RunTimeoutError);
});

test("the run's signal reaches the LLM call", async () => {
  let seen: AbortSignal | undefined;
  const agent = new Agent({
    llm: {
      name: "checks-signal",
      chat: async ({ signal }) => {
        seen = signal;
        return { text: "done", toolCalls: [], stop: true };
      },
    },
    tools: [],
    timeoutMs: 5_000,
  });
  await agent.run("go");
  // Without this the loop stops but the in-flight completion runs to its
  // natural end, still being billed for, with nobody waiting on it.
  assert.ok(seen, "provider should have received a signal");
});

test("the run's signal reaches a tool invocation", async () => {
  let seen: AbortSignal | undefined;
  let turn = 0;
  const agent = new Agent({
    llm: {
      name: "one-call",
      chat: async () =>
        turn++ === 0
          ? { toolCalls: [{ id: "1", name: "probe", input: {} }], stop: false }
          : { text: "done", toolCalls: [], stop: true },
    },
    tools: [
      toolThat(async (_input, ctx) => {
        seen = ctx?.signal;
        return "ok";
      }, "probe"),
    ],
    timeoutMs: 5_000,
  });
  await agent.run("go");
  assert.ok(seen, "tool should have received a signal");
});

test("a tool timeout is fed back to the model, not thrown — the run survives it", async () => {
  let turn = 0;
  let sawToolResult: unknown;
  const agent = new Agent({
    llm: {
      name: "recovers",
      chat: async ({ messages }) => {
        if (turn++ === 0) return { toolCalls: [{ id: "1", name: "slow", input: {} }], stop: false };
        sawToolResult = messages.find((m) => m.role === "tool")?.toolResult?.output;
        return { text: "recovered", toolCalls: [], stop: true };
      },
    },
    tools: [toolThat(never)],
    toolTimeoutMs: 20,
  });

  const result = await agent.run("go");

  // One hanging tool must not kill a run — that would make the timeout more
  // destructive than the hang it bounds. The run-level deadline is the
  // backstop for a model that just retries the same slow tool forever.
  assert.equal(result.text, "recovered");
  assert.match((sawToolResult as { error: string }).error, /timed out after 20ms/);
});

test("run()'s own timeoutMs overrides the Agent's", async () => {
  const agent = new Agent({
    name: "a",
    llm: loopingProvider(),
    tools: [toolThat(never)],
    timeoutMs: 60_000,
  });
  const started = Date.now();
  await assert.rejects(agent.run("go", { timeoutMs: 30 }), RunTimeoutError);
  assert.ok(Date.now() - started < 5_000);
});

test("a cancelled manager cancels the worker it delegated to", async () => {
  const controller = new AbortController();
  let workerSawSignal: AbortSignal | undefined;

  const worker = new Agent({
    name: "worker",
    llm: {
      name: "worker-llm",
      chat: async ({ signal }) => {
        workerSawSignal = signal;
        return new Promise<never>(() => {});
      },
    },
    tools: [],
  });

  const manager = new Agent({
    name: "manager",
    llm: {
      name: "manager-llm",
      chat: async () => ({ toolCalls: [{ id: "1", name: "worker", input: { task: "do it" } }], stop: false }),
    },
    tools: [worker.asTool("delegate")],
  });

  setTimeout(() => controller.abort(), 20);
  await assert.rejects(manager.run("go", { signal: controller.signal }));
  // Otherwise a cancelled manager leaves its workers running against a run
  // nobody is listening to any more, still spending tokens.
  assert.ok(workerSawSignal?.aborted, "worker's LLM call should have been aborted too");
});
