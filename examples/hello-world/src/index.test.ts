import { test } from "node:test";
import assert from "node:assert/strict";
import app from "./index.js";

test("ping export returns pong", async () => {
  const def = app._exports.get("ping")!;
  const result = await def.handler(undefined);
  assert.deepEqual(result, { message: "pong" });
});
