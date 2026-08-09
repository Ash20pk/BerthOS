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
import { loadManifest, parseCapability, capabilityIssue, CapabilityString, type ParsedCapability } from "@berth/manifest-schema";

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? join(process.cwd(), "berth.yml");
const POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY ?? join(process.cwd(), ".berth", "capability-policy.json");
const GRANTS_SERVER_URL = process.env.BERTH_GRANTS_SERVER_URL;
const MESH_COORDINATOR_PORT = Number(process.env.BERTH_MESH_COORDINATOR_PORT ?? 4875);

// Always writable regardless of what's declared, and — apart from /dev/null —
// per-app rather than shared. This used to be all of `/tmp`, unconditionally,
// for every app in the container: REMEDIATION.md 1.4's finding, and the reason
// one app could bind or connect to any other's RPC socket.
//
// The old comment justified the blanket /tmp with "connecting to a Unix socket
// requires write access to it." That is a DAC fact and not a Landlock one, and
// the difference is why this alone was never the fix: Landlock hangs its
// filesystem enforcement off security_file_open and the path_* hooks, while
// connecting to a *pathname* socket goes through unix_find_other() ->
// inode_permission(MAY_WRITE), which Landlock does not hook. (ABI 6's
// LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET scopes abstract sockets, not these.)
// *Binding* one is a different question — that goes through path_mknod, which
// Landlock does hook as AccessFs::MakeSock — so narrowing this list stops an
// app squatting a path, and DAC (the 0710 owner-only directory these two paths
// now live in) is what stops it connecting. Both halves are needed; see
// docs/per-app-uid-design.md.
//
// The three daemon control sockets stay at /tmp/berth-*.sock and stay
// reachable by every app, which is deliberate (see the socket table in that
// design doc) and, per the paragraph above, needs no write grant here to keep
// working — only membership of the shared `berth` group, which
// provision_app_identity gives every app.
//
// /dev/null is the one genuinely container-wide entry, and it is a device
// node, not a directory: see the TERMINAL_WRITE_PATHS comment below.
function baselineWritePaths(appName: string): string[] {
  return ["/dev/null", appTmpDir(appName), appRunDir(appName)];
}

/** This app's private scratch directory — TMPDIR/TMUX_TMPDIR/XDG_* all point here (entrypoint.sh). */
function appTmpDir(appName: string): string {
  return `/tmp/${appName}`;
}

/** This app's private runtime directory, holding the RPC socket it binds in multi-app mode. */
function appRunDir(appName: string): string {
  return `/run/berth/${appName}`;
}

// Granted to any app declaring a terminal:* capability. Established by
// straceing a real `tmux new-session` rather than guessed — the previous
// attempt at this (see REMEDIATION.md 1.15) granted the pty devices alone and
// tmux still died, because a tmux server also opens /dev/null O_RDWR to
// daemonize. That one is in the baseline above rather than here: opening
// /dev/null read-write is what *any* process does when it redirects a child's
// stdio to it, so scoping it to terminal apps would leave the same landmine
// for every other app, waiting on whichever one next spawns a child with
// stdio: "ignore".
//
// The strace also showed /dev/tty O_RDWR, and granting it turned out to be
// both impossible and unnecessary. Impossible because /dev/tty is the calling
// process's *controlling terminal*, and agent-init has none — these containers
// are created with Tty: false — so the open fails with ENXIO and the grant is
// skipped, warning on every boot of every app. Unnecessary because the process
// that opens it is the shell running inside the pty, for which /dev/tty
// resolves to /dev/pts/N — already covered by the rule below. Confirmed the
// direct way: CI's published-port-security run has tmux starting under real
// enforcement with that grant skipped.
//
// /dev/pts is the devpts mount, so a rule on it covers every pty slave the
// kernel materialises under it (/dev/pts/0, /dev/pts/1, ...) as they're
// created. /dev/ptmx is listed separately even though it is a symlink to
// pts/ptmx in this image — whether a runtime makes it a symlink or a real
// device node is a runtime detail, and a duplicate rule on the same inode
// costs nothing.
//
// Worth stating plainly: this lets a terminal app write any pty in the
// container, including another app's — the Landlock rule is on the devpts
// mount, not on the ptys this app happens to have allocated. Per-app uids
// narrow it in practice (a pty's slave is owned by whoever allocated it, so
// DAC refuses what this rule permits) but not in the ruleset itself. It is
// still the one container-wide grant left in this file. See
// docs/per-app-uid-design.md § Blocker 6.
const TERMINAL_WRITE_PATHS = ["/dev/pts", "/dev/ptmx"];

