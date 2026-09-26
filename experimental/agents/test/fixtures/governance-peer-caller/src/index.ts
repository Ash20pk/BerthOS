import { defineApp } from "@berthos/sdk";
import { z } from "zod";

// A fixture that exists for its *manifest*, not its code: declaring
// `app:invoke:filesystem` is what provisions
// /run/berth/filesystem/peers/governance-peer-caller/rpc.sock, the sibling
// channel governance-gate-milestone.mjs sends a denied write_file over.
//
// It exports `ping` only so that the app is a well-formed resident app with
// something to answer; the milestone never calls it.
export default defineApp((app) => {
  app.export({
    name: "ping",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
});
