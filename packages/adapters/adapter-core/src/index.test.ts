import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "./index.js";

test("withTimeout resolves normally when the promise settles before the deadline", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 1000, "fast call");
  assert.equal(result, "ok");
});

test("withTimeout rejects with a clear error when the promise never settles in time", async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(neverSettles, 20, "slow call"),
    /slow call timed out after 20ms/,
  );
});

test("withTimeout propagates the original rejection when the promise fails before the deadline", async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("boom")), 1000, "failing call"),
    /boom/,
  );
});
