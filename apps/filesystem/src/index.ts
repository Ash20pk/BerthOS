import { defineApp, type ContextBusClient, type SemanticFsClient } from "@berthos/sdk";
import { z } from "zod";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const WORKSPACE_ROOT = process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
const CONTEXT_ROOT = process.env.BERTH_CONTEXT_MOUNT ?? "/context";

// resolve(), not join(): a relative path lands under the root, and an
// absolute one is taken as written. join() turned "/workspace/calc.txt" into
// /workspace/workspace/calc.txt, which an agent passing the full path it was
// told about never meant. Either way the kernel decides whether the result is
// inside the declared scope.
function resolveInWorkspace(relativePath: string): string {
  return resolve(WORKSPACE_ROOT, relativePath);
}

function resolveInContext(relativePath: string): string {
  return resolve(CONTEXT_ROOT, relativePath);
}

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
      const absolutePath = resolveInWorkspace(relativePath);
      // The file's own directory, not just the root: an agent writing
      // reports/q4.md into a fresh workspace has no other way to create
      // reports/. A directory outside the declared scope is refused by the
      // kernel here, the same as the write would be.
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
      await contextBus?.publish("fs.file_created", { path: relativePath, createdBy: "filesystem" });
    },
  });

  app.export({
    name: "read_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFile(resolveInWorkspace(relativePath), "utf-8"),
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
      const absolutePath = resolveInContext(relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
    },
  });

  app.export({
    name: "read_context_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFile(resolveInContext(relativePath), "utf-8"),
    }),
  });

  app.export({
    name: "tag_context_file",
    input: z.object({ path: z.string(), task: z.string(), relatedApps: z.array(z.string()) }),
    handler: async ({ path: relativePath, task, relatedApps }) => {
      await semanticFs?.tag(relativePath, { task, relatedApps });
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
