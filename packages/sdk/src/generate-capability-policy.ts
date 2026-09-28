#!/usr/bin/env node
// Runs inside the container before agent-init applies kernel-level
// enforcement (see packages/agent-init). Translates berth.yml's declared
// `capabilities:` into a small JSON policy agent-init can read without
// needing a YAML parser or capability-glob logic in Rust — @berthos/sdk (via
// @berthos/manifest-schema, already a dependency) is the single place that
// understands the capability-string grammar.
//
// filesystem:write:<path> always translates into real kernel enforcement
// (Landlock write-access restriction), and so, now, do reads. An app reads
// the system baseline (below), its own directory, what it may write, the
// real locations of its dependencies, and whatever filesystem:read:<path> it
// declares. Reads used to be opt-in: an app that declared no read scope could
// read everything, including every other app's code and config in the same
// sandbox (browser-native through file://, terminal's shell with cat).
//
// network:connect:<port> is deny-by-default (not opt-in): an app that
// declares no network:connect capability gets zero outbound TCP, full stop.
// An app that genuinely needs to reach arbitrary hosts (e.g. browser-native)
// declares network:connect:* — the explicit, audited escape hatch — which
// skips building a per-port ruleset entirely rather than enumerating all
// 65535 ports. Every other declared capability (browser:navigate:*,
// github:*, ...) is still just recorded in `declaredCapabilities` for
// @berthos/sdk's requestCapability() to report on — see
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
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  loadManifest,
  parseCapability,
  capabilityIssue,
  CapabilityString,
  ALLOWED_FILESYSTEM_SCOPE_PREFIXES,
  type ParsedCapability,
} from "@berthos/manifest-schema";

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? join(process.cwd(), "berth.yml");
const POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY ?? join(process.cwd(), ".berth", "capability-policy.json");
const MESH_COORDINATOR_PORT = Number(process.env.BERTH_MESH_COORDINATOR_PORT ?? 4875);

// Always writable regardless of what's declared, and — apart from /dev/null —
// per-app rather than shared. This used to be all of `/tmp`, unconditionally,
// for every app in the container, which is the reason
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
// now live in) is what stops it connecting. Both halves are needed.
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
// attempt at this granted the pty devices alone and
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
// still the one container-wide grant left in this file.
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
/** Where github-api-broker.cjs writes the CA an app declaring github:* is told to trust — kept in step with that script's own default. */
const GITHUB_BROKER_CERT_DIR = "/run/berth/github-api-broker";

function baselineReadPaths(appName: string): string[] {
  return ["/usr", "/bin", "/sbin", "/lib", "/etc", "/proc", "/dev", "/tmp", appRunDir(appName), process.cwd()];
}

/**
 * Where an app's dependencies really live, when that is outside its own
 * directory. A production image has a real node_modules under the app, so
 * this is empty there. Under `berth dev` the checkout is bind-mounted and pnpm
 * links each dependency into the workspace: node_modules/@berthos/sdk is
 * /workspace/packages/sdk, and every third-party package sits in
 * /workspace/node_modules/.pnpm. Without these an app can't load its own
 * runtime once reads are scoped (the boundary fixtures used to declare
 * filesystem:read:/workspace/packages and /workspace/node_modules by hand for
 * exactly this). Reads only: this is library code, not another app's data.
 *
 * A symlink under the app's node_modules is the app's own content, so where
 * it points proves nothing: `node_modules/root -> /` would otherwise have
 * granted the whole filesystem, and `node_modules/x -> ../../other-app` a
 * sibling's directory. So a target is accepted only if it is one of the two
 * things pnpm actually links to, both inside the pnpm workspace that
 * contains the app (the nearest proper ancestor with a pnpm-workspace.yaml):
 *
 *  - that workspace's own store, <workspace>/node_modules/.pnpm, and
 *  - a library package directly under one of WORKSPACE_LIBRARY_DIRS, never
 *    an app (a directory with a berth.yml) and never the workspace itself.
 *
 * Anything else is dropped with a warning naming the link, and every
 * accepted path is also held to the same prefix allowlist a declared
 * filesystem path is.
 */
