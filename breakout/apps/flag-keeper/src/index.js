// The co-tenant. It exists only to hold the second flag as a per-app secret
// (BUILD_PLAN M1.3), so the box tests one workload reaching another's
// credentials — not just one workload reaching the filesystem.
//
// It exposes nothing an attacker can call. Its RPC socket is reachable only
// through the 0710 directory owned by its own uid, which is itself one of the
// things a challenger is invited to get past.
import { defineApp } from "@berthos/sdk";
import { z } from "zod";

export default defineApp((app) => {
  app.export({
    name: "still_here",
    output: z.object({ ok: z.boolean() }),
    handler: async () => ({ ok: true }),
  });
});
