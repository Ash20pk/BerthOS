import { defineApp } from "@berthos/sdk";
import { z } from "zod";

export default defineApp((app) => {
  // Whether a variable is set and its length, never its value.
  app.export({
    name: "secret_status",
    input: z.object({ name: z.string() }),
    output: z.object({ set: z.boolean(), length: z.number() }),
    handler: async ({ name }) => ({ set: process.env[name] !== undefined, length: process.env[name]?.length ?? 0 }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "e2e-vault" });
  });
});
