import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { checkExport } from "./export-check.js";

const input = z.object({ repo: z.string() });
const output = z.object({ n: z.number() });

test("an export that returns output matching its schema passes", async () => {
  assert.deepEqual(await checkExport("ok", { name: "ok", input, output, handler: () => ({ n: 1 }) }), { export: "ok", ok: true });
});

test("output that doesn't match the declared schema fails", async () => {
  const r = await checkExport("bad", { name: "bad", input, output, handler: () => ({ n: "one" }) as never });
  assert.equal(r.ok, false);
  assert.match(r.error!, /doesn't match its declared schema/);
});

test("a handler refusing the stub input is reported as not exercised, not failed", async () => {
  const r = await checkExport("status", {
    name: "status",
    input,
    output,
    handler: ({ repo }: any) => {
      throw new Error(`there's no repository at ${repo}`);
    },
  });
  assert.deepEqual(r, { export: "status", ok: true, unexercised: "there's no repository at berth-test-stub" });
});

test("a TypeError or ReferenceError from the code itself still fails", async () => {
  const typeError = await checkExport("t", {
    name: "t",
    input,
    output,
    handler: (i: any) => ({ n: i.missing.length }),
  });
  assert.equal(typeError.ok, false);
  assert.match(typeError.error!, /^threw TypeError/);
  const referenceError = await checkExport("r", {
    name: "r",
    input,
    output,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: () => ({ n: (globalThis as any).eval("notDefinedAnywhere") }),
  });
  assert.equal(referenceError.ok, false);
  assert.match(referenceError.error!, /^threw ReferenceError/);
});

test("a TypeError carrying a cause, as fetch's network failures do, is not exercised", async () => {
  const r = await checkExport("fetch", {
    name: "fetch",
    input,
    output,
    handler: () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.com") });
    },
  });
  assert.deepEqual(r, { export: "fetch", ok: true, unexercised: "fetch failed" });
});
