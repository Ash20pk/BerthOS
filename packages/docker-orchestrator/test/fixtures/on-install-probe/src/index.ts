// Fixture app for packages/docker-orchestrator/test/on-install-milestone.mjs
// (REMEDIATION 1.5). One export, reading an absolute path and reporting
// whether it exists rather than throwing — the test asks it about files an
// on_install may or may not have created, and "absent" is the expected
// answer for half of them.
//
// Reads are unrestricted here because the manifest declares no
// filesystem:read: capability, which leaves read scoping at its open default
// (see @berth/sdk's generate-capability-policy.ts). That's what lets this app
// look at /etc without being able to write there.
import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { readFile } from "node:fs/promises";

export default defineApp((app) => {
  app.export({
    name: "read_path",
    input: z.object({ path: z.string() }),
    output: z.object({ exists: z.boolean(), content: z.string() }),
    handler: async ({ path }) => {
      try {
        return { exists: true, content: (await readFile(path, "utf-8")).trim() };
      } catch {
        return { exists: false, content: "" };
      }
    },
  });
});
