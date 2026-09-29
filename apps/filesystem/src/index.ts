import { defineApp, type ContextBusClient, type SemanticFsClient } from "@berthos/sdk";
import { z } from "zod";
import { mkdir, readdir } from "node:fs/promises";
import { readFileUnder, relativeUnder, writeFileUnder } from "./paths.js";

const WORKSPACE_ROOT = process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
const CONTEXT_ROOT = process.env.BERTH_CONTEXT_MOUNT ?? "/context";

// Paths are resolved against the root (see paths.ts): relative ones land under
// it, absolute ones are used as written.
export default defineApp((app) => {
  // Captured at onAgentReady and read inside export handlers — export
  // handlers only receive `input`, not the AppContext, so publishing from
  // one requires closing over the context bus reference like this.
  let contextBus: ContextBusClient | undefined;
  let semanticFs: SemanticFsClient | undefined;

  app.export({
    name: "write_file",
    input: z.object({ path: z.string(), content: z.string() }),
    handler: async ({ path: relativePath, content }) => {
      await writeFileUnder(WORKSPACE_ROOT, relativePath, content);
      await contextBus?.publish("fs.file_created", { path: relativePath, createdBy: "filesystem" });
    },
  });

  app.export({
    name: "read_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFileUnder(WORKSPACE_ROOT, relativePath),
    }),
  });

  app.export({
    name: "list_files",
    output: z.object({ files: z.array(z.string()) }),
    handler: async () => {
      await mkdir(WORKSPACE_ROOT, { recursive: true });
      return { files: await readdir(WORKSPACE_ROOT) };
    },
  });

  app.export({
    name: "write_context_file",
    input: z.object({ path: z.string(), content: z.string() }),
    handler: async ({ path: relativePath, content }) => {
      await writeFileUnder(CONTEXT_ROOT, relativePath, content);
    },
  });

  app.export({
    name: "read_context_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFileUnder(CONTEXT_ROOT, relativePath),
    }),
  });

  app.export({
    name: "tag_context_file",
    input: z.object({ path: z.string(), task: z.string(), relatedApps: z.array(z.string()) }),
    handler: async ({ path: relativePath, task, relatedApps }) => {
      // The key semantic-fs indexes the file under, whichever way the path
      // was spelled, so "/context/a.txt" tags the file write_context_file
      // wrote rather than a second entry beside it.
      await semanticFs?.tag(relativeUnder(CONTEXT_ROOT, relativePath), { task, relatedApps });
    },
  });

  app.export({
    name: "query_context",
    input: z.object({ text: z.string() }),
    output: z.object({ results: z.array(z.any()) }),
    handler: async ({ text }) => ({ results: (await semanticFs?.query(text)) ?? [] }),
  });

  app.export({
    name: "publish_context_event",
    input: z.object({ topic: z.string(), payload: z.any() }),
    handler: async ({ topic, payload }) => {
      await contextBus?.publish(topic, payload);
    },
  });

  app.onAgentReady(async (ctx) => {
    contextBus = ctx.contextBus;
    semanticFs = ctx.semanticFs;
    await ctx.contextBus.register({ app: "filesystem" });
    await ctx.semanticFs.register({ app: "filesystem" });
  });
});
