import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalContextBus } from "@berth/sdk";
import app from "./index.js";

// `app` is a module-level singleton (defineApp() runs once at import, same
// as every real resident app for its whole container lifetime) — its event
// buffer persists across this file's assertions rather than resetting per
// test, so this is deliberately one sequential scenario instead of several
// independent tests that would each assume a fresh buffer they don't get.
test("fans in known topics into one ordered, capped feed", async () => {
  const contextBus = createLocalContextBus();
  for (const hook of app._onAgentReadyHooks) {
    await hook({ contextBus, semanticFs: undefined as never, manifest: undefined as never });
  }
  const getRecentActivity = app._exports.get("get_recent_activity")!;

  assert.deepEqual(await getRecentActivity.handler(undefined), { events: [] });

  await contextBus.publish("fs.file_created", { path: "hello.txt", createdBy: "filesystem" });
  await contextBus.publish("notes.added", { id: "1", text: "buy milk" });
  await contextBus.publish("notes.completed", { id: "1" });
  await contextBus.publish("some.unsubscribed.topic", { ignored: true });

  const afterThree = (await getRecentActivity.handler(undefined)) as {
    events: { topic: string; payload: unknown; receivedAt: number }[];
  };
  assert.equal(afterThree.events.length, 3);
  assert.deepEqual(
    afterThree.events.map((e) => e.topic),
    ["notes.completed", "notes.added", "fs.file_created"], // most-recent-first
  );
  assert.deepEqual(afterThree.events[0]?.payload, { id: "1" });
  for (const event of afterThree.events) assert.equal(typeof event.receivedAt, "number");

  for (let i = 0; i < 60; i++) {
    await contextBus.publish("notes.added", { id: `bulk-${i}` });
  }
  const afterBulk = (await getRecentActivity.handler(undefined)) as { events: { payload: unknown }[] };
  assert.equal(afterBulk.events.length, 50);
  assert.deepEqual(afterBulk.events[0]?.payload, { id: "bulk-59" }); // most recent survives the cap
});
