import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalContextBus, createLocalSemanticFs, type AppContext } from "@berth/sdk";
import app from "./index.js";

test("get_activity tallies notes.added/notes.completed events published over the context bus", async () => {
  const contextBus = createLocalContextBus();
  const ctx: AppContext = {
    contextBus,
    semanticFs: createLocalSemanticFs(),
    manifest: { name: "activity-feed", version: "0.1.0", description: "", capabilities: [], exports: [], on_install: [], on_agent_ready: [] },
  };
  for (const hook of app._onAgentReadyHooks) await hook(ctx);

  await contextBus.publish("notes.added", { id: "1", text: "buy milk" });
  await contextBus.publish("notes.added", { id: "2", text: "walk the dog" });
  await contextBus.publish("notes.completed", { id: "1" });

  const getActivity = app._exports.get("get_activity")!;
  const result = (await getActivity.handler(undefined)) as { events: unknown[]; added: number; completed: number };

  assert.equal(result.added, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.events.length, 3);
});

test("get_activity ignores topics it never subscribed to", async () => {
  const contextBus = createLocalContextBus();
  const ctx: AppContext = {
    contextBus,
    semanticFs: createLocalSemanticFs(),
    manifest: { name: "activity-feed", version: "0.1.0", description: "", capabilities: [], exports: [], on_install: [], on_agent_ready: [] },
  };
  for (const hook of app._onAgentReadyHooks) await hook(ctx);

  const getActivity = app._exports.get("get_activity")!;
  const before = (await getActivity.handler(undefined)) as { events: unknown[]; added: number; completed: number };

  await contextBus.publish("fs.file_created", { path: "irrelevant.txt" });

  const after = (await getActivity.handler(undefined)) as { events: unknown[]; added: number; completed: number };
  assert.equal(after.added, before.added);
  assert.equal(after.completed, before.completed);
  assert.equal(after.events.length, before.events.length);
});
