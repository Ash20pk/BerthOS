import { defineApp } from "@berth/sdk";
import { z } from "zod";

// governance-gate-milestone.mjs's fixture governance app: denies write_file
// outright (any app/input), allows everything else. Proves
// applyGovernanceGate() actually routes other apps' tool calls through this
// app's evaluate_action export before letting them through.
export default defineApp((app) => {
  app.export({
    name: "evaluate_action",
    input: z.object({ app: z.string(), export: z.string(), input: z.record(z.string(), z.unknown()) }),
    output: z.object({ allowed: z.boolean(), reason: z.string() }),
    handler: ({ export: exportName }) => {
      if (exportName === "write_file") {
        return { allowed: false, reason: "writes are blocked by this test fixture's policy" };
      }
      return { allowed: true, reason: "allowed" };
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "governance-gate-tester" });
  });
});
