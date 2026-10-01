#!/usr/bin/env node
// Boots apps/notes in a berth-vmm microVM (pinned kernel, read-only rootfs
// image, optional state disk), calls the notes exports from the host over the
// vsock-mapped Unix socket, samples the berth-vmm process memory, and stops
// the VM. Repeats RUNS times and prints the timings.
//
//   node boot-notes.mjs            one boot, guest console to stderr
//   RUNS=6 node boot-notes.mjs     first run + 5 repeats, prints median
//
// Env: ART (artifacts dir), KERNEL (default: the manifest-pinned Image in
// $ART/kernel/sha256/), ROOTFS (default: $ART/rootfs/LATEST), STATE (state
// disk path; none = tmpfs /workspace), ACTIONS (comma list of add,list;
// default add,list), STOP (graceful = {"op":"shutdown"} on control vsock 1024, the default;
// kill = SIGKILL berth-vmm), CPUS, MEM, SANDBOX_PROFILE (run under
// sandbox-exec -f), BERTH_VM_MODE (rpc; inspect/probe just print and exit),
// ROOT_DIR + APP_DIR (boot a virtio-fs root directory instead, for comparison).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vmmDir = join(here, "..");
const ART = process.env.ART ?? join(vmmDir, "..", "..", "..", "vm-image-artifacts");
const VMM = join(vmmDir, "target/release/berth-vmm");
const pinnedKernel = /^image_sha256 = "([0-9a-f]{64})"/m.exec(readFileSync(join(vmmDir, "kernel/manifest.toml"), "utf8"))[1];
const KERNEL = process.env.KERNEL ?? join(ART, "kernel/sha256", pinnedKernel, "Image");
const ROOTFS = process.env.ROOTFS ?? join(ART, "rootfs", readFileSync(join(ART, "rootfs/LATEST"), "utf8").trim());
const STATE = process.env.STATE;
const ACTIONS = (process.env.ACTIONS ?? "add,list").split(",").filter(Boolean);
const STOP = process.env.STOP ?? "graceful";
const MODE = process.env.BERTH_VM_MODE ?? "rpc";
const RUNS = Number(process.env.RUNS ?? 1);
const runDir = join(ART, "run");
mkdirSync(runDir, { recursive: true });
const sock = join(runDir, "notes.sock");
const ctl = join(runDir, "notes-ctl.sock");
const noise = [];

function vmArgs() {
  return [
    "--cpus", process.env.CPUS ?? "2",
    "--mem", process.env.MEM ?? "512",
    "--kernel", KERNEL,
    // ROOT_DIR: a virtio-fs root directory instead (the spike's layout), for comparison.
    ...(process.env.ROOT_DIR ? ["--root", process.env.ROOT_DIR, "--root-ro"] : ["--rootfs", ROOTFS]),
    ...(STATE ? ["--state", STATE, "--state-size", process.env.STATE_SIZE ?? "256"] : []),
    "--share", `app:${process.env.APP_DIR ?? join(ART, "app-notes")}:ro`,
    "--vsock", `5000:${sock}:listen`,
    "--vsock", `1024:${ctl}:listen`,
    "--env", `BERTH_VM_MODE=${MODE}`,
    "--", "/sbin/berth-init",
  ];
}

// Physical footprint (dirty memory, what macOS charges the process), as
// opposed to RSS, which also counts clean shared-library pages.
function footprintMiB(pid) {
  try {
    const out = execFileSync("footprint", [String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(out);
    if (!m) return null;
    return Math.round(Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]]);
  } catch {
    return null;
  }
}

// Host-clock time at which each guest console marker first arrived.
const MARKS = {
  guestInit: "[berth:vm-init] init start",
  stateMounted: "/workspace persistent",
  policyCompiled: "policy compiled for",
  agentInitApplied: "ruleset=FullyEnforced",
  appReady: '[berth:runtime] "notes" ready',
};

function rssKiB(pid) {
  try {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

function rpcOnce(timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "";
    const pending = new Map();
    const call = (id, exp, input) =>
      new Promise((res) => {
        pending.set(id, res);
        c.write(JSON.stringify({ id, export: exp, input }) + "\n");
      });
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        // The app's own console.log output (e.g. the local context-bus stub)
        // shares stdout with the RPC framing, as it does in the container.
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          noise.push(line);
          continue;
        }
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
    c.on("error", reject);
    c.on("close", () => reject(new Error("closed before an answer")));
    c.on("connect", async () => {
      const timer = setTimeout(() => {
        c.destroy();
        reject(new Error("no answer"));
      }, timeoutMs);
      let tFirst, added, listed;
      for (const [i, a] of ACTIONS.entries()) {
        if (a === "add") added = await call(String(i + 1), "add_note", { text: process.env.NOTE ?? "hello from the host" });
        else if (a === "list") listed = await call(String(i + 1), "list_notes");
        else throw new Error(`unknown action ${a}`);
        tFirst ??= performance.now();
      }
      clearTimeout(timer);
      c.removeAllListeners("close");
      c.end();
      resolve({ tFirst, added, listed });
    });
  });
}