export function dependencyReadPaths(appDir: string, allowedPrefixes: readonly string[] = ALLOWED_FILESYSTEM_SCOPE_PREFIXES): string[] {
  const out = new Set<string>();
  const appReal = safeRealpath(appDir) ?? appDir;
  const workspace = findWorkspaceRoot(appReal);
  const visited = new Set<string>();
  const scan = (packageDir: string) => {
    const modules = join(packageDir, "node_modules");
    if (visited.has(modules)) return;
    visited.add(modules);
    for (const entry of safeReaddir(modules)) {
      if (entry.startsWith(".")) continue;
      const names = entry.startsWith("@") ? safeReaddir(join(modules, entry)).map((n) => join(entry, n)) : [entry];
      for (const name of names) {
        const linkPath = join(modules, name);
        if (!isSymlink(linkPath)) continue;
        const target = safeRealpath(linkPath);
        if (!target || isWithin(target, appReal)) continue;
        const dependency = workspace ? acceptedDependency(target, workspace) : undefined;
        const refusal = !dependency
          ? "a dependency must resolve into this app's pnpm workspace store or one of its library packages"
          : !isUnderPrefix(dependency.path, allowedPrefixes)
            ? `it is outside ${allowedPrefixes.join(", ")}`
            : undefined;
        if (!dependency || refusal) {
          console.error(`[berth:capability-policy] WARNING: ignoring ${linkPath} -> ${target} (${refusal}), so it grants no read access`);
          continue;
        }
        out.add(dependency.path);
        // A workspace package: its own node_modules links into the store too.
        if (dependency.kind === "package") scan(target);
      }
    }
  };
  scan(appDir);
  return [...out];
}

/** Workspace directories whose direct children are library packages an app may depend on (see pnpm-workspace.yaml). */
const WORKSPACE_LIBRARY_DIRS = ["packages", "packages/adapters", "experimental"];

function acceptedDependency(target: string, workspace: string): { path: string; kind: "store" | "package" } | undefined {
  const store = join(workspace, "node_modules", ".pnpm");
  if (isWithin(target, store) && target !== store) return { path: store, kind: "store" };
  const parent = dirname(target);
  const isLibrary = WORKSPACE_LIBRARY_DIRS.some((dir) => parent === join(workspace, dir));
  if (isLibrary && isFile(join(target, "package.json")) && !isFile(join(target, "berth.yml"))) return { path: target, kind: "package" };
  return undefined;
}

/** The nearest proper ancestor of `dir` holding a pnpm-workspace.yaml — never `dir` itself, which is the app's own content. */
function findWorkspaceRoot(dir: string): string | undefined {
  for (let current = dirname(dir); ; current = dirname(current)) {
    if (current !== "/" && isFile(join(current, "pnpm-workspace.yaml"))) return current;
    if (current === "/") return undefined;
  }
}

function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + "/");
}

function isUnderPrefix(path: string, prefixes: readonly string[]): boolean {
  return path !== "/" && prefixes.some((prefix) => prefix !== "/" && isWithin(path, prefix));
}

// The scan reads the filesystem and warns about every link it refuses, and
// its answer can't change within one run, so it's done once per directory.
const dependencyCache = new Map<string, string[]>();
function cachedDependencyReadPaths(appDir: string): string[] {
  let paths = dependencyCache.get(appDir);
  if (!paths) dependencyCache.set(appDir, (paths = dependencyReadPaths(appDir)));
  return paths;
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
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
  // separates AccessNet::BindTcp from ConnectTcp, and listening is a
  // different privilege from dialling out.
  //
  // Two sources, unioned in main(): `network:bind:<port>` declared in a
  // berth.yml, and the orchestration-level ports no manifest author knows
  // about (the HTTP RPC bridge's port, ttyd's) from computeBindPorts().
  // Before `network:bind:` existed, an app that needed to listen had to
  // declare `network:connect:*` to switch network restriction off wholesale
  // — which granted unrestricted connect as a side effect of wanting bind.
  bindPorts: number[];
}

