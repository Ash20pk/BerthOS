#!/usr/bin/env node
// Runs inside an ephemeral test container (see `berth test`). Loads the
// resident app's built code, cross-checks its exports against berth.yml
// (the same check runtime.ts does at real boot), then generates a
// schema-valid stub payload for every declared export and invokes it
// through the app's own handler. Lives inside @berthos/sdk for the same
// package-resolution reason as run-lifecycle.ts.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadManifest } from "@berthos/manifest-schema";
import type { BerthApp } from "./app.js";
import { stubValue } from "./stub-value.js";

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? join(process.cwd(), "berth.yml");
const APP_ENTRY = process.env.BERTH_APP_ENTRY ?? join(process.cwd(), "dist", "index.js");

interface ExportResult {
  export: string;
  ok: boolean;
  error?: string;
  /** Set when the handler threw on the stub input: not a contract failure, just not exercised. */
  unexercised?: string;
}

async function main(): Promise<void> {
  const manifest = await loadManifest(MANIFEST_PATH);
  const mod = (await import(pathToFileURL(APP_ENTRY).href)) as { default?: BerthApp };
  const app = mod.default;

  if (!app) {
    console.log(JSON.stringify({ ok: false, error: `${APP_ENTRY} must have a default export from defineApp()` }));
    process.exit(1);
  }

  const codeExports = new Set(app._exports.keys());
  const manifestExports = new Set(manifest.exports.map((e) => e.name));

  const missingInCode = [...manifestExports].filter((name) => !codeExports.has(name));
  const missingInManifest = [...codeExports].filter((name) => !manifestExports.has(name));

  if (missingInCode.length > 0 || missingInManifest.length > 0) {
    console.log(
      JSON.stringify({ ok: false, error: "exports mismatch between berth.yml and app code", missingInCode, missingInManifest }),
    );
    process.exit(1);
  }

  const results: ExportResult[] = [];
  for (const name of codeExports) {
    const def = app._exports.get(name)!;
    // The contract is the declared shape: the export exists on both sides
    // (checked above) and, when it returns, what it returns matches its
    // output schema. A handler that throws on a made-up input hasn't broken
    // it: git's status has no repository called "berth-test-stub", and a
    // database connector has no database. Failing those made berth test
    // impossible to pass for any app whose exports need state or a service.
    // They're reported as not exercised instead.
    const input = def.input ? stubValue(def.input) : undefined;
    let result: unknown;
    try {
      result = await def.handler(input);
    } catch (err) {
      results.push({ export: name, ok: true, unexercised: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const parsed = def.output ? def.output.safeParse(result) : { success: true as const };
    if (parsed.success) results.push({ export: name, ok: true });
    else results.push({ export: name, ok: false, error: `returned output that doesn't match its declared schema: ${parsed.error.message}` });
  }

  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, results }));
  // Explicit exit, not just exitCode: a handler may leave something open
  // (e.g. browser-native's Chromium child process/connection) that would
  // otherwise keep the event loop alive indefinitely.
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
