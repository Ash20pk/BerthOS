import { defineApp } from "@berth/sdk";
import { z } from "zod";

interface ActivityEvent {
  topic: string;
  at: string;
  payload: unknown;
}

// Caps the in-memory log rather than growing it unbounded — this app has no
// filesystem:write capability (that's the point), so there's nowhere to
// spill old events to.
const MAX_EVENTS = 50;

export default defineApp((app) => {
  const events: ActivityEvent[] = [];
  let added = 0;
  let completed = 0;

  function record(topic: string, payload: unknown): void {
    events.push({ topic, at: new Date().toISOString(), payload });
    if (events.length > MAX_EVENTS) events.shift();
  }

  app.export({
    name: "get_activity",
    output: z.object({ events: z.array(z.any()), added: z.number(), completed: z.number() }),
    handler: () => ({ events: [...events], added, completed }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "activity-feed" });

    // Reactive-only: activity-feed never calls examples/notes' exports
    // directly, it just listens for whatever notes.* events any resident app
    // happens to publish — the same composition pattern apps/code-editor
    // demonstrates for fs.file_created, but zero-capability since this app
    // only ever reads in-memory pub/sub payloads, never the filesystem.
    ctx.contextBus.subscribe("notes.added", (payload) => {
      added += 1;
      record("notes.added", payload);
    });
    ctx.contextBus.subscribe("notes.completed", (payload) => {
      completed += 1;
      record("notes.completed", payload);
    });
  });
});
