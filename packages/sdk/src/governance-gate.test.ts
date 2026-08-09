import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineApp } from "./app.js";
import { invokeExport } from "./rpc.js";

/**
 * REMEDIATION.md 1.13's second half: the gate at the SDK's own dispatch, which
 * is what `berth rpc`, `berth mcp`, the HTTP bridge, the TCP listener and a
 * sibling's direct socket call all pass through.
 *
 * These run against a real Unix socket speaking the real line-JSON framing —
 * a stub governor, not a stubbed transport, since "can the SDK reach a
 * resident app's export" is half of what's under test.
 */

/** Stands in for a `governs: true` resident app. `verdict` decides; `null` means answer nothing at all, which is what a hung governor looks like. */
async function startStubGovernor(
  socketPath: string,
  verdict: ((input: unknown) => { allowed: boolean; reason?: string }) | null,
): Promise<{ seen: unknown[]; close: () => Promise<void> }> {
  const seen: unknown[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        seen.push(request);
        if (!verdict) return; // hang, deliberately
        socket.write(`${JSON.stringify({ id: request.id, result: verdict(request.input) })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Builds the /run/berth/<governor>/peers/<self>/rpc.sock layout the gate dials, rooted in a temp dir. */
async function withGovernor(
  verdict: ((input: unknown) => { allowed: boolean; reason?: string }) | null,
  body: (ctx: { seen: unknown[] }) => Promise<void>,
): Promise<void> {
  // /tmp rather than os.tmpdir(): a Unix socket path is capped at ~104 bytes
  // (sun_path), and macOS's tmpdir() is long enough that the socket path below
  // gets truncated — which silently collides two "unique" temp dirs into the
  // same socket and surfaces as EADDRINUSE. Linux CI would not have caught it.
  const root = await mkdtemp("/tmp/berth-gate-");
  const peerDir = join(root, "run", "berth", "governor", "peers", "worker");
  mkdirSync(peerDir, { recursive: true });
  const governor = await startStubGovernor(join(peerDir, "rpc.sock"), verdict);
  const previous = { ...process.env };
  process.env.BERTH_GOVERNANCE_APP = "governor";
  process.env.BERTH_APP_NAME = "worker";
  process.env.BERTH_GOVERNANCE_SOCKET_ROOT = root;
  delete process.env.BERTH_GOVERNANCE_EXEMPT;
  try {
    await body({ seen: governor.seen });
  } finally {
    process.env = previous;
    await governor.close();
    await rm(root, { recursive: true, force: true });
  }
}

function workerApp() {
  return defineApp((a) => {
    a.export({ name: "transfer_funds", handler: async () => ({ ok: true }) });
  });
}

test("a governor's denial stops the call at the SDK dispatch, whatever transport it arrived on", async () => {
  await withGovernor(() => ({ allowed: false, reason: "not on the allowlist" }), async () => {
    const app = workerApp();
    for (const caller of ["host", "http", "tcp", "sibling-app"]) {
      const response = await invokeExport(app, { id: "1", export: "transfer_funds", input: { amount: 1 } }, caller);
      assert.ok("error" in response, `expected ${caller} to be denied`);
      assert.match(response.error, /governance denied transfer_funds: not on the allowlist/);
    }
  });
});

test("an allowed action runs, and the handler's real result comes back", async () => {
  await withGovernor(() => ({ allowed: true }), async () => {
    const response = await invokeExport(workerApp(), { id: "2", export: "transfer_funds", input: { amount: 1 } }, "host");
    assert.ok("result" in response, `expected the call to run, got ${JSON.stringify(response)}`);
    assert.deepEqual(response.result, { ok: true });
  });
});

test("the governor is told who asked, and the caller is not something the request can set", async () => {
  await withGovernor(() => ({ allowed: true }), async (ctx) => {
    await invokeExport(workerApp(), { id: "3", export: "transfer_funds", input: { amount: 7 } }, "sibling-app");
    const evaluated = ctx.seen.at(-1) as { export: string; input: Record<string, unknown> };
    assert.equal(evaluated.export, "evaluate_action");
    assert.equal(evaluated.input.app, "worker");
    assert.equal(evaluated.input.export, "transfer_funds");
    assert.equal(evaluated.input.caller, "sibling-app");
    assert.deepEqual(evaluated.input.input, { amount: 7 });
  });
});

test("an unreachable governor denies rather than allows — fail-closed", async () => {
  await withGovernor(() => ({ allowed: true }), async () => {
    // Point the gate at a governor that isn't there. "The policy check didn't
    // happen" must never become "the policy check passed" (REMEDIATION.md 1.11).
    process.env.BERTH_GOVERNANCE_APP = "governor-that-never-started";
    const response = await invokeExport(workerApp(), { id: "4", export: "transfer_funds" }, "host");
    assert.ok("error" in response);
    assert.match(response.error, /governance unavailable/);
  });
});

test("a governor that answers with no verdict is unavailable, not consent", async () => {
  await withGovernor(() => ({ notAVerdict: true }) as never, async () => {
    const response = await invokeExport(workerApp(), { id: "5", export: "transfer_funds" }, "host");
    assert.ok("error" in response);
    assert.match(response.error, /governance unavailable/);
  });
});

test("the governor's own exports are never gated — evaluate_action cannot ask itself", async () => {
  await withGovernor(() => ({ allowed: false, reason: "would recurse" }), async () => {
    process.env.BERTH_APP_NAME = "governor"; // this process IS the governor
    const governorApp = defineApp((a) => {
      a.export({ name: "evaluate_action", handler: async () => ({ allowed: true }) });
    });
    const response = await invokeExport(governorApp, { id: "6", export: "evaluate_action", input: {} }, "sibling-app");
    assert.ok("result" in response, `the governor must answer without consulting itself, got ${JSON.stringify(response)}`);
  });
});

test("governance.exempt opts an app out, and the governor is never consulted", async () => {
  await withGovernor(() => ({ allowed: false, reason: "would have denied" }), async (ctx) => {
    process.env.BERTH_GOVERNANCE_EXEMPT = "1";
    const response = await invokeExport(workerApp(), { id: "7", export: "transfer_funds" }, "host");
    assert.ok("result" in response);
    assert.equal(ctx.seen.length, 0, "an exempt app must not cost a governor round trip");
  });
});

test("no governor loaded means no gate and no cost", async () => {
  const previous = { ...process.env };
  delete process.env.BERTH_GOVERNANCE_APP;
  try {
    const response = await invokeExport(workerApp(), { id: "8", export: "transfer_funds" }, "host");
    assert.ok("result" in response);
  } finally {
    process.env = previous;
  }
});
