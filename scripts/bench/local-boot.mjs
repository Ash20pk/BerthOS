#!/usr/bin/env node
/**
 * Local boot benchmark: how long the Docker-based local stack takes to go from
 * a command to a working app, where that time goes, and what the sandbox costs
 * at idle. The baseline for replacing the stack with a Berth-owned microVM.
 * Results and method: docs/perf/local-boot-baseline.md.
 *
 * Usage (from the repository root, after `pnpm install && pnpm build`):
 *
 *   node scripts/bench/local-boot.mjs [options]
 *
 *   --scenarios <ids>   comma-separated, default: all
 *                         dev-notes       `berth dev` in apps/notes
 *                         dev-multi       `berth dev --apps apps/filesystem` in apps/notes
 *                         mcp-notes       `berth mcp --app notes`, first tools/call list_notes
 *                         mcp-filesystem  `berth mcp --app filesystem`, first tools/call list_files
 *   --modes <ids>       comma-separated, default: cold,warm,edit
 *                         cold    every build step runs: the CLI gets BERTH_BUILD_NO_CACHE=1,
 *                                 so nothing is reused, including layers another build
 *                                 on the same daemon left behind (upstream base images
 *                                 such as node/rust/golang stay pulled)
 *                         warm    unchanged source, image cached (the build cache from #211)
 *                         edit    one source file changed since the cached build
 *                         reload  `berth dev` only: edit a file while it runs, time the
 *                                 watcher's restart to the next successful RPC
 *   --runs <n>          runs per scenario and mode, default 5
 *   --resources         after the runs, boot each scenario once more and sample
 *                       idle memory, CPU, processes, image sizes and disk use
 *   --json <path>       also write every run's raw data here
 *   --idle-ms <n>       how long to let a sandbox idle before sampling, default 15000
 *   --state <path>      where the ids of images this script's own builds created are kept
 *                       between invocations, so a later `cold` run (or --cleanup) can
 *                       remove them and nothing else; default $TMPDIR/berth-local-boot-state.json
 *   --cleanup           remove every image recorded in the state file, then exit
 *   --verbose           echo the CLI's own output to stderr as it arrives
 *   --min-free-gb <n>   stop before a run if the host volume holding the Docker VM's disk
 *                       image has less free space than this, default 25. A cold build
 *                       adds about 3 GB to Docker's storage, and Colima's disk image
 *                       grows on the host to match: when the host volume filled up
 *                       during a cold run, the VM's ext4 aborted its journal and
 *                       Docker's storage went read-only, for every user of the VM
 *   --max-load <x>      wait before each run until the Docker VM's 1-minute load
 *                       average is below this, default 1.0 (another build or test
 *                       running there would otherwise be measured too)
 *
 * What a run measures: t=0 is the spawn of the berth CLI; the run ends at the
 * first successful call into the app (an RPC over the container's stdio for
 * single-app `berth dev`, over the per-app socket for multi-app, a tools/call
 * result for `berth mcp`). The CLI runs with BERTH_TIMING=1, which makes
 * buildImage() and startContainer() print one `[berth:timing]` line per
 * phase (packages/docker-orchestrator/src/timing.ts). In-container phases
 * come from `docker logs --timestamps`.
 *
 * Only what this script creates is removed: the containers it boots (by
 * name), and for `cold` the images its own builds produced. Those are read
 * from the build output (the ` ---> <id>` after every step that ran rather
 * than hit the cache), not from a before/after diff of `docker images`: the
 * Docker VM is often shared, and a diff would take in another build's images
 * too. It never prunes. Upstream base images (rust, golang, node) are left
 * pulled.
 *
 * Before each cold run the previous build's images are removed, to keep disk
 * use bounded; the cold build itself does not depend on that, because it runs
 * with the cache off. Each run records which steps hit the cache, and a cold
 * run in which any of the expensive steps (the cargo/go builds, the base apk
 * install) was cached anyway is marked `coldClean: false`.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO, "packages/cli/bin/berth.js");
const ORCH = join(REPO, "packages/docker-orchestrator");
// Importing the orchestrator applies the current Docker context (Colima) before any client exists.
const orchestrator = await import(join(ORCH, "dist/index.js"));
const Docker = createRequire(join(ORCH, "package.json"))("dockerode");
const docker = new Docker();

const SCENARIOS = {
  "dev-notes": {
    kind: "dev",
    cwd: "apps/notes",
    args: ["dev"],
    container: "berth-dev-notes",
    apps: ["notes"],
    probe: { notes: "list_notes" },
    editFile: "apps/notes/src/index.ts",
  },
  "dev-multi": {
    kind: "dev",
    cwd: "apps/notes",
    args: ["dev", "--apps", "apps/filesystem"],
    container: "berth-dev-notes",
    apps: ["notes", "filesystem"],
    multi: true,
    probe: { notes: "list_notes", filesystem: "list_files" },
    // The primary's: `berth dev` watches only the primary app's src/ and
    // berth.yml, so an edit to a companion never triggers a reload.
    editFile: "apps/notes/src/index.ts",
  },
  "mcp-notes": {
    kind: "mcp",
    cwd: ".",
    args: ["mcp", "--app", "notes", "--app-dir", "apps/notes", "--boot-timeout", "1800"],
    container: "berth-dev-notes",
    apps: ["notes"],
    tool: "list_notes",
    editFile: "apps/notes/src/index.ts",
  },
  "mcp-filesystem": {
    kind: "mcp",
    cwd: ".",
    args: ["mcp", "--app", "filesystem", "--app-dir", "apps/filesystem", "--boot-timeout", "1800"],
    container: "berth-dev-filesystem",
    apps: ["filesystem"],
    tool: "list_files",
    editFile: "apps/filesystem/src/index.ts",
  },
};

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { scenarios: Object.keys(SCENARIOS), modes: ["cold", "warm", "edit"], runs: 5, resources: false, json: undefined, idleMs: 15000, maxLoad: 1.0, state: join(tmpdir(), "berth-local-boot-state.json"), cleanup: false, minFreeGb: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--scenarios") opts.scenarios = next().split(",");
    else if (a === "--modes") opts.modes = next().split(",");
    else if (a === "--runs") opts.runs = Number(next());
    else if (a === "--resources") opts.resources = true;
    else if (a === "--json") opts.json = resolve(next());
    else if (a === "--idle-ms") opts.idleMs = Number(next());
    else if (a === "--max-load") opts.maxLoad = Number(next());
    else if (a === "--verbose") VERBOSE = true;
    else if (a === "--state") opts.state = resolve(next());
    else if (a === "--cleanup") opts.cleanup = true;
    else if (a === "--min-free-gb") opts.minFreeGb = Number(next());
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf-8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  for (const s of opts.scenarios) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s}`);
  return opts;
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const shOk = (cmd, args) => {
  try {
    return sh(cmd, args);
  } catch {
    return undefined;
  }
};
let VERBOSE = false;
const log = (msg) => process.stderr.write(`[bench] ${msg}\n`);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return undefined;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function summary(xs) {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return undefined;
  return { n: v.length, median: median(v), min: Math.min(...v), max: Math.max(...v) };
}

function vmLoad() {
  const out = shOk("colima", ["ssh", "--", "cat", "/proc/loadavg"]);
  return out ? Number(out.split(" ")[0]) : undefined;
}

function imagesDiskBytes() {
  // `docker system df` in bytes isn't offered; the VM's own view of Docker's root is exact.
  const out = shOk("colima", ["ssh", "--", "sudo", "du", "-sbx", "/var/lib/docker", "/var/lib/containerd"]);
  if (!out) return undefined;
  return out.split("\n").reduce((sum, line) => sum + Number(line.split("\t")[0]), 0);
}

/** Containers not started by this benchmark, so a run can say what else was going on. */
function otherContainers(ownNames) {
  return sh("docker", ["ps", "--format", "{{.Names}}"])
    .split("\n")
    .filter(Boolean)
    .filter((n) => !ownNames.some((own) => n === own || n.startsWith(`${own}-`)));
}

