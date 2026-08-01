import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { runCommand, readScreen, sendKeys } from "./tmux-controller.js";

export default defineApp((app) => {
  app.export({
    name: "run_command",
    input: z.object({ command: z.string() }),
    output: z.object({ output: z.string() }),
    handler: async ({ command }) => ({ output: await runCommand(command) }),
  });

  app.export({
    name: "read_screen",
    output: z.object({ text: z.string() }),
    handler: async () => ({ text: await readScreen() }),
  });

  app.export({
    name: "send_keys",
    input: z.object({ keys: z.string() }),
    handler: async ({ keys }) => {
      await sendKeys(keys);
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "terminal" });
  });
});
