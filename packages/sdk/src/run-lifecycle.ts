#!/usr/bin/env node
// Runs inside the container before the main runtime starts (see entrypoint.sh).
// Three jobs: run each on_install command exactly once (tracked via a marker
// file so `berth dev` restarts don't re-run e.g. `pip install`), report
// whether the manifest declares a browser:* capability so entrypoint.sh
// knows whether to start Xvfb/x11vnc/websockify, and separately report
// whether it declares browser:navigate:*/network:host:* so entrypoint.sh
// knows whether to start the egress broker — a deliberately different check
// from "needs a display": network:host:* apps need the broker but never
// Xvfb, and this is what makes the broker a capability any resident app can
// opt into, not something wired specifically for browser-native's Chromium
// launch flag. Lives inside @berth/sdk (not a loose script copied from
// docker-orchestrator) specifically so it can import @berth/manifest-schema
// through normal package resolution — pnpm's per-package node_modules only
// resolves declared dependencies, and @berth/sdk already declares
// @berth/manifest-schema as one.
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
      execSync(command, { stdio: "inherit", cwd: process.cwd() });
    }
    mkdirSync(dirname(MARKER_PATH), { recursive: true });
    writeFileSync(MARKER_PATH, new Date().toISOString());
  } else {
    console.error(`[berth:lifecycle] on_install already ran (marker at ${MARKER_PATH}), skipping`);
  }

  const needsBrowser = manifest.capabilities.some((cap) => cap.startsWith("browser:"));
  const needsEgressBroker = manifest.capabilities.some((cap) => cap.startsWith("browser:navigate:") || cap.startsWith("network:host:"));
  // A single comma-separated line, not two lines — entrypoint.sh's
  // `tail -n1` only ever captures the last stdout line, which needs to carry
  // both flags together.
  console.log(`${needsBrowser ? "1" : "0"},${needsEgressBroker ? "1" : "0"}`);
}

main().catch((err) => {
  console.error("[berth:lifecycle] fatal error:", err);
  process.exit(1);
});
