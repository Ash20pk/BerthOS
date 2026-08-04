import { defineApp, configureEgressProxy } from "@berth/sdk";
import { z } from "zod";

// The one line this app needs for entrypoint.sh's egress broker (started
// because berth.yml declares network:host:example.com) to actually carry
// its traffic — no Chromium launch flag, no bespoke proxy wiring, just
// this. A no-op outside a container that started one (e.g. this file's own
// unit test), so fetch_text below still works normally there.
configureEgressProxy();

export default defineApp((app) => {
  app.export({
    name: "fetch_text",
    input: z.object({ url: z.string() }),
    output: z.object({ text: z.string() }),
    handler: async ({ url }) => {
      const res = await fetch(url);
      return { text: await res.text() };
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "http-fetch" });
  });
});
