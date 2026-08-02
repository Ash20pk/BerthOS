#!/usr/bin/env node
// Runs inside the container before agent-init applies kernel-level
// enforcement (see packages/agent-init). Translates berth.yml's declared
// `capabilities:` into a small JSON policy agent-init can read without
// needing a YAML parser or capability-glob logic in Rust — @berth/sdk (via
// @berth/manifest-schema, already a dependency) is the single place that
// understands the capability-string grammar.
//
// Phase 3 scope: filesystem:write:<path> always translates into real kernel
// enforcement (Landlock write-access restriction). filesystem:read:<path> is
// opt-in — only enforced when at least one is declared, because enumerating
// every path Node/Alpine need to read to run at all is fragile; an app that
// declares none keeps today's fully-open read behavior.
//
// network:connect:<port> is deny-by-default (not opt-in): an app that
// declares no network:connect capability gets zero outbound TCP, full stop.
// An app that genuinely needs to reach arbitrary hosts (e.g. browser-native)
// declares network:connect:* — the explicit, audited escape hatch — which
// skips building a per-port ruleset entirely rather than enumerating all
// 65535 ports. Every other declared capability (browser:navigate:*,
// github:*, ...) is still just recorded in `declaredCapabilities` for
// @berth/sdk's requestCapability() to report on — see
// docs/capability-tokens-reference.md.
//
// network:peer:<name> (see docs/mesh-reference.md) collects declared peer
// name globs into `meshPeers` for mesh-daemon to read (not enforced here —
// mesh-daemon and mesh-coordinator's mutual-match introduction are the real
// authorization layer, since Landlock has no UDP access right to restrict
// wg0 traffic with). The one thing this file DOES enforce: declaring any
// network:peer:* capability adds mesh-coordinator's own TCP port to the
// existing networkPorts allow-list, so an app that never opted into the mesh
// can't reach the coordinator's registration API at all.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadManifest, parseCapability } from "@berth/manifest-schema";

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? join(process.cwd(), "berth.yml");
const POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY ?? join(process.cwd(), ".berth", "capability-policy.json");
const GRANTS_SERVER_URL = process.env.BERTH_GRANTS_SERVER_URL;
const MESH_COORDINATOR_PORT = Number(process.env.BERTH_MESH_COORDINATOR_PORT ?? 4875);

// Always writable regardless of what's declared: /tmp (scratch files, and
// the context-bus Unix socket lives there) plus the context-bus socket path
// itself, since connecting to a Unix socket requires write access to it.
const BASELINE_WRITE_PATHS = ["/tmp"];

// Only added when read scoping is actually enabled (i.e. the app declared at
// least one filesystem:read:<path> capability) — these are the paths Node,
// Alpine, and this app's own working directory need to function at all.
// Declaring a read path narrows visibility to baseline-plus-declared, never
// below what the runtime itself needs.
const BASELINE_READ_PATHS = ["/usr", "/lib", "/etc", "/proc", "/dev", "/tmp", process.cwd()];

interface CapabilityPolicy {
  appName: string;
  declaredCapabilities: string[];
  writePaths: string[];
  readPaths: string[];
  networkPorts: number[];
  networkUnrestricted: boolean;
  meshPeers: string[];
}

function stripTrailingGlob(scope: string): string {
  return scope.endsWith("/*") ? scope.slice(0, -2) : scope;
}

/** Best-effort: an unreachable/misconfigured grants server degrades to static-only policy, never fails the boot. */
async function fetchApprovedCapabilities(appName: string): Promise<string[]> {
  if (!GRANTS_SERVER_URL) return [];
  try {
    const url = `${GRANTS_SERVER_URL.replace(/\/$/, "")}/grants?status=approved&app=${encodeURIComponent(appName)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const grants = (await res.json()) as { capability: string }[];
    return grants.map((g) => g.capability);
  } catch (err) {
    console.error(`[berth:capability-policy] WARNING: couldn't reach grants server at ${GRANTS_SERVER_URL} (${err}) — using statically declared capabilities only`);
    return [];
  }
}

async function main(): Promise<void> {
  const manifest = await loadManifest(MANIFEST_PATH);
  const approved = await fetchApprovedCapabilities(manifest.name);
  const effectiveCapabilities = [...manifest.capabilities, ...approved];

  const writePaths = new Set(BASELINE_WRITE_PATHS);
  const declaredReadPaths = new Set<string>();
  const networkPorts = new Set<number>();
  const meshPeers = new Set<string>();
  let networkUnrestricted = false;

  for (const capability of effectiveCapabilities) {
    const parsed = parseCapability(capability);
    if (parsed.namespace === "filesystem" && parsed.action === "write") {
      writePaths.add(stripTrailingGlob(parsed.scope));
    } else if (parsed.namespace === "filesystem" && parsed.action === "read") {
      declaredReadPaths.add(stripTrailingGlob(parsed.scope));
    } else if (parsed.namespace === "network" && parsed.action === "connect") {
      if (parsed.scope === "*") {
        networkUnrestricted = true;
        continue;
      }
      const port = Number(parsed.scope);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        networkPorts.add(port);
      } else {
        console.error(`[berth:capability-policy] WARNING: ignoring invalid network:connect scope "${parsed.scope}" (expected a port 1-65535, or "*")`);
      }
    } else if (parsed.namespace === "network" && parsed.action === "peer") {
      meshPeers.add(parsed.scope);
      networkPorts.add(MESH_COORDINATOR_PORT);
    }
  }

  // Opt-in: only restrict reads at all if the app declared at least one
  // filesystem:read:<path> capability — otherwise leave readPaths empty,
  // which agent-init treats as "don't touch read access."
  const readPaths = declaredReadPaths.size > 0 ? [...new Set([...BASELINE_READ_PATHS, ...declaredReadPaths])] : [];

  const policy: CapabilityPolicy = {
    appName: manifest.name,
    declaredCapabilities: effectiveCapabilities,
    writePaths: [...writePaths],
    readPaths,
    networkPorts: [...networkPorts],
    networkUnrestricted,
    meshPeers: [...meshPeers],
  };

  await mkdir(dirname(POLICY_PATH), { recursive: true });
  await writeFile(POLICY_PATH, JSON.stringify(policy, null, 2));
  const networkSummary = networkUnrestricted
    ? "networkPorts=* (unrestricted)"
    : networkPorts.size > 0
      ? `networkPorts=${[...networkPorts].join(", ")}`
      : "networkPorts=(none — network denied by default)";
  console.error(
    `[berth:capability-policy] wrote ${POLICY_PATH}: writePaths=${policy.writePaths.join(", ")}` +
      (readPaths.length > 0 ? `; readPaths=${readPaths.join(", ")}` : "") +
      `; ${networkSummary}` +
      (meshPeers.size > 0 ? `; meshPeers=${[...meshPeers].join(", ")}` : ""),
  );
}

main().catch((err) => {
  console.error("[berth:capability-policy] fatal error:", err);
  process.exit(1);
});
