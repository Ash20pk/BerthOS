import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAuditSink, type Actor } from "@berthos/audit";
import type { RpcRequest, RpcResponse, StdioRpcCallOptions } from "@berthos/docker-orchestrator";
import { createInFlightCalls, createShutdown, handleToolCall, rpcTimeoutFor, TIMEOUT_MS_GRACE, type ToolCallContext } from "./mcp-call.js";
import { createRunAudit } from "./run-audit.js";

const actor: Actor = { kind: "agent", id: "test-client", verifiedBy: "self-asserted" };

function context(call: ToolCallContext["call"]) {
  const sink = createMemoryAuditSink();
  const runAudit = createRunAudit({ sink, runId: "run-1", app: "filesystem", containerName: "berth-dev-filesystem", via: "mcp", actor: () => actor, operator: actor });
  const inFlight = createInFlightCalls();
  const ctx: ToolCallContext = {
    export: "write_file",
    call,
    explain: (error) => (error.startsWith("EACCES") ? `BERTH CAPABILITY DENIAL\n${error}` : error),
    runAudit,
    callTimeoutMs: 30_000,
    inFlight,
  };
  return { sink, runAudit, inFlight, ctx };
}

const answer = (response: Omit<RpcResponse, "id">) => async (request: RpcRequest) => ({ id: request.id, ...response });

test("a call that succeeds returns the result and is recorded as allowed", async () => {
  const { sink, ctx, inFlight } = context(answer({ result: { ok: true } }));
  const result = await handleToolCall(ctx, { path: "/workspace/a" });
  assert.deepEqual(result, { content: [{ type: "text", text: '{"ok":true}' }] });
  assert.equal(sink.records.length, 1);
  assert.equal(sink.records[0]!.decision, "allowed");
  assert.equal(sink.records[0]!.reason, undefined);
  assert.equal(inFlight.size, 0);
});

test("a sandbox refusal is explained to the agent and recorded as denied", async () => {
  const { sink, ctx } = context(answer({ error: "EACCES: permission denied, open '/etc/x'" }));
  const result = await handleToolCall(ctx, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /^BERTH CAPABILITY DENIAL/);
  assert.equal(sink.records[0]!.decision, "denied");
  assert.equal(sink.records[0]!.reason, "EACCES: permission denied, open '/etc/x'");
});

test("an app error is recorded as an allowed call that failed", async () => {
  const { sink, ctx } = context(answer({ error: "TypeError: x is undefined" }));
  const result = await handleToolCall(ctx, {});
  assert.equal(result.isError, true);
  assert.equal(sink.records[0]!.decision, "allowed");
  assert.equal((sink.records[0]!.meta as { failed?: boolean }).failed, true);
});

// The call that used to vanish: `await rpc.call()` rejected, the handler
// threw, and nothing reached the audit trail.
test("a call the app never answers is recorded, and the agent is told it may have run", async () => {
  const { sink, ctx, inFlight } = context(async () => {
    throw new Error("timed out after 30s waiting for RPC response");
  });
  const result = await handleToolCall(ctx, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /no answer from "write_file": timed out .* may have run/);
  assert.equal(sink.records.length, 1);
  assert.match(sink.records[0]!.reason!, /no answer from the app: timed out/);
  assert.equal((sink.records[0]!.meta as { outcome?: string }).outcome, "unknown");
  assert.equal(inFlight.size, 0);
});

test("the RPC waits for the call's own timeout_ms, plus headroom, when it is longer than the bridge's", async () => {
  const seen: StdioRpcCallOptions[] = [];
  const { ctx } = context(async (request, options) => {
    seen.push(options);
    return { id: request.id, result: {} };
  });
  await handleToolCall(ctx, { code: "sleep 50", timeout_ms: 60_000 });
  await handleToolCall(ctx, { code: "true" });
  assert.equal(seen[0]!.timeoutMs, 60_000 + TIMEOUT_MS_GRACE);
  assert.equal(seen[1]!.timeoutMs, 30_000);
  assert.equal(rpcTimeoutFor({ timeout_ms: 1_000 }, 30_000), 30_000);
  assert.equal(rpcTimeoutFor({ timeout_ms: "60000" }, 30_000), 30_000);
});

test("a call still in flight when the session ends is recorded once, as interrupted", async () => {
  let release!: (response: RpcResponse) => void;
  const { sink, ctx, inFlight, runAudit } = context(
    (request) =>
      new Promise((resolve) => {
        release = resolve;
        void request;
      }),
  );
  const call = handleToolCall(ctx, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inFlight.size, 1);

  await inFlight.interruptAll(runAudit);
  assert.equal(sink.records.length, 1);
  assert.equal((sink.records[0]!.meta as { interrupted?: boolean }).interrupted, true);

  // The answer arriving afterwards doesn't write a second, contradicting record.
  release({ id: "x", result: {} });
  await call;
  assert.equal(sink.records.length, 1);
});

test("shutdown waits for the boot evidence record before stopping the sandbox, then records in-flight calls", async () => {
  const order: string[] = [];
  let recordEvidence!: () => void;
  const evidence = new Promise<void>((resolve) => {
    recordEvidence = () => {
      order.push("evidence recorded");
      resolve();
    };
  });
  const shutdown = createShutdown({
    pending: () => evidence,
    pendingTimeoutMs: 5_000,
    interrupt: async () => void order.push("interrupted"),
    stop: async () => void order.push("stopped"),
    exit: () => order.push("exit"),
  });
  const done = shutdown();
  void shutdown(); // a second trigger (stdin end after SIGTERM) is the same shutdown
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, [], "nothing is stopped while the evidence is still being recorded");
  recordEvidence();
  await done;
  assert.deepEqual(order, ["evidence recorded", "interrupted", "stopped", "exit"]);
});

test("shutdown stops waiting for the evidence at its timeout", async () => {
  const order: string[] = [];
  await createShutdown({
    pending: () => new Promise(() => {}),
    pendingTimeoutMs: 10,
    interrupt: async () => {},
    stop: async () => void order.push("stopped"),
    exit: () => order.push("exit"),
  })();
  assert.deepEqual(order, ["stopped", "exit"]);
});
