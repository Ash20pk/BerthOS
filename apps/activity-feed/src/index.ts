import { defineApp } from "@berth/sdk";
import { z } from "zod";

interface ActivityEvent {
  topic: string;
  payload: unknown;
  receivedAt: number;
}

const MAX_EVENTS = 50;

// The context bus has no wildcard subscribe (see docs/context-bus-reference.md)
// — fanning in means naming every topic another first-party app is known to
// publish, the same explicit-topic-string dependency apps/code-editor already
// has on apps/filesystem's "fs.file_created".
const TOPICS = ["fs.file_created", "notes.added", "notes.completed"] as const;

export default defineApp((app) => {
  // A publisher never gets its own event echoed back, and there's no
  // message replay — this only ever sees events published after it
  // subscribes, same limitation apps/code-editor has.
  const events: ActivityEvent[] = [];

  function record(topic: string, payload: unknown): void {
    events.push({ topic, payload, receivedAt: Date.now() });
    if (events.length > MAX_EVENTS) events.shift();
  }

  app.export({
    name: "get_recent_activity",
    output: z.object({ events: z.array(z.any()) }),
    handler: () => ({ events: [...events].reverse() }), // most-recent-first
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "activity-feed" });
    for (const topic of TOPICS) {
      ctx.contextBus.subscribe(topic, (payload) => record(topic, payload));
    }
  });
});