/**
 * Containers that had been running for over ten minutes when this script
 * started: a long-lived stack someone left up (a database, a local service).
 * They are recorded with every run, but not waited for. Anything else that
 * appears is another test or build sharing the VM, and a run waits for it.
 */
function longRunningContainers() {
  const names = sh("docker", ["ps", "--format", "{{.Names}}"]).split("\n").filter(Boolean);
  const cutoff = Date.now() - 10 * 60_000;
  return new Set(names.filter((n) => Date.parse(shOk("docker", ["inspect", "--format", "{{.State.StartedAt}}", n]) ?? "") < cutoff));
}

async function waitForQuietVm(maxLoad, ownNames, background) {
  const deadline = Date.now() + 30 * 60_000;
  let waitedMs = 0;
  for (;;) {
    const load = vmLoad();
    const foreign = otherContainers(ownNames).filter((n) => !background.has(n));
    const busy = (load !== undefined && load >= maxLoad) || foreign.length > 0;
    if (!busy || Date.now() > deadline) return { load, foreign, waitedMs };
    log(`waiting: VM load ${load}${foreign.length ? `, other containers running: ${foreign.join(", ")}` : ""}`);
    await sleep(15_000);
    waitedMs += 15_000;
  }
}

/** Free bytes on the host volume that holds Colima's disk images (they grow as Docker writes). */
function hostFreeBytes() {
  const dir = [join(process.env.HOME ?? "", ".colima"), process.env.HOME ?? "/"].find((d) => existsSync(d));
  const out = shOk("df", ["-k", dir]);
  const cols = out?.split("\n")[1]?.trim().split(/\s+/);
  return cols ? Number(cols[3]) * 1024 : undefined;
}

