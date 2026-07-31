#!/usr/bin/env node
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadManifest } from "@berth/manifest-schema";
import type { BerthApp, AppContext } from "./app.js";
import { createLocalContextBus } from "./context-bus/local.js";
import { startRpcServer } from "./rpc.js";

const APP_ROOT = process.cwd();
const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? path.join(APP_ROOT, "berth.yml");
const APP_ENTRY = process.env.BERTH_APP_ENTRY ?? path.join(APP_ROOT, "dist", "index.js");

async function main(): Promise<void> {
  console.error(`[berth:runtime] loading manifest from ${MANIFEST_PATH}`);
  const manifest = await loadManifest(MANIFEST_PATH);

  console.error(`[berth:runtime] loading app entry ${APP_ENTRY}`);
  const mod = (await import(pathToFileURL(APP_ENTRY).href)) as { default?: BerthApp };
  const app = mod.default;
  if (!app) {
    throw new Error(`${APP_ENTRY} must have a default export from defineApp()`);
  }

  assertExportsMatchManifest(app, manifest.exports.map((e) => e.name));

  const contextBus = createLocalContextBus();

  for (const hook of app._onInstallHooks) {
    await hook();
  }

  const ctx: AppContext = { contextBus, manifest };
  for (const hook of app._onAgentReadyHooks) {
    await hook(ctx);
  }

  startRpcServer(app);
  console.error(`[berth:runtime] "${manifest.name}" ready`);
}

/**
 * Hard-fails boot if the app's code and its berth.yml disagree about which
 * exports exist. This is what keeps berth.yml trustworthy for later phases —
 * Phase 3's capability tokens and Phase 5's registry both need to trust that
 * the manifest accurately describes what the app does.
 */
function assertExportsMatchManifest(app: BerthApp, declaredExports: string[]): void {
  const codeExports = new Set(app._exports.keys());
  const manifestExports = new Set(declaredExports);

  const missingInCode = [...manifestExports].filter((name) => !codeExports.has(name));
  const missingInManifest = [...codeExports].filter((name) => !manifestExports.has(name));

  if (missingInCode.length > 0 || missingInManifest.length > 0) {
    const problems: string[] = [];
    if (missingInCode.length > 0) {
      problems.push(`declared in berth.yml but not implemented: ${missingInCode.join(", ")}`);
    }
    if (missingInManifest.length > 0) {
      problems.push(`implemented in code but not declared in berth.yml: ${missingInManifest.join(", ")}`);
    }
    throw new Error(`exports mismatch between berth.yml and app code — ${problems.join("; ")}`);
  }
}

main().catch((err) => {
  console.error("[berth:runtime] fatal error during startup:", err);
  process.exitCode = 1;
});
