import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineApp } from "./app.js";
import { envNetworkPort, invokeExport } from "./rpc.js";

test("invokeExport returns a result for a valid call", async () => {
  const app = defineApp((a) => {
    a.export({
      name: "greet",
      input: z.object({ name: z.string() }),
      output: z.string(),
      handler: ({ name }) => `hello ${name}`,
    });
  });
  const response = await invokeExport(app, { id: "1", export: "greet", input: { name: "world" } });
  assert.deepEqual(response, { id: "1", result: "hello world" });
});

test("invokeExport returns an error for an unknown export", async () => {
  const app = defineApp(() => {});
  const response = await invokeExport(app, { id: "2", export: "missing" });
  assert.deepEqual(response, { id: "2", error: 'no such export "missing"' });
});

/**
 * Regression test: invokeExport() must send the *parsed* output, not the
 * handler's raw return value. A schema with `.default(...)` produces a
 * value that differs from what a handler which omits that field returns —
 * if the response echoed the raw handler result instead of the Zod-parsed
 * one, `retries` would be missing from the wire response entirely instead
 * of defaulting to 0, breaking wire-compatibility with rpc.py's
 * invoke_export(), which always re-serializes through its Pydantic model.
 */
test("invokeExport sends the schema-defaulted output, not the handler's raw return value", async () => {
  const app = defineApp((a) => {
    a.export({
      name: "withDefault",
      output: z.object({ ok: z.boolean(), retries: z.number().default(0) }),
      handler: () => ({ ok: true }) as any,
    });
  });
  const response = await invokeExport(app, { id: "4", export: "withDefault" });
  assert.deepEqual(response, { id: "4", result: { ok: true, retries: 0 } });
});

test("invokeExport returns an error when input fails validation", async () => {
  const app = defineApp((a) => {
    a.export({ name: "strict", input: z.object({ n: z.number() }), handler: ({ n }) => n });
  });
  const response = await invokeExport(app, { id: "3", export: "strict", input: { n: "not a number" } });
  assert.ok("error" in response);
});

// --- The TCP listener's port resolution (claims.md 1 — the transport the
// governance gate sits on that nothing in the product opens for you) ---

/** Restores whatever the ambient environment had, so these tests don't leak into each other. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("envNetworkPort is undefined when nothing opts in — the listener is off by default", () => {
  withEnv({ BERTH_APP_NAME: "filesystem", BERTH_NETWORK_PORT: undefined, BERTH_NETWORK_PORT_FILESYSTEM: undefined }, () => {
    assert.equal(envNetworkPort(), undefined);
  });
});

test("envNetworkPort reads the container-wide BERTH_NETWORK_PORT", () => {
  withEnv({ BERTH_APP_NAME: "filesystem", BERTH_NETWORK_PORT: "9999", BERTH_NETWORK_PORT_FILESYSTEM: undefined }, () => {
    assert.equal(envNetworkPort(), 9999);
  });
});

test("the app-scoped port wins over the container-wide one, so a multi-app container can open exactly one listener", () => {
  withEnv({ BERTH_APP_NAME: "filesystem", BERTH_NETWORK_PORT: "9999", BERTH_NETWORK_PORT_FILESYSTEM: "7777" }, () => {
    assert.equal(envNetworkPort(), 7777);
  });
  // The sibling in that same container sees only the container-wide value —
  // which is the collision the app-scoped form exists to let an author avoid.
  withEnv({ BERTH_APP_NAME: "governance-gate-tester", BERTH_NETWORK_PORT: undefined, BERTH_NETWORK_PORT_FILESYSTEM: "7777" }, () => {
    assert.equal(envNetworkPort(), undefined);
  });
});

test("a kebab-cased app name maps to an underscored variable", () => {
  withEnv({ BERTH_APP_NAME: "code-interpreter", BERTH_NETWORK_PORT: undefined, BERTH_NETWORK_PORT_CODE_INTERPRETER: "8123" }, () => {
    assert.equal(envNetworkPort(), 8123);
  });
});

test("no BERTH_APP_NAME (single-app / stdio) still honours the container-wide port", () => {
  withEnv({ BERTH_APP_NAME: undefined, BERTH_NETWORK_PORT: "5555" }, () => {
    assert.equal(envNetworkPort(), 5555);
  });
});
