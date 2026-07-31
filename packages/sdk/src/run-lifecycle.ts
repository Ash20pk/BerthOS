#!/usr/bin/env node
// Runs inside the container before the main runtime starts (see entrypoint.sh).
// Two jobs: run each on_install command exactly once (tracked via a marker
// file so `berth dev` restarts don't re-run e.g. `pip install`), and report
// whether the manifest declares a browser:* capability so entrypoint.sh
// knows whether to start Xvfb/x11vnc/websockify. Lives inside @berth/sdk
// (not a loose script copied from docker-orchestrator) specifically so it
// can import @berth/manifest-schema through normal package resolution —
// pnpm's per-package node_modules only resolves declared dependencies, and
// @berth/sdk already declares @berth/manifest-schema as one.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { loadManifest } from "@berth/manifest-schema";

// Relative to process.cwd() (the container's WorkingDir), not a hardcoded
// /app — the app's working directory varies depending on whether it's a
// standalone app (/app) or a pnpm workspace member (/workspace/<path>).
const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? join(process.cwd(), "berth.yml");
const MARKER_PATH = process.env.BERTH_INSTALL_MARKER ?? join(process.cwd(), ".berth", "installed");

async function main(): Promise<void> {
  const manifest = await loadManifest(MANIFEST_PATH);

  if (!existsSync(MARKER_PATH)) {
    for (const command of manifest.on_install) {
      console.error(`[berth:lifecycle] running on_install: ${command}`);
      execSync(command, { stdio: "inherit", cwd: "/app" });
    }
    mkdirSync(dirname(MARKER_PATH), { recursive: true });
    writeFileSync(MARKER_PATH, new Date().toISOString());
  } else {
    console.error(`[berth:lifecycle] on_install already ran (marker at ${MARKER_PATH}), skipping`);
  }

  const needsBrowser = manifest.capabilities.some((cap) => cap.startsWith("browser:"));
  console.log(needsBrowser ? "1" : "0");
}

main().catch((err) => {
  console.error("[berth:lifecycle] fatal error:", err);
  process.exit(1);
});
