import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Paths resolve against the root, so an absolute path is read as written
// rather than nested under it (same as apps/filesystem).
const WORKSPACE_ROOT = process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";

export default defineApp((app) => {
  app.export({
    name: "open_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFile(resolve(WORKSPACE_ROOT, relativePath), "utf-8"),
    }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "code-editor" });

    // This is the reactive path the Phase 2 milestone is about: code-editor
    // never gets told directly to open a file. It subscribes once, and
    // reacts whenever *any* app (filesystem, in this demo) publishes
    // "fs.file_created" — no explicit orchestration wires them together.
    ctx.contextBus.subscribe("fs.file_created", async (payload) => {
      const event = payload as { path: string; createdBy: string };
      try {
        const content = await readFile(resolve(WORKSPACE_ROOT, event.path), "utf-8");
        console.error(
          `[code-editor] reactively opened "${event.path}" (${content.length} bytes) after fs.file_created from "${event.createdBy}"`,
        );
      } catch (err) {
        console.error(`[code-editor] fs.file_created for "${event.path}" but couldn't open it: ${err}`);
      }
    });
  });
});
