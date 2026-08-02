// Fixture app for packages/docker-orchestrator/test/mesh-milestone.mjs — a
// minimal resident app whose only real job is a plain HTTP echo listener on
// 0.0.0.0:9000, reachable by mesh IP once mesh-coordinator's mutual-match
// introduction wires it into a peer's wg0. Identical across
// mesh-echo-planner/-browser/-intruder; only each one's berth.yml differs
// (see docs/mesh-reference.md).
import { defineApp } from "@berth/sdk";
import { z } from "zod";
import http from "node:http";
import { execSync } from "node:child_process";

const PEER_NAME = process.env.BERTH_MESH_PEER_NAME ?? "unknown";

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: PEER_NAME });

    // Verifies the capability-bounding-set drop in packages/agent-init: this
    // process — even though it declared network:peer:* and the container was
    // granted NET_ADMIN for mesh-daemon's benefit — must NOT itself be able
    // to touch the network stack at that level. `docker exec` can't test
    // this (a fresh exec'd process gets the container spec's capabilities
    // regardless of what this process's own bounding set has been reduced
    // to) — only a probe running inside this exact process, after agent-init
    // already exec'd into it, actually proves the fix.
    try {
      execSync("ip link add berth-captest0 type dummy", { stdio: "ignore" });
      execSync("ip link del berth-captest0", { stdio: "ignore" });
      console.error(`[mesh-echo] WARNING "${PEER_NAME}": this process still has NET_ADMIN — capability bounding-set drop did not take effect`);
    } catch {
      console.error(`[mesh-echo] confirmed "${PEER_NAME}": this process cannot create network interfaces (no NET_ADMIN)`);
    }

    http
      .createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ from: PEER_NAME }));
      })
      .listen(9000, "0.0.0.0", () => {
        console.error(`[mesh-echo] listening on 0.0.0.0:9000 as "${PEER_NAME}"`);
      });
  });
});
