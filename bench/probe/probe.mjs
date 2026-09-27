// The agent-side half of the containment benchmark: the actions an attacker
// who already has code execution inside the sandbox would attempt.
//
// This file is the benchmark's single source of truth for "what was tried".
// Every harness runs THIS code, unmodified — plain Docker runs it as the
// container's command, Berth runs it inside the app's own Landlock-restricted
// process (via bench/fixtures/bench-probe), a hosted sandbox runs it through
// its exec API. A benchmark whose probe is reimplemented per target measures
// the reimplementations, so there is deliberately no second copy and no
// dependency to install: node's standard library only.
//
// Every check answers one question — was the action refused? — with one of:
//
//   contained   the action was refused, and the refusal looks like policy
//               (EACCES/EPERM/EROFS), not like an accident of the environment
//   escaped     the action succeeded
//   unmeasured  neither could be established (nothing was listening, DNS did
//               not resolve, the target does not exist here). Never scored as
//               a pass — see bench/README.md.
//
// The distinction between "contained" and "unmeasured" is the whole
// credibility of the network rows: a sandbox with no route to the internet
// looks identical to a sandbox that forbids egress unless you read the errno.

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Errnos that mean a policy said no, as opposed to the environment being unhelpful. */
const DENIAL_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
/** Errnos that mean we learned nothing about policy. */
const AMBIGUOUS_CODES = new Set(["ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET"]);

const env = (name, fallback) => process.env[name] ?? fallback;

function contained(detail, evidence) {
  return { outcome: "contained", detail, ...(evidence ? { evidence } : {}) };
}
function escaped(detail, evidence) {
  return { outcome: "escaped", detail, ...(evidence ? { evidence } : {}) };
}
function unmeasured(detail, evidence) {
  return { outcome: "unmeasured", detail, ...(evidence ? { evidence } : {}) };
}

/** Classifies a filesystem error: a denial errno is containment, anything else is not proof of it. */
function classifyFsError(err, action) {
  if (!err) return escaped(`${action} succeeded`);
  if (DENIAL_CODES.has(err.code)) return contained(`${action} refused with ${err.code}${err.syscall ? ` on ${err.syscall}(2)` : ""}`, err.code);
  if (err.code === "ENOENT") return unmeasured(`${action} failed with ENOENT — the target path does not exist here, so nothing was tested`, err.code);
  return unmeasured(`${action} failed with ${err.code ?? "an unknown error"} (${err.message})`, err.code);
}

/** One TCP connect attempt, classified the same way. Resolves, never rejects. */
function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const socket = createConnection({ host, port, timeout: timeoutMs });
    socket.on("connect", () => done(escaped(`connected to ${host}:${port}`)));
    socket.on("timeout", () => done(unmeasured(`connect to ${host}:${port} timed out after ${timeoutMs}ms — nothing answered, which is not proof of a policy`, "ETIMEDOUT")));
    socket.on("error", (err) => {
      // Which syscall was refused matters: a denial on getaddrinfo means the
      // sandbox blocked name resolution (Berth's seccomp filter refuses UDP
      // sockets for an app that declared no network), while a denial on
      // connect means the network policy itself refused the reach. Both are
      // containment; conflating them would hide which layer did the work.
      if (DENIAL_CODES.has(err.code)) done(contained(`${err.syscall === "getaddrinfo" ? `resolving ${host}` : `connect to ${host}:${port}`} refused with ${err.code}${err.syscall ? ` on ${err.syscall}` : ""}`, err.code));
      else if (AMBIGUOUS_CODES.has(err.code)) done(unmeasured(`connect to ${host}:${port} failed with ${err.code} — no policy signal`, err.code));
      else done(unmeasured(`connect to ${host}:${port} failed with ${err.code ?? "an unknown error"}`, err.code));
    });
  });
}

function parseEndpoint(value) {
  if (!value) return undefined;
  const idx = value.lastIndexOf(":");
  if (idx === -1) return undefined;
  return { host: value.slice(0, idx), port: Number(value.slice(idx + 1)) };
}

// --- the checks -------------------------------------------------------------