function assertDiskHeadroom(minFreeGb) {
  const free = hostFreeBytes();
  if (free !== undefined && free < minFreeGb * 1e9) {
    throw new Error(`only ${(free / 1e9).toFixed(1)} GB free on the host volume holding the Docker VM's disk (--min-free-gb ${minFreeGb}); stopping before the VM's disk runs out`);
  }
  return free;
}

async function removeContainerIfPresent(name) {
  for (const n of [name, `${name}-fs`]) {
    const c = docker.getContainer(n);
    if (await c.inspect().then(() => true, () => false)) await c.remove({ force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- cold reset

/**
 * Removes the images this benchmark's own builds created, so the next build
 * starts with no Berth layer cached. Removal is repeated so children go
 * before parents, and is never forced: an image a container uses, or one
 * another build has since built on, stays.
 */
function resetCold(created) {
  const ids = [...created];
  let remaining = ids.filter((id) => shOk("docker", ["image", "inspect", id]) !== undefined);
  for (let pass = 0; pass < 10 && remaining.length > 0; pass++) {
    const before = remaining.length;
    for (const id of remaining) {
      const info = JSON.parse(shOk("docker", ["image", "inspect", id]) ?? "[]")[0];
      if (!info) continue;
      // Tags first: an image is only removed once its last reference goes.
      for (const tag of info.RepoTags ?? []) shOk("docker", ["image", "rm", "--no-prune", tag]);
      shOk("docker", ["image", "rm", "--no-prune", id]);
    }
    remaining = remaining.filter((id) => shOk("docker", ["image", "inspect", id]) !== undefined);
    if (remaining.length === before) break;
  }
  return remaining.length;
}


// ---------------------------------------------------------------- log parsing

function parseDockerTs(line) {
  const sp = line.indexOf(" ");
  const ts = line.slice(0, sp);
  const m = ts.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z$/);
  if (!m) return undefined;
  const frac = (m[2] ?? ".0").slice(1).padEnd(3, "0").slice(0, 3);
  return { t: Date.parse(`${m[1]}.${frac}Z`), text: line.slice(sp + 1) };
}

async function containerTimeline(name, apps) {
  const c = docker.getContainer(name);
  const info = await c.inspect().catch(() => undefined);
  if (!info) return undefined;
  const raw = await c.logs({ stdout: true, stderr: true, timestamps: true, tail: 2000 });
  const lines = demuxBuffer(raw).split("\n").filter(Boolean);
  const events = lines.map(parseDockerTs).filter(Boolean).sort((a, b) => a.t - b.t);
  const started = Date.parse(info.State.StartedAt);
  const first = (re) => events.find((e) => re.test(e.text))?.t;
  const allOf = (re) => {
    const ts = apps.map((a) => first(re(a)));
    return ts.every(Boolean) ? Math.max(...ts) : undefined;
  };
  // Single-app order in entrypoint.sh: lifecycle flags (a node tool), then
  // context-bus-daemon under its own agent-init, the wait for the sidecar's
  // /context mount, the policy compiler (another node tool), then agent-init
  // for the app, which execs the SDK runtime. Multi-app mode has no
  // "handing off" line; the first app's agent-init line stands in for it.
  const marks = {
    started,
    entrypoint: first(/\[berth:entrypoint\] boot id/),
    lifecycle: first(/starting context-bus daemon/),
    handoff: first(/handing off to agent-init/) ?? Math.min(...apps.map((a) => first(new RegExp(`\\[agent-init\\] (restricted|NOT RESTRICTED) "${a}"`)) ?? Infinity)),
    appRestricted: allOf((a) => new RegExp(`\\[agent-init\\] (restricted|NOT RESTRICTED) "${a}"`)),
    ready: allOf((a) => new RegExp(`\\[berth:runtime\\] "${a}" ready`)),
  };
  if (!Number.isFinite(marks.handoff)) marks.handoff = undefined;
  const phases = {
    "ctr.tini-to-entrypoint": diff(marks.entrypoint, started),
    "ctr.lifecycle-flags": diff(marks.lifecycle, marks.entrypoint),
    "ctr.daemons-sidecar-wait-policy": diff(marks.handoff, marks.lifecycle),
    "ctr.agent-init": diff(marks.appRestricted, marks.handoff),
    "ctr.runtime-to-ready": diff(marks.ready, marks.appRestricted),
  };
  const enforcement = [...new Set(events.map((e) => e.text.match(/restrict_self\(\) status: ruleset=(\w+)/)?.[1]).filter(Boolean))];
  const notRestricted = events.some((e) => /NOT RESTRICTED/.test(e.text));
  return { marks, phases, startedToReady: diff(marks.ready, started), enforcement, notRestricted, logLines: events.length };
}

/** A non-follow `logs` call returns the whole multiplexed body as one Buffer: 8-byte frame headers, then payload. */
function demuxBuffer(buf) {
  let out = "";
  for (let i = 0; i + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + size).toString("utf-8");
    i += 8 + size;
  }
  return out;
}

function diff(a, b) {
  return a !== undefined && b !== undefined ? a - b : undefined;
}

/**
 * One entry per `Step N/M` of the build: how long it took (from the arrival
 * of its line to the next step's), whether it hit the cache, and the image it
 * produced (the last ` ---> <id>` in its output).
 */
function buildSteps(lines) {
  const steps = [];
  for (const l of lines) {
    const text = l.text.replace(/\[berth:build\] ?/g, "");
    const m = text.match(/Step (\d+)\/(\d+) : (.*)$/);
    if (m) {
      steps.push({ step: Number(m[1]), of: Number(m[2]), directive: m[3].trim().slice(0, 90), t: l.t, cached: false, image: undefined });
      continue;
    }
    const current = steps.at(-1);
    if (!current) continue;
    if (/---> Using cache/.test(text)) current.cached = true;
    const id = text.match(/---> ([0-9a-f]{12})\s*$/);
    if (id) current.image = id[1];
  }
  const end = lines.find((l) => /phase=build\.docker-build/.test(l.text))?.t;
  return steps.map((s, i) => ({ ...s, ms: (steps[i + 1]?.t ?? end ?? s.t) - s.t }));
}

/** The steps a genuinely cold build must run: every compile and the base image's package install. */
const EXPENSIVE_STEP = /^RUN (cargo |CGO_ENABLED=0 go build|apk add --no-cache\s+bash)/;

/** Full ids of the images this run's build produced itself: every step that ran, not a FROM, not a cache hit. */
function builtImageIds(steps) {
  const ids = [];
  for (const s of steps) {
    if (!s.image || s.cached || /^FROM /i.test(s.directive)) continue;
    const full = shOk("docker", ["image", "inspect", "--format", "{{.Id}}", s.image]);
    if (full) ids.push(full);
  }
  return ids;
}

// ---------------------------------------------------------------- runners

/** CLIs still running, so a crash of this script still stops the sandboxes they booted. */
const liveChildren = new Set();
process.on("exit", () => {
  for (const child of liveChildren) child.kill("SIGINT");
});

function spawnCli(scenario, extraEnv = {}) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [CLI, ...scenario.args], {
    cwd: join(REPO, scenario.cwd),
    env: { ...process.env, BERTH_TIMING: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);
  child.on("exit", () => liveChildren.delete(child));
  const lines = [];
  const onLine = [];
  for (const [stream, name] of [[child.stdout, "out"], [child.stderr, "err"]]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString("utf-8");
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const text of parts) {
        const entry = { t: Date.now(), stream: name, text };
        lines.push(entry);
        if (VERBOSE) process.stderr.write(`  ${((entry.t - t0) / 1000).toFixed(1)}s ${text}\n`);
        for (const f of onLine) f(entry);
      }
    });
  }
  const handle = { child, t0, lines, onLine, exitStatus: undefined };
  handle.exited = new Promise((r) =>
    child.on("exit", (code, signal) => {
      handle.exitStatus = { code, signal, atMs: Date.now() - t0 };
      r(handle.exitStatus);
    }),
  );
  return handle;
}