// Only added when read scoping is actually enabled (i.e. the app declared at
// least one filesystem:read:<path> capability) — these are the paths Node,
// Alpine, and this app's own working directory need to function at all.
// Declaring a read path narrows visibility to baseline-plus-declared, never
// below what the runtime itself needs.
//
// /bin and /sbin are in this list for a reason worth stating, because their
// absence was a real bug that CI could see and nobody could reproduce locally.
// On a merged-/usr distro they'd be symlinks into /usr and covered already;
// on Alpine, which this image is built on, they are real directories. So an
// app that declared any filesystem:read: capability got a ruleset where every
// binary under /bin and /sbin was unreadable — and on a kernel that actually
// enforces Landlock, execve() of an unreadable file fails with EACCES. That
// app could not spawn `sh`, `ping`, or anything else busybox provides, while
// working perfectly on Docker Desktop where the ruleset is NotEnforced.
//
// It surfaced as `capability-enforcement.mjs`'s raw-socket probe failing with
// "spawn ping EACCES" on every ubuntu-latest run since the probe was added,
// which read as a flaky test rather than as the app-visible breakage it is.
// This is not a widening of the trust boundary: /usr/bin is already readable
// via /usr, and these two directories hold the same kind of thing. Executable
// *scoping* is a separate question — AccessFs::Execute is deliberately not in
// agent-init's handled set, see its comment there.
//
// /tmp stays here in full even though the *write* baseline above no longer
// does. Read access to it is what lets an app stat the daemon control sockets
// and /tmp/.X11-unix before connecting; none of that is a boundary, and
// narrowing reads is not what 1.4 was about.
function baselineReadPaths(appName: string): string[] {
  return ["/usr", "/bin", "/sbin", "/lib", "/etc", "/proc", "/dev", "/tmp", appRunDir(appName), process.cwd()];
}

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
  const writePaths = new Set(baselineWritePaths(appName));
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

    // The filesystem-scope allowlist, re-checked here for the same reason the
    // CapabilityString regex above is: a manifest's own capabilities were
    // already rejected by BerthManifestSchema's superRefine, but a
    // grants-server `approved` string arrives with no schema check at all,
    // and every path in this policy is one agent-init will mkdir as root
    // before enforcement. Skipped with a warning rather than thrown, matching
    // the malformed-string handling above — agent-init's fallback for "no
    // policy file" is to run *unrestricted*, so failing policy generation is
    // strictly worse than dropping one bad capability.
    const semanticIssue = capabilityIssue(validated.data);
    if (semanticIssue) {
      console.error(`[berth:capability-policy] WARNING: ignoring capability ${JSON.stringify(capability)} — ${semanticIssue}`);
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
    } else if (parsed.namespace === "terminal") {
      // terminal:* is otherwise a recorded-only capability (it's what makes
      // container.ts publish ttyd's port). This is the one thing it compiles
      // into the kernel policy, and without it apps/terminal cannot allocate a
      // pty at all on a kernel that enforces Landlock — REMEDIATION.md 1.15.
      for (const path of TERMINAL_WRITE_PATHS) writePaths.add(path);
    }
  }

  // Opt-in: only restrict reads at all if the app declared at least one
  // filesystem:read:<path> capability — otherwise leave readPaths empty,
  // which agent-init treats as "don't touch read access."
  const readPaths = declaredReadPaths.size > 0 ? [...new Set([...baselineReadPaths(appName), ...declaredReadPaths])] : [];

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
 * The ttyd port `apps/terminal` serves its human-facing session on. A fixed
 * container port (container.ts's own TERMINAL_PORT), not something a
 * berth.yml can set — an orchestration-level fact, exactly like the HTTP RPC
 * port below, which is why neither is expressible as a capability.
 */
const TERMINAL_BIND_PORT = 7681;

/**
 * Ports an app is allowed to `bind()`, as opposed to `connect()` to.
 *
 * The distinction is easy to lose and has now caused the same bug twice:
 * `restrict_network`'s `AccessNet::from_all` denies **both** `ConnectTcp` and
 * `BindTcp` the moment network scoping is active at all, and network scoping
 * is active for any app that doesn't declare `network:connect:*`. So an app
 * with no network capability can't listen on its own port either — which is
 * invisible on a kernel where Landlock isn't enforced (every dev Mac), and
 * an immediate `EPERM` on one where it is.
 *
 * Two sources, both orchestration-level:
 *
 * 1. **The HTTP RPC bridge.** `BERTH_HTTP_RPC_PORT`/`BERTH_HTTP_RPC_APP` are
 *    container-wide env (see container.ts's `httpRpc` option) — every app in
 *    a multi-app container sees the same two values, so this mirrors
 *    runtime.ts's own gating exactly (`!appName || appName ===
 *    manifest.name`) to grant the bind only to whichever single app will
 *    actually call startHttpRpcServer(), not every sibling.
 *
 * 2. **ttyd**, for an app declaring `terminal:*`. `apps/terminal` spawns ttyd
 *    as a child of its own already-Landlocked process, so ttyd inherits this
 *    domain and its `bind()` is subject to it. This grant was missing, which
 *    meant `apps/terminal`'s web view had never worked on any kernel that
 *    enforces Landlock — found by published-port-security-milestone.mjs on
 *    its first CI run, which is also the first test to exercise this app
 *    against a real kernel.
 *
 * Deliberately not gated on `expose.terminal`: that field governs whether
 * the port is *published to the host*, and ttyd binds inside the container
 * either way. Tying a kernel grant to a host-visibility flag would make the
 * app work or not depending on a setting that has nothing to do with it.
 */
export function computeBindPorts(
  appName: string,
  env: Partial<Pick<NodeJS.ProcessEnv, "BERTH_HTTP_RPC_PORT" | "BERTH_HTTP_RPC_APP">>,
  capabilities: readonly string[] = [],
): number[] {
  const ports: number[] = [];

  const httpRpcPort = env.BERTH_HTTP_RPC_PORT ? Number(env.BERTH_HTTP_RPC_PORT) : undefined;
  const boundAppName = env.BERTH_HTTP_RPC_APP;
  if (httpRpcPort && (!boundAppName || boundAppName === appName)) ports.push(httpRpcPort);

  if (capabilities.some((cap) => cap.startsWith("terminal:"))) ports.push(TERMINAL_BIND_PORT);

  return [...new Set(ports)];
}

async function main(): Promise<void> {
  const manifest = await loadManifest(MANIFEST_PATH);
  const approved = await fetchApprovedCapabilities(manifest.name);
  const policy = compileCapabilityPolicy(manifest.name, [...manifest.capabilities, ...approved]);
  policy.bindPorts = computeBindPorts(manifest.name, process.env, manifest.capabilities);

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
