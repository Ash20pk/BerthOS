import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineApp } from "./app.js";

test("defineApp registers exports and hooks", () => {
  const app = defineApp((a) => {
    a.export({ name: "ping", handler: () => "pong" });
    a.onAgentReady(() => {});
  });
  assert.equal(app._exports.size, 1);
  assert.equal(app._onAgentReadyHooks.length, 1);
});

test("defineApp rejects duplicate export names", () => {
  assert.throws(() => {
    defineApp((a) => {
      a.export({ name: "dup", handler: () => 1 });
      a.export({ name: "dup", handler: () => 2 });
    });
  });
});

test("export handler runs with zod-validated input/output", async () => {
  const app = defineApp((a) => {
    a.export({
      name: "add",
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.number(),
      handler: ({ a, b }) => a + b,
    });
  });
  const def = app._exports.get("add")!;
  const result = await def.handler(def.input!.parse({ a: 1, b: 2 }));
  assert.equal(result, 3);
});
