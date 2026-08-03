#!/usr/bin/env node
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadManifest } from "@berth/manifest-schema";
import type { BerthApp, AppContext } from "./app.js";
import type { ContextBusClient } from "./context-bus/client.js";
import { createLocalContextBus } from "./context-bus/local.js";
import { createUnixSocketContextBus } from "./context-bus/unix-socket.js";
import type { SemanticFsClient } from "./semantic-fs/client.js";
import { createLocalSemanticFs } from "./semantic-fs/local.js";
import { createUnixSocketSemanticFs } from "./semantic-fs/unix-socket.js";
import { startRpcServer } from "./rpc.js";
import { startHttpRpcServer } from "./http-rpc.js";

const APP_ROOT = process.cwd();
const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? path.join(APP_ROOT, "berth.yml");
const APP_ENTRY = process.env.BERTH_APP_ENTRY ?? path.join(APP_ROOT, "dist", "index.js");
const CONTEXT_BUS_SOCKET = process.env.BERTH_CONTEXT_BUS_SOCKET ?? "/tmp/berth-context-bus.sock";
const SEMANTIC_FS_SOCKET = process.env.BERTH_SEMANTIC_FS_SOCKET ?? "/tmp/berth-semantic-fs.sock";

/**
 * Phase 2's real context bus if the daemon is reachable (see
 * @berth/docker-orchestrator's entrypoint.sh, which starts it before this
 * runtime); falls back to Phase 1's local no-op otherwise, so an app never
 * hard-fails just because it's running outside a sandbox with the daemon
 * (e.g. a bare `node dist/index.js` during a unit test).
 */
async function createContextBus(): Promise<ContextBusClient> {
  try {
    return await createUnixSocketContextBus(CONTEXT_BUS_SOCKET);
  } catch (err) {
    console.error(
      `[berth:runtime] context-bus daemon not reachable at ${CONTEXT_BUS_SOCKET} (${err instanceof Error ? err.message : String(err)}) — falling back to local no-op`,
    );
    return createLocalContextBus();
  }
}

/** Same fallback reasoning as createContextBus(), for Phase 4's semantic-fs-daemon. */
async function createSemanticFs(): Promise<SemanticFsClient> {
  try {
    return await createUnixSocketSemanticFs(SEMANTIC_FS_SOCKET);
  } catch (err) {
    console.error(
      `[berth:runtime] semantic-fs daemon not reachable at ${SEMANTIC_FS_SOCKET} (${err instanceof Error ? err.message : String(err)}) — falling back to local no-op`,
    );
    return createLocalSemanticFs();
  }
}

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

  const contextBus = await createContextBus();
  const semanticFs = await createSemanticFs();

  for (const hook of app._onInstallHooks) {
    await hook();
  }

  const ctx: AppContext = { contextBus, semanticFs, manifest };
  for (const hook of app._onAgentReadyHooks) {
    await hook(ctx);
  }

  startRpcServer(app, { socketPath: process.env.BERTH_RPC_SOCKET });

  // Only set for an instance deployed to a remote fleet (E2B/Daytona/K8s) via
  // @berth/agents's bootNetworkedAgent({fleet}) — never by berth dev/os up.
  // BERTH_HTTP_RPC_PORT/TOKEN are container-wide env (see container.ts's
  // env: Object.entries(...) — every app in a multi-app instance gets the
  // same ones), but only ONE app (the synthesized agent-server, in
  // bootNetworkedAgent's case) should ever bind the listener — every other
  // sibling app's runtime.ts process would otherwise race to bind the exact
  // same port. BERTH_HTTP_RPC_APP names which one; omitted entirely for a
  // single-app deploy, where there's no sibling to collide with.
  const httpRpcPort = process.env.BERTH_HTTP_RPC_PORT ? Number(process.env.BERTH_HTTP_RPC_PORT) : undefined;
  const httpRpcAppName = process.env.BERTH_HTTP_RPC_APP;
  if (httpRpcPort && (!httpRpcAppName || httpRpcAppName === manifest.name)) {
    if (!process.env.BERTH_HTTP_RPC_TOKEN) {
      throw new Error("BERTH_HTTP_RPC_PORT is set but BERTH_HTTP_RPC_TOKEN is not — refusing to listen unauthenticated");
    }
    startHttpRpcServer(app, { port: httpRpcPort, authToken: process.env.BERTH_HTTP_RPC_TOKEN });
  }

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
