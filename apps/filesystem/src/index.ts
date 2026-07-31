import { defineApp, type ContextBusClient, type SemanticFsClient } from "@berth/sdk";
import { z } from "zod";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE_ROOT = process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
const CONTEXT_ROOT = process.env.BERTH_CONTEXT_MOUNT ?? "/context";

function resolveInWorkspace(relativePath: string): string {
  return join(WORKSPACE_ROOT, relativePath);
}

function resolveInContext(relativePath: string): string {
  return join(CONTEXT_ROOT, relativePath);
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
      await mkdir(WORKSPACE_ROOT, { recursive: true });
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
      await mkdir(CONTEXT_ROOT, { recursive: true });
      await writeFile(resolveInContext(relativePath), content, "utf-8");
    },
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

  app.onAgentReady(async (ctx) => {
    contextBus = ctx.contextBus;
    semanticFs = ctx.semanticFs;
    await ctx.contextBus.register({ app: "filesystem" });
    await ctx.semanticFs.register({ app: "filesystem" });
  });
});
