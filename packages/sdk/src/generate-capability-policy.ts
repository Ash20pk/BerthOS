#!/usr/bin/env node
// Runs inside the container before agent-init applies kernel-level
// enforcement (see packages/agent-init). Translates berth.yml's declared
// `capabilities:` into a small JSON policy agent-init can read without
// needing a YAML parser or capability-glob logic in Rust — @berth/sdk (via
// @berth/manifest-schema, already a dependency) is the single place that
// understands the capability-string grammar.
//
// Phase 3 scope: only filesystem:write:<path> capabilities translate into
// real kernel enforcement right now (Landlock write-access restriction).
// Every other declared capability (filesystem:read:*, browser:*, github:*,
// ...) is recorded in `declaredCapabilities` for @berth/sdk's
// requestCapability() to report on, but isn't kernel-enforced yet — see
// docs/capability-tokens-reference.md for why (domain-scoped network
// filtering and read-path restriction are real, harder problems deferred
// past this pass).
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadManifest, parseCapability } from "@berth/manifest-schema";

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? join(process.cwd(), "berth.yml");
const POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY ?? join(process.cwd(), ".berth", "capability-policy.json");

// Always writable regardless of what's declared: /tmp (scratch files, and
// the context-bus Unix socket lives there) plus the context-bus socket path
// itself, since connecting to a Unix socket requires write access to it.
const BASELINE_WRITE_PATHS = ["/tmp"];

interface CapabilityPolicy {
  appName: string;
  declaredCapabilities: string[];
  writePaths: string[];
}

function stripTrailingGlob(scope: string): string {
  return scope.endsWith("/*") ? scope.slice(0, -2) : scope;
}

async function main(): Promise<void> {
  const manifest = await loadManifest(MANIFEST_PATH);

  const writePaths = new Set(BASELINE_WRITE_PATHS);
  for (const capability of manifest.capabilities) {
    const parsed = parseCapability(capability);
    if (parsed.namespace === "filesystem" && parsed.action === "write") {
      writePaths.add(stripTrailingGlob(parsed.scope));
    }
  }

  const policy: CapabilityPolicy = {
    appName: manifest.name,
    declaredCapabilities: manifest.capabilities,
    writePaths: [...writePaths],
  };

  await mkdir(dirname(POLICY_PATH), { recursive: true });
  await writeFile(POLICY_PATH, JSON.stringify(policy, null, 2));
  console.error(`[berth:capability-policy] wrote ${POLICY_PATH}: writePaths=${policy.writePaths.join(", ")}`);
}

main().catch((err) => {
  console.error("[berth:capability-policy] fatal error:", err);
  process.exit(1);
});