function timingPhases(lines) {
  const phases = {};
  for (const l of lines) {
    const m = l.text.match(/\[berth:timing\] phase=([\w.-]+) ms=(\d+)/);
    if (m) phases[m[1]] = (phases[m[1]] ?? 0) + Number(m[2]);
  }
  return phases;
}

/** Polls the app(s) of a `berth dev` container until every one answers an RPC, or the CLI exits. */
async function firstDevRpc(scenario, deadline, run) {
  const answered = {};
  let client;
  try {
    while (Date.now() < deadline && run?.exitStatus === undefined) {
      const c = docker.getContainer(scenario.container);
      const info = await c.inspect().catch(() => undefined);
      if (!info?.State?.Running) {
        await sleep(200);
        continue;
      }
      for (const [app, exp] of Object.entries(scenario.probe)) {
        if (answered[app]) continue;
        try {
          let res;
          if (scenario.multi) {
            res = await orchestrator.invokeAppExport(c, app, { id: `b${Date.now()}`, export: exp }, { docker, timeoutMs: 2000 });
          } else {
            client ??= await orchestrator.createStdioRpcClient(c, docker);
            res = await client.call({ id: `b${Date.now()}`, export: exp }, { timeoutMs: 1000 });
          }
          if (!res.error) answered[app] = Date.now();
        } catch {
          /* not up yet */
        }
      }
      if (Object.keys(answered).length === Object.keys(scenario.probe).length) return { at: Math.max(...Object.values(answered)), perApp: answered };
      await sleep(200);
    }
    return { at: undefined, perApp: answered };
  } finally {
    client?.close();
  }
}

