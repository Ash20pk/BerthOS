// Fixture app for packages/docker-orchestrator/test/capability-enforcement.mjs's
// cross-app boundary test. Identical to boundary-app-a/-b's source — only each
// one's berth.yml differs (scoped to its own /workspace/apps/<name>
// subdirectory only, same pattern as mesh-echo-planner/-browser). Deliberately
// no path validation of its own here: any escape must be caught by the
// kernel (Landlock), not by app code, or the test proves nothing about
// enforcement.
import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";

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

  // The 1.4 exploit, as an export: connect to a Unix socket by absolute path
  // and say what happened. Deliberately reports rather than throws, so the
  // test can tell "refused by the kernel" apart from "nothing was listening"
  // — an absence test that passes because the socket simply isn't there would
  // prove nothing about the boundary.
  app.export({
    name: "probe_unix_socket",
    input: z.object({ path: z.string() }),
    output: z.object({ connected: z.boolean(), code: z.string() }),
    handler: ({ path: socketPath }) =>
      new Promise((resolve) => {
        const socket = createConnection(socketPath);
        const done = (connected: boolean, code: string) => {
          socket.destroy();
          resolve({ connected, code });
        };
        socket.on("connect", () => done(true, ""));
        socket.on("error", (err: NodeJS.ErrnoException) => done(false, err.code ?? err.message));
      }),
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
