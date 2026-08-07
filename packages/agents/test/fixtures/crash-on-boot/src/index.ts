import { defineApp } from "@berth/sdk";
import { z } from "zod";

// computer-boot-failure-milestone.mjs's fixture: an app that dies during
// module load, the way a real one does when a missing native dependency or a
// bad config throws at import time. The marker string is what the test looks
// for in the thrown error, proving the container's own logs reached the
// caller rather than a bare RPC timeout.
//
// Deliberately thrown at module scope, not inside a handler: the point is to
// exercise the path where the container exits *before* anything is listening,
// which is precisely the case Computer.boot() used to report as success.
throw new Error("CRASH_ON_BOOT_FIXTURE_MARKER: deliberate startup failure");

// Unreachable, and only here so this file declares the export its berth.yml
// promises — keeping the manifest and the app in agreement for any tooling
// that checks.
export default defineApp((app) => {
  app.export({
    name: "never_reached",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
});
