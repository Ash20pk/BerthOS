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
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadManifest, parseCapability, CapabilityString, type ParsedCapability } from "@berth/manifest-schema";

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

export interface CapabilityPolicy {
  appName: string;
  declaredCapabilities: string[];
  writePaths: string[];
  readPaths: string[];
  networkPorts: number[];
  networkUnrestricted: boolean;
  meshPeers: string[];
  // Ports this app is allowed to bind()/listen() on — separate from
  // networkPorts (outbound AccessNet::ConnectTcp only) because Landlock
  // denies AccessNet::BindTcp by default too the moment network access is
  // restricted at all (see agent-init/src/main.rs's `AccessNet::from_all`),
  // and no capability namespace/action exists for "this app needs to listen
  // on a port" — it's not something a berth.yml author declares, it's an
  // orchestration-level fact (see computeBindPorts()).
  bindPorts: number[];
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

/**
 * The pure namespace:action:scope -> CapabilityPolicy compiler, split out
 * from main() so it can be fuzzed directly (no filesystem/network I/O) and
 * so its two callers — the static manifest's own `capabilities:` list and
 * the grants server's `approved` response — go through the exact same
 * validation. That second caller matters: unlike `manifest.capabilities`,
 * which @berth/manifest-schema's CapabilityString regex already validated
 * at loadManifest() time, an `approved` grant string arrives straight from
 * an HTTP JSON response with no schema check at all — a malformed or
 * adversarial grants-server response (compromised server, or just a bug)
 * must never crash policy generation entirely, since agent-init's own
 * fallback for "no policy file" is to warn and run *unrestricted* (see
 * packages/agent-init/src/main.rs) — the opposite of what an invalid
 * capability string should ever cause.
 */
export function compileCapabilityPolicy(appName: string, rawCapabilities: string[]): CapabilityPolicy {
  const effectiveCapabilities: string[] = [];
  const writePaths = new Set(BASELINE_WRITE_PATHS);
  const declaredReadPaths = new Set<string>();
  const networkPorts = new Set<number>();
  const meshPeers = new Set<string>();
  let networkUnrestricted = false;

  for (const capability of rawCapabilities) {
    // CapabilityString mirrors the exact regex @berth/manifest-schema
    // already enforced on manifest.capabilities — re-validating here is
    // what makes it safe to feed grants-server strings into the same loop.
    const validated = CapabilityString.safeParse(capability);
    if (!validated.success) {
      console.error(`[berth:capability-policy] WARNING: ignoring malformed capability string ${JSON.stringify(capability)} (${validated.error.issues[0]?.message ?? "invalid format"})`);
      continue;
    }
    let parsed: ParsedCapability;
    try {
      parsed = parseCapability(validated.data);
    } catch (err) {
      console.error(`[berth:capability-policy] WARNING: ignoring capability string ${JSON.stringify(capability)} that failed to parse (${err})`);
      continue;
    }

    effectiveCapabilities.push(validated.data);
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

  return {
    appName,
    declaredCapabilities: effectiveCapabilities,
    writePaths: [...writePaths],
    readPaths,
    networkPorts: [...networkPorts],
    networkUnrestricted,
    meshPeers: [...meshPeers],
    bindPorts: [],
  };
}

/**
 * `BERTH_HTTP_RPC_PORT`/`BERTH_HTTP_RPC_APP` are container-wide env (see
 * container.ts's `httpRpc` option) — every app in a multi-app container's
 * own generate-capability-policy.ts run sees the same two values, so this
 * mirrors runtime.ts's own gating exactly (`!appName || appName ===
 * manifest.name`) to grant the bind only to whichever single app is
 * actually going to call startHttpRpcServer(), not every sibling. Split out
 * from main() so it's unit-testable without real env/filesystem I/O, same
 * reasoning compileCapabilityPolicy() already has.
 */
export function computeBindPorts(appName: string, env: Partial<Pick<NodeJS.ProcessEnv, "BERTH_HTTP_RPC_PORT" | "BERTH_HTTP_RPC_APP">>): number[] {
  const port = env.BERTH_HTTP_RPC_PORT ? Number(env.BERTH_HTTP_RPC_PORT) : undefined;
  if (!port) return [];
  const boundAppName = env.BERTH_HTTP_RPC_APP;
  if (boundAppName && boundAppName !== appName) return [];
  return [port];
}

async function main(): Promise<void> {
  const manifest = await loadManifest(MANIFEST_PATH);
  const approved = await fetchApprovedCapabilities(manifest.name);
  const policy = compileCapabilityPolicy(manifest.name, [...manifest.capabilities, ...approved]);
  policy.bindPorts = computeBindPorts(manifest.name, process.env);

  await mkdir(dirname(POLICY_PATH), { recursive: true });
  await writeFile(POLICY_PATH, JSON.stringify(policy, null, 2));
  const networkSummary = policy.networkUnrestricted
    ? "networkPorts=* (unrestricted)"
    : policy.networkPorts.length > 0
      ? `networkPorts=${policy.networkPorts.join(", ")}`
      : "networkPorts=(none — network denied by default)";
  console.error(
    `[berth:capability-policy] wrote ${POLICY_PATH}: writePaths=${policy.writePaths.join(", ")}` +
      (policy.readPaths.length > 0 ? `; readPaths=${policy.readPaths.join(", ")}` : "") +
      `; ${networkSummary}` +
      (policy.bindPorts.length > 0 ? `; bindPorts=${policy.bindPorts.join(", ")}` : "") +
      (policy.meshPeers.length > 0 ? `; meshPeers=${policy.meshPeers.join(", ")}` : ""),
  );
}

// Guarded so generate-capability-policy.test.ts can import
// compileCapabilityPolicy() without also running main()'s real I/O (which
// would try to load a berth.yml relative to the test runner's cwd and
// process.exit(1) when it inevitably doesn't find one). entrypoint.sh always
// runs this file directly (`node .../dist/generate-capability-policy.js`),
// so the guard changes nothing about production behavior.
//
// process.argv[1] must be realpath'd before comparing: every real
// invocation goes through the node_modules/@berth/sdk pnpm SYMLINK (every
// resident app has one), and Node's ESM loader resolves import.meta.url
// through that symlink to the package's real location
// (.../packages/sdk/dist/...) while leaving process.argv[1] as the
// as-invoked (symlinked) path — a bare `file://${process.argv[1]}` never
// matches, so main() silently never ran and this file never wrote a policy
// at all. Confirmed by hand inside a real container: import.meta.url
// resolved to the real packages/sdk path, process.argv[1] stayed the
// symlinked apps/<app>/node_modules/@berth/sdk path, and the guard was
// false on every single real boot. realpathSync() on the argv side is what
// makes both sides agree.
function isRunDirectly(): boolean {
  try {
    return import.meta.url === `file://${realpathSync(process.argv[1] ?? "")}`;
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((err) => {
    console.error("[berth:capability-policy] fatal error:", err);
    process.exit(1);
  });
}