async function runDev(scenario, mode, opts) {
  const run = spawnCli(scenario, mode === "cold" ? { BERTH_BUILD_NO_CACHE: "1" } : {});
  const deadline = run.t0 + 30 * 60_000;
  const first = await firstDevRpc(scenario, deadline, run);
  const result = { ok: first.at !== undefined, totalMs: diff(first.at, run.t0) };
  if (!result.ok) result.failure = { exit: run.exitStatus, tail: run.lines.slice(-25).map((l) => l.text) };
  result.timeline = await containerTimeline(scenario.container, scenario.apps);
  if (mode === "reload" && result.ok) result.reload = await measureReload(scenario, run);
  if (opts.sampleResources) result.resources = await sampleResources(scenario, opts.idleMs);
  run.child.kill("SIGINT");
  const exit = await Promise.race([run.exited, sleep(60_000).then(() => undefined)]);
  if (!exit) run.child.kill("SIGKILL");
  await removeContainerIfPresent(scenario.container);
  return finish(result, run);
}

/** Edits a watched file under a running `berth dev` and times the restart to the next successful RPC. */
async function measureReload(scenario, run) {
  const c = docker.getContainer(scenario.container);
  const before = (await c.inspect()).State.StartedAt;
  const restored = touchSource(scenario.editFile);
  const t0 = Date.now();
  try {
    let restartedAt;
    while (Date.now() - t0 < 120_000) {
      const info = await c.inspect().catch(() => undefined);
      if (info && info.State.StartedAt !== before && info.State.Running) {
        restartedAt = Date.now();
        break;
      }
      await sleep(100);
    }
    const first = await firstDevRpc(scenario, Date.now() + 120_000, run);
    const seenRestarted = run.lines.find((l) => l.t >= t0 && /Restarted\./.test(l.text))?.t;
    return { totalMs: diff(first.at, t0), restartObservedMs: diff(restartedAt, t0), restartedLogMs: diff(seenRestarted, t0) };
  } finally {
    restored();
  }
}

