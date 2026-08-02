// Fixture app for packages/docker-orchestrator/test/capability-enforcement.mjs's
// cross-app boundary test. Identical to boundary-app-b's source — only each
// one's berth.yml differs (scoped to its own /workspace/apps/<name>
// subdirectory only, same pattern as mesh-echo-planner/-browser). Deliberately
// no path validation of its own here: any escape must be caught by the
// kernel (Landlock), not by app code, or the test proves nothing about
// enforcement.
import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export default defineApp((app) => {
  app.export({
    name: "write_file",
    input: z.object({ path: z.string(), content: z.string() }),
    handler: async ({ path: relativePath, content }) => {
      const absolutePath = join(process.cwd(), relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
    },
  });

  app.export({
    name: "read_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFile(join(process.cwd(), relativePath), "utf-8"),
    }),
  });
});