function stripTrailingGlob(scope: string): string {
  return scope.endsWith("/*") ? scope.slice(0, -2) : scope;
}

/**
 * The pure namespace:action:scope -> CapabilityPolicy compiler, split out
 * from main() so it can be fuzzed directly (no filesystem I/O). It
 * re-validates every string rather than trusting its caller: a malformed
 * capability must never crash policy generation entirely, since agent-init's
 * own fallback for "no policy file" is to warn and run *unrestricted* (see
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
  const declaredBindPorts = new Set<number>();
  let needsGithubBrokerCa = false;

  for (const capability of rawCapabilities) {
    // CapabilityString mirrors the exact regex @berthos/manifest-schema
    // already enforced on manifest.capabilities — re-validated here so the
    // compiler is safe on any input, not only a loadManifest()-checked one.
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
    // already rejected by BerthManifestSchema's superRefine, but this
    // compiler takes any string list, and every path in this policy is one
    // agent-init will mkdir as root
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
    } else if (parsed.namespace === "network" && parsed.action === "bind") {
      // Distinct from network:connect on purpose: listening on a port and
      // dialling out on one are different privileges, and Landlock's
      // AccessNet separates them (BindTcp vs ConnectTcp). Before this action
      // existed, the only way to get bind permission under enforcement was
      // to declare network:connect:* — which switched the whole network
      // ruleset off, silently granting unrestricted connect AND bind. The
      // mesh fixtures documented that workaround in their own manifests.
      const bindPort = Number(parsed.scope);
      if (Number.isInteger(bindPort) && bindPort > 0 && bindPort <= 65535) {
        declaredBindPorts.add(bindPort);
      } else {
        console.error(`[berth:capability-policy] WARNING: ignoring invalid network:bind scope "${parsed.scope}" (expected a port 1-65535; "*" is deliberately not accepted — name the port you listen on)`);
      }
    } else if (parsed.namespace === "network" && parsed.action === "peer") {
      meshPeers.add(parsed.scope);
      networkPorts.add(MESH_COORDINATOR_PORT);
    } else if (parsed.namespace === "terminal") {
      // terminal:* is otherwise a recorded-only capability (it's what makes
      // container.ts publish ttyd's port). This is the one thing it compiles
      // into the kernel policy, and without it apps/terminal cannot allocate a
      // pty at all on a kernel that enforces Landlock.
      for (const path of TERMINAL_WRITE_PATHS) writePaths.add(path);
    } else if (parsed.namespace === "github") {
      // Same shape as terminal:* above: github:* is otherwise recorded-only
      // (it's what makes entrypoint.sh start the GitHub API broker), and this
      // is the one thing it compiles into the kernel policy. The broker's CA
      // moved out of /tmp — which baselineReadPaths covers in full — into
      // /run/berth, and Node reads NODE_EXTRA_CA_CERTS at
      // process start, i.e. after agent-init has enforced. Without this an app
      // that declares any filesystem:read: capability (which is what turns
      // read scoping on) can't read the CA it was told to trust, and every
      // GitHub call fails the handshake.
      needsGithubBrokerCa = true;
    }
  }

  // Always scoped (see this file's header). What an app may write it may
  // also read, since Landlock's write rights don't include reading, except
  // what the baseline already covers. That exception matters: /dev/null and
  // the pty devices are files, and a read rule on a file can't carry the
  // directory-reading right, which leaves the whole ruleset PartiallyEnforced
  // (and BERTH_REQUIRE_ENFORCEMENT refuses to boot).
  const baseline = baselineReadPaths(appName);
  const covered = (path: string) => baseline.some((b) => path === b || path.startsWith(b + "/"));
  const readPaths = [
    ...new Set([
      ...baseline,
      ...cachedDependencyReadPaths(process.cwd()),
      ...[...writePaths].filter((path) => !covered(path)),
      ...(needsGithubBrokerCa ? [GITHUB_BROKER_CERT_DIR] : []),
      ...declaredReadPaths,
    ]),
  ];

  return {
    appName,
    declaredCapabilities: effectiveCapabilities,
    writePaths: [...writePaths],
    readPaths,
    networkPorts: [...networkPorts],
    networkUnrestricted,
    meshPeers: [...meshPeers],
    bindPorts: [...declaredBindPorts],
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

/**
 * Directories holding the HTTP RPC bridge's TLS certificate and key, for the
 * one app that serves the bridge (the same gating as computeBindPorts()).
 * They are operator-chosen paths (a mounted secret, a file a deploy adapter
 * wrote) that runtime.ts reads after agent-init has enforced, so with reads
 * scoped they'd fail with EACCES unless granted. The directory is granted,
 * not the file: a read rule on a file leaves the ruleset PartiallyEnforced.
 * That makes the whole directory readable (a cert at /app/cert.pem grants
 * /app), which is why docs/tls-reference.md asks for a dedicated one.
 * Both the path as given and its real location count, since a Kubernetes
 * secret mount reaches its files through a symlink. "/" and relative paths
 * are never granted.
 */
