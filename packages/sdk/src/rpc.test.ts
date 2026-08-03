import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineApp } from "./app.js";
import { invokeExport } from "./rpc.js";

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
