import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { getPage } from "./cdp-controller.js";
import { buildSearchUrl, parseSearchResults } from "./search-results.js";

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

  // A convenience export, not a new capability — this app's browser:navigate:*
  // grant already lets an agent reach any URL, so navigate()+get_page_text()
  // could already compose into "read whatever a search engine returns" before
  // this export existed. What was missing was ergonomics: a model shouldn't
  // have to know a search engine's URL template or wade through a whole
  // page's unstructured text just to get back {title, url, snippet} triples.
  app.export({
    name: "search",
    input: z.object({ query: z.string(), maxResults: z.number().optional() }),
    output: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })) }),
    handler: async ({ query, maxResults }) => {
      const page = await getPage();
      await page.goto(buildSearchUrl(query));
      const html = await page.content();
      return { results: parseSearchResults(html, maxResults) };
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "browser-native" });
  });
});