async function runMcp(scenario, mode, opts) {
  const auditDir = mkdtempSync(join(tmpdir(), "berth-bench-audit-"));
  const withAudit = { ...scenario, args: [...scenario.args, "--audit-file", join(auditDir, "audit.jsonl")] };
  const run = spawnCli(withAudit, mode === "cold" ? { BERTH_BUILD_NO_CACHE: "1" } : {});
  const pending = new Map();
  let buf = "";
  run.child.stdout.removeAllListeners("data");
  run.child.stdout.on("data", (d) => {
    buf += d.toString("utf-8");
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const text of parts) {
      if (!text.trim()) continue;
      try {
        const msg = JSON.parse(text);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      } catch {
        run.lines.push({ t: Date.now(), stream: "out", text });
      }
    }
  });
  run.exited.then(() => {
    for (const [id, settle] of pending) settle({ id, error: { message: `berth mcp exited (${JSON.stringify(run.exitStatus)})` }, exited: true });
    pending.clear();
  });
  let nextId = 1;
  const request = (method, params, timeoutMs = 30 * 60_000) =>
    new Promise((resolveReq, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveReq(msg);
      });
      run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params) => run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  const result = { ok: false };
  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-boot-bench", version: "0" } }, 60_000);
    result.initializeMs = Date.now() - run.t0;
    if (init.error) throw new Error(JSON.stringify(init.error));
    notify("notifications/initialized", {});
    const deadline = run.t0 + 30 * 60_000;
    while (Date.now() < deadline) {
      const res = await request("tools/call", { name: scenario.tool, arguments: {} });
      if (res.result && !res.result.isError) {
        result.ok = true;
        result.totalMs = Date.now() - run.t0;
        break;
      }
      result.lastError = JSON.stringify(res.error ?? res.result).slice(0, 300);
      if (res.exited) break;
      await sleep(500);
    }
  } catch (err) {
    result.lastError = String(err);
  }
  if (!result.ok) result.failure = { exit: run.exitStatus, tail: run.lines.slice(-25).map((l) => l.text) };
  result.timeline = await containerTimeline(scenario.container, scenario.apps);
  if (opts.sampleResources) result.resources = await sampleResources(scenario, opts.idleMs);
  run.child.stdin.end();
  const exit = await Promise.race([run.exited, sleep(90_000).then(() => undefined)]);
  if (!exit) run.child.kill("SIGKILL");
  await removeContainerIfPresent(scenario.container);
  return finish(result, run);
}

function finish(result, run) {
  result.cliPhases = timingPhases(run.lines);
  const firstLine = run.lines.find((l) => /Building dev image|booting the sandbox/.test(l.text));
  result.cliPhases["cli.startup"] = diff(firstLine?.t, run.t0);
  result.buildSteps = buildSteps(run.lines);
  result.cacheHits = result.buildSteps.filter((s) => s.cached).length;
  result.expensiveStepsCached = result.buildSteps.filter((s) => s.cached && EXPENSIVE_STEP.test(s.directive)).map((s) => s.step);
  result.builtImageIds = builtImageIds(result.buildSteps);
  result.enforcementBanner = run.lines.some((l) => /not enforced|NOT ENFORCED|no Landlock/i.test(l.text));
  result.warnings = run.lines.filter((l) => /WARNING/.test(l.text)).map((l) => l.text.slice(0, 200));
  // What the CLI spends after the container starts, until the harness sees the first answer.
  const startEnd = run.lines.find((l) => /phase=start\.container-start/.test(l.text))?.t;
  result.afterStartMs = diff(result.totalMs !== undefined ? run.t0 + result.totalMs : undefined, startEnd);
  return result;
}

/** Appends a comment line to a source file; returns a function that restores the original bytes. */
function touchSource(rel) {
  const path = join(REPO, rel);
  const original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from(`\n// local-boot bench edit ${Date.now()}\n`)]));
  return () => writeFileSync(path, original);
}

// ---------------------------------------------------------------- resources

function parseSize(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return undefined;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 }[m[2].toUpperCase()] ?? 1;
  return Number(m[1]) * mult;
}

async function sampleResources(scenario, idleMs) {
  await sleep(idleMs);
  const names = [scenario.container, `${scenario.container}-fs`];
  const present = names.filter((n) => shOk("docker", ["inspect", n]) !== undefined);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const out = sh("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}", ...present]);
    for (const line of out.split("\n")) {
      const [name, cpu, mem, pids] = line.split("\t");
      samples.push({ name, cpu: parseFloat(cpu), memBytes: parseSize(mem.split("/")[0]), pids: Number(pids) });
    }
    await sleep(1000);
  }
  const byName = {};
  for (const n of present) {
    const s = samples.filter((x) => x.name === n);
    byName[n] = { cpuPct: summary(s.map((x) => x.cpu)), memBytes: summary(s.map((x) => x.memBytes)), pids: summary(s.map((x) => x.pids)) };
  }
  const processes = {};
  for (const n of present) {
    const top = shOk("docker", ["top", n, "-eo", "pid,rss,comm"]);
    processes[n] = top ? top.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).map(([pid, rss, ...comm]) => ({ pid: Number(pid), rssKb: Number(rss), comm: comm.join(" ") })) : [];
  }
  return { containers: byName, processes };
}