async function bootOnce(i) {
  rmSync(sock, { force: true });
  rmSync(ctl, { force: true });
  const console_ = [];
  const marks = {};
  const cmd = process.env.SANDBOX_PROFILE ? "sandbox-exec" : VMM;
  const args = process.env.SANDBOX_PROFILE
    ? // sandbox-exec is a platform binary, so dyld drops DYLD_* on the way in;
    // env re-adds it inside. sandbox-exec and env both exec, so vm.pid stays
    // the berth-vmm process.
    ["-f", process.env.SANDBOX_PROFILE, "-D", `ART=${ART}`, "-D", `VMM_DIR=${vmmDir}`, VMM, ...vmArgs()]
    : vmArgs();
  const t0 = performance.now();
  const vm = spawn(cmd, args, {
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [vm.stdout, vm.stderr]) {
    s.setEncoding("utf8");
    s.on("data", (d) => {
      console_.push(d);
      const now = performance.now();
      for (const [k, needle] of Object.entries(MARKS)) if (!(k in marks) && d.includes(needle)) marks[k] = Math.round(now - t0);
      if (RUNS === 1) process.stderr.write(d);
    });
  }
  let exited = null;
  vm.on("exit", (code, sig) => (exited = { code, sig }));

  let result;
  const deadline = Date.now() + 30000;
  if (MODE !== "rpc") {
    // inspect/probe print to the console and stop on their own.
    await new Promise((r) => (exited ? r() : vm.on("exit", r)));
    return { run: i, mode: MODE, exited, console: console_.join("") };
  }
  for (;;) {
    if (exited) throw new Error(`berth-vmm exited early ${JSON.stringify(exited)}\n${console_.join("")}`);
    if (existsSync(sock)) {
      try {
        result = await rpcOnce(20000);
        break;
      } catch {}
    }
    if (Date.now() > deadline) throw new Error(`no RPC answer within 30 s\n${console_.join("")}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const firstRpcMs = result.tFirst - t0;
  // Let the guest-mem line (logged 2 s after init) arrive, then sample RSS.
  await new Promise((r) => setTimeout(r, 2500));
  const vmmPid = vm.pid;
  const rss = rssKiB(vmmPid);
  const footprint = footprintMiB(vmmPid);
  const tStop = performance.now();
  if (STOP === "graceful") {
    // The stop request on the control port (feat/vm-guest-init's port plan):
    // berth-init stops the app, syncs and unmounts the state disk, then exits.
    await new Promise((r) => {
      const c = net.createConnection(ctl);
      c.on("connect", () => c.end('{"op":"shutdown"}\n'));
      c.on("error", r);
      c.on("close", r);
    });
    const killTimer = setTimeout(() => vm.kill("SIGKILL"), 10000);
    await new Promise((r) => (exited ? r() : vm.on("exit", r)));
    clearTimeout(killTimer);
  } else {
    vm.kill("SIGKILL");
    await new Promise((r) => (exited ? r() : vm.on("exit", r)));
  }
  const stopMs = Math.round(performance.now() - tStop);
  const text = console_.join("");
  const mem = /guest-mem (.*)/.exec(text)?.[1]?.trim();
  const measLine = text.split("\n").find((l) => l.includes('"event":"measurements"'));
  const measurements = measLine ? JSON.parse(measLine) : null;
  return { run: i, firstRpcMs: Math.round(firstRpcMs), stop: STOP, stopMs, exited, marksMs: marks, vmmRssMiB: rss ? Math.round(rss / 1024) : null, vmmFootprintMiB: footprint, guestMem: mem, measurements, added: result.added, listed: result.listed, console: text };
}

const results = [];
for (let i = 0; i < RUNS; i++) {
  const r = await bootOnce(i);
  results.push(r);
  const { console: _c, ...summary } = r;
  console.log(JSON.stringify(summary));
}
writeFileSync(join(runDir, "last-boot-console.log"), results.at(-1).console);
if (RUNS > 1) {
  const repeats = results.slice(1).map((r) => r.firstRpcMs).sort((a, b) => a - b);
  const median = repeats[Math.floor(repeats.length / 2)];
  console.log(JSON.stringify({ first: results[0].firstRpcMs, repeats, medianRepeat: median, rssMiB: results.map((r) => r.vmmRssMiB), footprintMiB: results.map((r) => r.vmmFootprintMiB) }));
}
