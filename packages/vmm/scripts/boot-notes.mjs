#!/usr/bin/env node
// Boots apps/notes in a berth-vmm microVM, calls add_note + list_notes from the
// host over the vsock-mapped Unix socket, samples the berth-vmm process RSS,
// and shuts the VM down. Repeats RUNS times and prints the timings.
//
//   node boot-notes.mjs            one boot, guest console to stderr
//   RUNS=6 node boot-notes.mjs     first run + 5 repeats, prints median
//
// Env: ART (artifacts dir), KRUNFW_DIR (dir holding libkrunfw.5.dylib; default
// our Berth kernel), CPUS, MEM, SANDBOX_PROFILE (run under sandbox-exec -f).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vmmDir = join(here, "..");
const ART = process.env.ART ?? join(vmmDir, "..", "..", "..", "libkrun-vm-artifacts");
const VMM = join(vmmDir, "target/release/berth-vmm");
const KRUNFW_DIR = process.env.KRUNFW_DIR ?? join(ART, "kernel/lib");
const RUNS = Number(process.env.RUNS ?? 1);
const runDir = join(ART, "run");
mkdirSync(runDir, { recursive: true });
const sock = join(runDir, "notes.sock");
const noise = [];

function vmArgs() {
  return [
    "--cpus", process.env.CPUS ?? "2",
    "--mem", process.env.MEM ?? "512",
    "--root", join(ART, "rootfs-notes"), "--root-ro",
    "--share", `app:${join(ART, "app-notes")}:ro`,
    "--vsock", `5000:${sock}:listen`,
    "--env", `BERTH_VM_MODE=${process.env.BERTH_VM_MODE ?? "rpc"}`,
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
      const added = await call("1", "add_note", { text: "hello from the host" });
      const tFirst = performance.now();
      const listed = await call("2", "list_notes");
      clearTimeout(timer);
      c.removeAllListeners("close");
      c.end();
      resolve({ tFirst, added, listed });
    });
  });
}

async function bootOnce(i) {
  rmSync(sock, { force: true });
  const console_ = [];
  const marks = {};
  const cmd = process.env.SANDBOX_PROFILE ? "sandbox-exec" : VMM;
  const args = process.env.SANDBOX_PROFILE
    ? ["-f", process.env.SANDBOX_PROFILE, "-D", `ART=${ART}`, "-D", `VMM_DIR=${vmmDir}`, VMM, ...vmArgs()]
    : vmArgs();
  const t0 = performance.now();
  const vm = spawn(cmd, args, {
    env: { DYLD_LIBRARY_PATH: KRUNFW_DIR, PATH: process.env.PATH },
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
  const vmmPid = process.env.SANDBOX_PROFILE ? Number(execFileSync("pgrep", ["-P", String(vm.pid)], { encoding: "utf8" }).trim()) || vm.pid : vm.pid;
  const rss = rssKiB(vmmPid);
  const footprint = footprintMiB(vmmPid);
  vm.kill("SIGTERM");
  await new Promise((r) => (exited ? r() : vm.on("exit", r)));
  const text = console_.join("");
  const mem = /guest-mem (.*)/.exec(text)?.[1]?.trim();
  return { run: i, firstRpcMs: Math.round(firstRpcMs), marksMs: marks, vmmRssMiB: rss ? Math.round(rss / 1024) : null, vmmFootprintMiB: footprint, guestMem: mem, added: result.added, listed: result.listed, console: text };
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