function hostAndVmFacts() {
  const facts = {
    macos: `${shOk("sw_vers", ["-productVersion"])} (${shOk("sw_vers", ["-buildVersion"])})`,
    cpu: shOk("sysctl", ["-n", "machdep.cpu.brand_string"]),
    hostCpus: Number(shOk("sysctl", ["-n", "hw.ncpu"])),
    hostMemBytes: Number(shOk("sysctl", ["-n", "hw.memsize"])),
    node: process.version,
    docker: shOk("docker", ["version", "--format", "client {{.Client.Version}}, server {{.Server.Version}}"]),
    // The orchestrator has already turned the selected context into DOCKER_HOST.
    dockerHost: process.env.DOCKER_HOST,
    colima: shOk("colima", ["version"])?.split("\n")[0],
    colimaList: shOk("colima", ["list"]),
    vmKernel: shOk("colima", ["ssh", "--", "uname", "-r"]),
    vmFree: shOk("colima", ["ssh", "--", "free", "-m"]),
    vmNproc: shOk("colima", ["ssh", "--", "nproc"]),
    daemonRss: shOk("colima", ["ssh", "--", "ps", "-o", "rss=,comm=", "-C", "dockerd,containerd"]),
    storage: shOk("docker", ["info", "--format", "{{.Driver}} / {{.DriverStatus}}"]),
    cgroup: shOk("docker", ["info", "--format", "cgroup {{.CgroupVersion}} ({{.CgroupDriver}})"]),
    // The VM process on the macOS side: what the whole Docker stack costs the host.
    vmHostProcess: shOk("sh", ["-c", "ps -axo rss=,%cpu=,command= | grep -i 'com.apple.Virtualization.VirtualMachine' | grep -v grep"]),
    doctor: shOk(process.execPath, [CLI, "doctor"]),
  };
  return facts;
}

function imageSizes(apps) {
  const out = {};
  for (const a of apps) {
    // Tags and cache refs are per checkout, so derive them the way the build does.
    const appDir = join(REPO, "apps", a);
    for (const ref of [orchestrator.checkoutTag(`berth/${a}:dev`, appDir), orchestrator.buildCacheRef(`berth/${a}:dev`, "dev", appDir)]) {
      const info = shOk("docker", ["image", "inspect", "--format", "{{.Size}}", ref]);
      if (info) out[ref] = Number(info);
    }
  }
  out.dockerImageLs = shOk("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}", "--filter", "reference=berth*"]);
  out.systemDf = shOk("docker", ["system", "df"]);
  return out;
}

// ---------------------------------------------------------------- main

function fmt(ms) {
  return ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ownNames = [...new Set(Object.values(SCENARIOS).map((s) => s.container))];
  const created = new Set(existsSync(opts.state) ? JSON.parse(readFileSync(opts.state, "utf-8")).created : []);
  const saveState = (result) => {
    for (const id of result?.builtImageIds ?? []) created.add(id);
    writeFileSync(opts.state, JSON.stringify({ created: [...created] }, null, 2));
  };
  if (opts.cleanup) {
    for (const name of ownNames) await removeContainerIfPresent(name);
    const left = resetCold(created);
    log(`removed the images this benchmark created; ${left} left in place (in use by a container?)`);
    writeFileSync(opts.state, JSON.stringify({ created: [...created].filter((id) => shOk("docker", ["image", "inspect", id]) !== undefined) }, null, 2));
    return;
  }
  const background = longRunningContainers();
  const report = { startedAt: new Date().toISOString(), facts: hostAndVmFacts(), backgroundContainers: [...background], runs: [], resources: {} };
  log(`host: ${report.facts.cpu}, ${report.facts.macos}; docker ${report.facts.docker} via ${report.facts.dockerHost}`);

  for (const name of opts.scenarios) {
    const scenario = SCENARIOS[name];
    for (const mode of opts.modes) {
      if (mode === "reload" && scenario.kind !== "dev") continue;
      for (let i = 0; i < opts.runs; i++) {
        await removeContainerIfPresent(scenario.container);
        if (mode === "cold") {
          const left = resetCold(created);
          if (left > 0) log(`cold reset left ${left} image(s) in place (in use?)`);
        } else if (i === 0) {
          // warm/edit/reload need the image cached first; this priming boot isn't recorded.
          await waitForQuietVm(opts.maxLoad, ownNames, background);
          assertDiskHeadroom(opts.minFreeGb);
          log(`${name}/${mode}: priming the cache`);
          saveState(await (scenario.kind === "dev" ? runDev(scenario, "warm", {}) : runMcp(scenario, "warm", {})));
        }
        const { load, foreign, waitedMs } = await waitForQuietVm(opts.maxLoad, ownNames, background);
        const hostFree = assertDiskHeadroom(opts.minFreeGb);
        const others = otherContainers(ownNames);
        const diskBefore = imagesDiskBytes();
        const restore = mode === "edit" ? touchSource(scenario.editFile) : () => {};
        let result;
        try {
          log(`${name}/${mode} run ${i + 1}/${opts.runs} (VM load ${load}, long-running containers: ${others.length}${foreign.length ? `, STILL BUSY: ${foreign.join(", ")}` : ""})`);
          result = await (scenario.kind === "dev" ? runDev(scenario, mode, {}) : runMcp(scenario, mode, {}));
        } finally {
          restore();
        }
        saveState(result);
        const diskAfter = imagesDiskBytes();
        const row = { scenario: name, mode, run: i + 1, vmLoadBefore: load, otherContainers: others, contention: foreign, waitedForQuietMs: waitedMs, hostFreeBytesBefore: hostFree, diskGrowthBytes: diff(diskAfter, diskBefore), ...result };
        if (mode === "cold") row.coldClean = row.expensiveStepsCached.length === 0;
        report.runs.push(row);
        log(
          `  -> ${row.ok ? "ok" : "FAILED"} total ${fmt(row.totalMs)}${row.reload ? `, reload ${fmt(row.reload.totalMs)}` : ""}, build ${fmt(row.cliPhases["build.docker-build"])}, ` +
            `container start->ready ${fmt(row.timeline?.startedToReady)}, disk ${((row.diskGrowthBytes ?? 0) / 1e6).toFixed(0)} MB, cached steps ${row.cacheHits}` +
            (mode === "cold" && !row.coldClean ? ` (NOT CLEAN: expensive steps ${row.expensiveStepsCached.join(",")} cached)` : ""),
        );
        if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2));
      }
    }
  }

  if (opts.resources) {
    for (const name of opts.scenarios) {
      const scenario = SCENARIOS[name];
      log(`${name}: resource sample (idle ${opts.idleMs} ms)`);
      const r = await (scenario.kind === "dev" ? runDev(scenario, "warm", { sampleResources: true, idleMs: opts.idleMs }) : runMcp(scenario, "warm", { sampleResources: true, idleMs: opts.idleMs }));
      report.resources[name] = { ...r.resources, images: imageSizes(scenario.apps), enforcement: r.timeline?.enforcement, notRestricted: r.timeline?.notRestricted };
      saveState(r);
    }
  }
  report.createdImageIds = [...created];
  report.finishedAt = new Date().toISOString();
  if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2));
  printTables(report);
}

