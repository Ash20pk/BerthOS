import { defineApp } from "@berthos/sdk";
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
    name: "fill",
    input: z.object({ selector: z.string(), value: z.string() }),
    handler: async ({ selector, value }) => {
      const page = await getPage();
      await page.fill(selector, value);
    },
  });

  app.export({
    name: "press",
    input: z.object({ selector: z.string(), key: z.string() }),
    handler: async ({ selector, key }) => {
      const page = await getPage();
      await page.press(selector, key);
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