const CHECKS = {
  /**
   * Write to a path the workload was never granted. Under a declarative
   * sandbox this is the headline denial; under a plain container running as
   * root it simply works, which is the comparison the benchmark exists to make.
   */
  "undeclared-write": async () => {
    const target = env("BENCH_UNDECLARED_PATH", "/etc/berth-bench-pwned.txt");
    try {
      writeFileSync(target, "pwned by the containment benchmark\n");
      return escaped(`wrote ${target}`);
    } catch (err) {
      return classifyFsError(err, `write to ${target}`);
    }
  },

  /**
   * The same escape via a symlink planted INSIDE the granted directory, so
   * path-string validation in application code cannot catch it. Only a kernel
   * that resolves the link at syscall time refuses this.
   */
  "symlink-escape": async () => {
    const dataDir = env("BENCH_DATA_DIR");
    if (!dataDir) return unmeasured("no BENCH_DATA_DIR — this harness gave the workload no granted directory to plant a link in");
    const linkPath = join(dataDir, `bench-escape-${process.pid}`);
    try {
      symlinkSync("/etc", linkPath);
    } catch (err) {
      if (err.code !== "EEXIST") return unmeasured(`could not plant the symlink (${err.code}) — the escape was never attempted`, err.code);
    }
    const target = join(linkPath, "berth-bench-pwned-via-symlink.txt");
    try {
      writeFileSync(target, "pwned through a symlink\n");
      return escaped(`wrote ${target} through a symlink into /etc`);
    } catch (err) {
      return classifyFsError(err, `write through the symlink to ${target}`);
    }
  },

  /**
   * Outbound TCP to a public address the workload never declared. The errno
   * is what separates "egress is forbidden" from "this runner has no
   * internet" — an offline CI box must not score as a containment win.
   */
  "undeclared-egress": async () => {
    const endpoint = parseEndpoint(env("BENCH_EGRESS_ENDPOINT", "1.1.1.1:80"));
    return tcpProbe(endpoint.host, endpoint.port);
  },

  /**
   * Reaching the HOST from inside the sandbox — the escape that matters on a
   * developer laptop, where the host runs everything else. Deterministic on
   * purpose: the benchmark runner opens this listener itself, so a failure to
   * connect cannot be blamed on nothing being there.
   */
  "host-network-reach": async () => {
    const endpoint = parseEndpoint(env("BENCH_HOST_ENDPOINT"));
    if (!endpoint) return unmeasured("no BENCH_HOST_ENDPOINT — the runner did not publish a host listener for this run");
    const result = await tcpProbe(endpoint.host, endpoint.port);
    if (result.outcome === "unmeasured" && result.evidence === "ECONNREFUSED") {
      return unmeasured("the runner's host listener refused the connection — the route exists but the listener was gone; rerun", "ECONNREFUSED");
    }
    return result;
  },

  /**
   * Cloud instance metadata. Best-effort by construction: on a laptop nothing
   * answers 169.254.169.254, so the honest result there is unmeasured rather
   * than a free pass.
   */
  "imds-reach": async () => {
    const result = await tcpProbe("169.254.169.254", 80, 3000);
    if (result.outcome === "unmeasured") {
      return unmeasured(`no IMDS endpoint responded here (${result.evidence ?? "no errno"}) — this row is only meaningful on a cloud host`, result.evidence);
    }
    return result;
  },

  /**
   * Create a user namespace and mount inside it. A capability drop that a
   * workload can undo by unsharing is not a capability drop, so namespace
   * CREATION counts as an escape even when the mount then fails.
   *
   * The inner shell always exits 0 and reports through stdout markers: a
   * failed mount inside a successfully created namespace would otherwise be
   * indistinguishable from unshare(2) itself being refused.
   */
  "namespace-escape": async () =>
    new Promise((resolve) => {
      execFile(
        "unshare",
        ["-Urm", "sh", "-c", "echo NAMESPACE_CREATED; mount -t tmpfs none /mnt 2>/dev/null && echo MOUNT_SUCCEEDED; exit 0"],
        { timeout: 8000 },
        (err, stdout, stderr) => {
          const created = (stdout ?? "").includes("NAMESPACE_CREATED");
          const mounted = (stdout ?? "").includes("MOUNT_SUCCEEDED");
          if (mounted) return resolve(escaped("created a user namespace AND mounted inside it — the capability drop is reversible"));
          if (created) return resolve(escaped("created a user namespace (mount inside it failed) — namespace creation alone puts the workload one step from reversing the drop"));
          const message = `${stderr ?? ""}${err?.message ?? ""}`;
          if (/not permitted|permission denied|EPERM|EACCES/i.test(message)) return resolve(contained(`unshare(CLONE_NEWUSER) refused: ${message.trim().split("\n")[0]}`));
          if (/not found|ENOENT/i.test(message)) return resolve(unmeasured("no unshare binary in this image — the attempt could not be made"));
          return resolve(unmeasured(`unshare failed without a policy signal: ${message.trim().split("\n")[0] || "no output"}`));
        },
      );
    }),

  /**
   * Read a co-tenant workload's data. Only meaningful where a harness puts
   * more than one workload in a sandbox; elsewhere the runner marks the row
   * not-applicable rather than letting an absent sibling read as containment.
   */
  "sibling-data-read": async () => {
    const siblingDir = env("BENCH_SIBLING_DIR");
    if (!siblingDir) return unmeasured("no BENCH_SIBLING_DIR — this harness runs one workload per sandbox");
    const target = join(siblingDir, "sibling-owned.txt");
    try {
      const content = readFileSync(target, "utf-8");
      return escaped(`read the sibling's file ${target}`, content.trim().slice(0, 60));
    } catch (err) {
      return classifyFsError(err, `read the sibling's file ${target}`);
    }
  },

  /** Write into a co-tenant's directory — the other half of cross-workload interference. */
  "sibling-data-write": async () => {
    const siblingDir = env("BENCH_SIBLING_DIR");
    if (!siblingDir) return unmeasured("no BENCH_SIBLING_DIR — this harness runs one workload per sandbox");
    const target = join(siblingDir, "pwned-by-the-neighbour.txt");
    try {
      writeFileSync(target, "written by a co-tenant workload\n");
      return escaped(`wrote into the sibling's directory: ${target}`);
    } catch (err) {
      return classifyFsError(err, `write into the sibling's directory ${target}`);
    }
  },

  /**
   * Connect to a co-tenant's control socket — reaching its whole API surface
   * without going through any grant. Berth answers this with per-app uids and
   * a 0710 socket directory (whose SO_PEERCRED step is still
   * open); harnesses with one workload per sandbox have no such surface.
   */
  "sibling-socket-connect": async () => {
    const socketPath = env("BENCH_SIBLING_SOCKET");
    if (!socketPath) return unmeasured("no BENCH_SIBLING_SOCKET — this harness exposes no co-tenant control socket");
    return new Promise((resolve) => {
      const socket = createConnection({ path: socketPath });
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
        resolve(result);
      };
      socket.on("connect", () => done(escaped(`connected to the sibling's control socket at ${socketPath}`)));
      socket.on("error", (err) => {
        if (DENIAL_CODES.has(err.code)) done(contained(`connect to ${socketPath} refused with ${err.code}`, err.code));
        else if (err.code === "ENOENT") done(unmeasured(`no socket at ${socketPath} — nothing was tested`, err.code));
        else done(unmeasured(`connect to ${socketPath} failed with ${err.code ?? "an unknown error"}`, err.code));
      });
      setTimeout(() => done(unmeasured(`connect to ${socketPath} neither connected nor errored within 4s`)), 4000);
    });
  },

  /**
   * Can the workload read a secret it was never given? The runner plants a
   * canary in the sandbox the way each harness supports, and this reads the
   * places a compromised workload would look. Self-owned environment is NOT
   * one of them — that is the workload's own secret and proves nothing.
   */
  "foreign-secret-read": async () => {
    const path = env("BENCH_FOREIGN_SECRET_PATH");
    if (!path) return unmeasured("no BENCH_FOREIGN_SECRET_PATH — the runner planted no foreign secret for this harness");
    try {
      const content = readFileSync(path, "utf-8");
      return escaped(`read a secret file it does not own: ${path}`, content.trim().slice(0, 24));
    } catch (err) {
      return classifyFsError(err, `read the foreign secret at ${path}`);
    }
  },
};

export const CHECK_IDS = Object.keys(CHECKS);

export async function runCheck(id) {
  const check = CHECKS[id];
  if (!check) return { outcome: "unmeasured", detail: `no such check: ${id}` };
  try {
    return await check();
  } catch (err) {
    return { outcome: "unmeasured", detail: `the probe itself threw: ${err?.message ?? err}` };
  }
}

export async function runAll(ids = CHECK_IDS) {
  const results = {};
  for (const id of ids) results[id] = await runCheck(id);
  return results;
}

// CLI: `node probe.mjs <id>` or `node probe.mjs --all`. One JSON object on
// stdout and nothing else, so a harness that can only hand back a string
// still yields structured results.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("probe.mjs");
if (invokedDirectly) {
  const arg = process.argv[2];
  const output = !arg || arg === "--all" ? await runAll() : { [arg]: await runCheck(arg) };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