function printTables(report) {
  const groups = new Map();
  for (const r of report.runs) {
    const key = `${r.scenario} ${r.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const s = (x) => (x ? `${fmt(x.median)} (${fmt(x.min)}-${fmt(x.max)})` : "-");
  console.log("\n| scenario | mode | ok/n | total to first call, median (min-max) | docker build | container start to app ready |");
  console.log("|---|---|---|---|---|---|");
  for (const [key, rows] of groups) {
    const [scenario, mode] = key.split(" ");
    const total = summary(rows.map((r) => (mode === "reload" ? r.reload?.totalMs : r.totalMs)));
    console.log(
      `| ${scenario} | ${mode} | ${rows.filter((r) => r.ok).length}/${rows.length} | ${s(total)} | ${s(summary(rows.map((r) => r.cliPhases["build.docker-build"])))} | ${s(summary(rows.map((r) => r.timeline?.startedToReady)))} |`,
    );
  }
  console.log("\nPhase medians (ms):");
  const phaseNames = [
    "cli.startup",
    "build.stage-source",
    "build.stage-assets",
    "build.docker-build",
    "build.retain-cache",
    "start.enforcement-probe",
    "start.semantic-fs-sidecar",
    "start.container-create",
    "start.container-start",
    "ctr.tini-to-entrypoint",
    "ctr.lifecycle-flags",
    "ctr.daemons-sidecar-wait-policy",
    "ctr.agent-init",
    "ctr.runtime-to-ready",
  ];
  console.log(`| phase | ${[...groups.keys()].join(" | ")} |`);
  console.log(`|---|${[...groups.keys()].map(() => "---").join("|")}|`);
  for (const p of phaseNames) {
    const cells = [...groups.values()].map((rows) => {
      const x = summary(rows.map((r) => r.cliPhases[p] ?? r.timeline?.phases?.[p]));
      return x ? String(Math.round(x.median)) : "-";
    });
    console.log(`| ${p} | ${cells.join(" | ")} |`);
  }
  console.log("\n" + JSON.stringify({ summary: [...groups].map(([k, rows]) => ({ group: k, total: summary(rows.map((r) => (k.endsWith("reload") ? r.reload?.totalMs : r.totalMs))) })) }));
}

await main();