export function httpRpcTlsReadPaths(
  appName: string,
  env: Partial<Pick<NodeJS.ProcessEnv, "BERTH_HTTP_RPC_PORT" | "BERTH_HTTP_RPC_APP" | "BERTH_HTTP_RPC_TLS_CERT" | "BERTH_HTTP_RPC_TLS_KEY">>,
): string[] {
  if (!env.BERTH_HTTP_RPC_PORT || (env.BERTH_HTTP_RPC_APP && env.BERTH_HTTP_RPC_APP !== appName)) return [];
  const dirs = new Set<string>();
  for (const file of [env.BERTH_HTTP_RPC_TLS_CERT, env.BERTH_HTTP_RPC_TLS_KEY]) {
    if (!file || !isAbsolute(file)) continue;
    for (const path of [file, safeRealpath(file)]) {
      const dir = path ? dirname(path) : undefined;
      if (dir && dir !== "/") dirs.add(dir);
    }
  }
  return [...dirs];
}

async function main(): Promise<void> {
  const manifest = await loadManifest(MANIFEST_PATH);
  const policy = compileCapabilityPolicy(manifest.name, manifest.capabilities);
  // Union, not overwrite: computeBindPorts() contributes the orchestration-level
  // ports (the HTTP RPC bridge, ttyd) while compileCapabilityPolicy() contributes
  // whatever the manifest declared with network:bind:<port>.
  policy.bindPorts = [
    ...new Set([...policy.bindPorts, ...computeBindPorts(manifest.name, process.env, manifest.capabilities)]),
  ];
  const covered = (path: string) => policy.readPaths.some((granted) => path === granted || path.startsWith(granted + "/"));
  policy.readPaths.push(...httpRpcTlsReadPaths(manifest.name, process.env).filter((dir) => !covered(dir)));

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
// invocation goes through the node_modules/@berthos/sdk pnpm SYMLINK (every
// resident app has one), and Node's ESM loader resolves import.meta.url
// through that symlink to the package's real location
// (.../packages/sdk/dist/...) while leaving process.argv[1] as the
// as-invoked (symlinked) path — a bare `file://${process.argv[1]}` never
// matches, so main() silently never ran and this file never wrote a policy
// at all. Confirmed by hand inside a real container: import.meta.url
// resolved to the real packages/sdk path, process.argv[1] stayed the
// symlinked apps/<app>/node_modules/@berthos/sdk path, and the guard was
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
