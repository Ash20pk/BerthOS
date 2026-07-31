#!/usr/bin/env node
// Runs inside an ephemeral test container (see `berth test`). Loads the
// resident app's built code, cross-checks its exports against berth.yml
// (the same check runtime.ts does at real boot), then generates a
// schema-valid stub payload for every declared export and invokes it
// through the app's own handler. Lives inside @berth/sdk for the same
// package-resolution reason as run-lifecycle.ts.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import type { BerthApp } from "./app.js";

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? join(process.cwd(), "berth.yml");
const APP_ENTRY = process.env.BERTH_APP_ENTRY ?? join(process.cwd(), "dist", "index.js");

interface ExportResult {
  export: string;
  ok: boolean;
  error?: string;
}

// Type-only stub generation (a random string satisfies z.string()) isn't
// always a *useful* stub — a field named "url" or "selector" needs a
// semantically valid value or a real handler (like browser-native's
// `page.goto`/`page.click`) will legitimately reject it. This is a plain
// field-name heuristic, not a schema feature — it only covers the common
// cases worth guessing at.
const FIELD_NAME_HINTS: Record<string, string> = {
  url: "https://example.com",
  selector: "body",
  email: "test@example.com",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubValue(zodType: any, fieldName?: string): unknown {
  const typeName = zodType?._def?.typeName;
  switch (typeName) {
    case "ZodString":
      return (fieldName && FIELD_NAME_HINTS[fieldName]) ?? "berth-test-stub";
    case "ZodNumber":
      return 1;
    case "ZodBoolean":
      return true;
    case "ZodArray":
      return [];
    case "ZodObject": {
      const shape = zodType._def.shape();
      const obj: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) obj[key] = stubValue(shape[key], key);
      return obj;
    }
    case "ZodOptional":
    case "ZodNullable":
      return undefined;
    default:
      return null;
  }
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
    try {
      const input = def.input ? stubValue(def.input) : undefined;
      const result = await def.handler(input);
      if (def.output) def.output.parse(result);
      results.push({ export: name, ok: true });
    } catch (err) {
      results.push({ export: name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
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
