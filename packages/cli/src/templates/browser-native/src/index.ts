import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { getPage } from "./cdp-controller.js";

export default defineApp((app) => {
  app.export({
    name: "navigate",
    input: z.object({ url: z.string() }),
    handler: async ({ url }) => {
      const page = await getPage();
      await page.goto(url);
    },
  });

  app.export({
    name: "click",
    input: z.object({ selector: z.string() }),
    handler: async ({ selector }) => {
      const page = await getPage();
      await page.click(selector);
    },
  });

  app.export({
    name: "get_page_text",
    output: z.object({ text: z.string() }),
    handler: async () => {
      const page = await getPage();
      const text = await page.innerText("body");
      return { text };
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "{{name}}" });
  });
});
