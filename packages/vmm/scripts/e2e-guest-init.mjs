#!/usr/bin/env node
// End-to-end checks for berth-init as PID 1, booted by berth-vmm with our
// kernel as a raw Image and init=/sbin/berth-init (no init.krun, no socat).
//
//   node e2e-guest-init.mjs single     notes alone: many calls over one
//                                      long-lived relay connection, same pid
//                                      throughout, logs on their own port
//   node e2e-guest-init.mjs multi      notes + filesystem, per-app cgroups
//   node e2e-guest-init.mjs stdio      single, with BERTH_VM_RPC=stdio
//   node e2e-guest-init.mjs state      /workspace on a state disk (BERTH_STATE_DEV) across two boots
//   node e2e-guest-init.mjs exits      power off when the last app exits, and on a refused boot
//   RUNS=6 node e2e-guest-init.mjs bench   first boot + 5, median spawn->first RPC
//                                      (BENCH_APP=notes-plain: no resources block)
//
// It is also the reference for the host side of the vsock port plan
// (docs/design/microvm-guest-init.md): every line read from the guest is
// treated as untrusted — bounded in length, parsed as JSON, and checked for
// the shape expected on that port before anything is done with it.
//
// Env: GI_ART (artifacts), ART (spike artifacts: kernel), CPUS, MEM, VERBOSE=1.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vmmDir = join(here, "..");
const wt = join(vmmDir, "..", "..", "..");
const GI_ART = process.env.GI_ART ?? join(wt, "vm-guest-init-artifacts");
const ART = process.env.ART ?? join(wt, "libkrun-vm-artifacts");
const VMM = join(vmmDir, "target/release/berth-vmm");
const KERNEL = join(ART, "kernel/Image");
// INIT_KRUN=1 boots the way the spike did: libkrun's init.krun first, which
// mounts /proc, /sys and /dev and then execs berth-init (still PID 1).
const INIT = process.env.INIT_KRUN === "1" ? "/init.krun" : "/sbin/berth-init";
const CMDLINE = `reboot=k panic=-1 panic_print=0 nomodule console=hvc0 rootfstype=virtiofs ro quiet no-kvmapf init=${INIT}${process.env.CMDLINE_EXTRA ? " " + process.env.CMDLINE_EXTRA : ""}`;
const runDir = join(GI_ART, "run");
mkdirSync(runDir, { recursive: true });
const VERBOSE = process.env.VERBOSE === "1";

const CONTROL_PORT = 1024;
const LOG_PORT = 1025;
const RPC_PORT_BASE = 5000;
/** Host-side bound on any line from the guest. */
const MAX_LINE = 1 << 20;

const sockPath = (port) => join(runDir, `vsock-${port}.sock`);

function fail(msg) {
  throw new Error(msg);
}

/**
 * A line reader over one connection to a guest port. Rejects lines longer
 * than MAX_LINE and anything that is not a JSON object; `accept` is the
 * per-port shape check.
 */
function lines(sock, accept, onLine, onBad, initial = "") {
  let buf = "";
  sock.setEncoding("utf8");
  const feed = (d) => {
    buf += d;
    if (buf.length > MAX_LINE && !buf.includes("\n")) {
      onBad(`line over ${MAX_LINE} bytes`);
      sock.destroy();
      return;
    }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let v;
      try {
        v = JSON.parse(line);
      } catch {
        onBad(line);
        continue;
      }
      if (v === null || typeof v !== "object" || Array.isArray(v) || !accept(v)) {
        onBad(line);
        continue;
      }
      onLine(v);
    }
  };
  sock.on("data", feed);
  if (initial) feed(initial);
}

/**
 * libkrun accepts a host connection on a listen-mode port before anything in
 * the guest listens there, and closes it if nothing does. Control and log
 * both start with a line from the guest, so a connection is good once that
 * first line arrives; a close before it means "not yet", and we reconnect.
 */
async function connectGreeted(port, deadlineMs = 20000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const s = await connectPort(port, Math.max(1, end - Date.now()));
    const first = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2000);
      s.once("data", (d) => {
        clearTimeout(t);
        resolve(d.toString("utf8"));
      });
      s.once("close", () => {
        clearTimeout(t);
        resolve(null);
      });
    });
    if (first !== null) return { sock: s, first };
    s.destroy();
    if (Date.now() > end) fail(`vsock:${port}: no greeting from the guest`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const isEvent = (v) => v.source === "berth-init" && typeof v.event === "string";
const isLog = (v) => typeof v.src === "string" && typeof v.stream === "string" && typeof v.line === "string" && typeof v.t === "number";
// An export that returns nothing answers {"id"} alone: JSON.stringify drops
// an undefined result.
const isRpc = (v) => typeof v.id === "string";

/** Connects to a listen-mode vsock port, retrying until the guest listens. */
async function connectPort(port, deadlineMs = 20000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (existsSync(sockPath(port))) {
      const s = await new Promise((resolve) => {
        const c = net.createConnection(sockPath(port));
        c.once("connect", () => resolve(c));
        c.once("error", () => resolve(null));
      });
      if (s) return s;
    }
    if (Date.now() > end) fail(`could not connect to vsock:${port}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

class Rpc {
  constructor(sock) {
    this.sock = sock;
    this.pending = new Map();
    this.bad = [];
    this.next = 1;
    this.closed = false;
    lines(sock, isRpc, (v) => {
      this.pending.get(v.id)?.(v);
      this.pending.delete(v.id);
    }, (l) => this.bad.push(l));
    sock.on("close", () => {
      this.closed = true;
      for (const r of this.pending.values()) r({ error: "connection closed" });
      this.pending.clear();
    });
  }
  call(exp, input, timeoutMs = 20000) {
    const id = `h${this.next++}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${exp}: no answer in ${timeoutMs} ms`)), timeoutMs);
      this.pending.set(id, (v) => {
        clearTimeout(t);
        if (v.error) reject(new Error(`${exp}: ${v.error}`));
        else resolve(v.result);
      });
      this.sock.write(JSON.stringify({ id, export: exp, input }) + "\n");
    });
  }
}

/** libkrun accepts the host connection before the guest listens; a call on such a connection gets a close. Retry the first call on a fresh one. */
async function rpcConnect(port, firstCall) {
  const end = Date.now() + 30000;
  for (;;) {
    const r = new Rpc(await connectPort(port));
    try {
      const result = await firstCall(r);
      return { r, result };
    } catch (e) {
      r.sock.destroy();
      if (Date.now() > end) throw e;
      await new Promise((res) => setTimeout(res, 5));
    }
  }
}

async function boot(apps, { env = {}, mem, extra = [] } = {}) {
  const tags = apps.length === 1 ? ["app"] : apps;
  const ports = [CONTROL_PORT, LOG_PORT, ...apps.map((_, i) => RPC_PORT_BASE + i)];
  for (const p of ports) rmSync(sockPath(p), { force: true });
  const args = [
    "--cpus", process.env.CPUS ?? "2",
    "--mem", mem ?? process.env.MEM ?? "512",
    "--kernel", KERNEL, "--kernel-format", "0", "--cmdline", CMDLINE,
    "--root", join(GI_ART, "rootfs"), "--root-ro",
    ...apps.flatMap((a, i) => ["--share", `${tags[i]}:${join(GI_ART, "apps", a)}:ro`]),
    ...ports.flatMap((p) => ["--vsock", `${p}:${sockPath(p)}:listen`]),
    ...extra,
    "--env", `BERTH_VM_APPS=${tags.join(",")}`,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--", "/sbin/berth-init",
  ];
  const t0 = performance.now();
  const vm = spawn(VMM, args, { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  const consoleText = [];
  for (const s of [vm.stdout, vm.stderr]) {
    s.setEncoding("utf8");
    s.on("data", (d) => {
      consoleText.push(d);
      if (VERBOSE) process.stderr.write(d);
    });
  }
  const exited = new Promise((r) => vm.on("exit", (code, sig) => r({ code, sig, atMs: performance.now() - t0 })));
  return { vm, t0, exited, consoleText, ports };
}

/** Control and log readers, attached as soon as the guest listens. */
async function attachStreams(b) {
  const events = [];
  const logs = [];
  const bad = { control: [], logs: [] };
  const waiters = [];
  const { sock: ctl, first: ctlFirst } = await connectGreeted(CONTROL_PORT);
  lines(ctl, isEvent, (v) => {
    events.push(v);
    for (const w of [...waiters]) if (w.match(v)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(v);
    }
  }, (l) => bad.control.push(l), ctlFirst);
  const { sock: lg, first: lgFirst } = await connectGreeted(LOG_PORT);
  lines(lg, isLog, (v) => logs.push(v), (l) => bad.logs.push(l), lgFirst);
  const waitEvent = (match, ms = 20000) => {
    const hit = events.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timed out waiting for an event; have ${events.length}: ${events.map((e) => e.event).join(",")}; bad: ${JSON.stringify(bad)}`)), ms);
    });
  };
  const status = async () => {
    ctl.write(JSON.stringify({ op: "status" }) + "\n");
    return waitEvent((v) => v.event === "status" && !v._seen && (v._seen = true));
  };
  return { ctl, lg, events, logs, bad, waitEvent, status };
}

async function shutdown(b, s) {
  const t = performance.now();
  s.ctl.write(JSON.stringify({ op: "shutdown" }) + "\n");
  const ex = await b.exited;
  const off = s.events.find((e) => e.event === "power_off");
  return { vmExitMs: Math.round(performance.now() - t), exit: ex, powerOff: off };
}

function check(cond, what, results) {
  results.push({ check: what, pass: !!cond });
  if (!cond) console.error(`FAIL: ${what}`);
}

async function single(rpcMode) {
  const results = [];
  const b = await boot(["notes"], { env: rpcMode ? { BERTH_VM_RPC: rpcMode } : {} });
  const s = await attachStreams(b);
  const { r, result: first } = await rpcConnect(RPC_PORT_BASE, (r) => r.call("add_note", { text: "note 1" }));
  const firstRpcMs = Math.round(performance.now() - b.t0);
  const st0 = await s.status();
  const pid0 = st0.apps[0].pid;
  for (let i = 2; i <= 6; i++) await r.call("add_note", { text: `note ${i}` });
  const listed = await r.call("list_notes");
  // A second, concurrent host connection onto the same app process.
  const { r: r2 } = await rpcConnect(RPC_PORT_BASE, (x) => x.call("list_notes"));
  const both = await Promise.all([r.call("add_note", { text: "from A" }), r2.call("add_note", { text: "from B" })]);
  const listed2 = await r2.call("list_notes");
  const st1 = await s.status();
  await new Promise((res) => setTimeout(res, 200));
  const off = await shutdown(b, s);

  const logLines = s.logs.map((l) => `${l.t} [${l.src}/${l.stream}] ${l.line}`);
  check(typeof first?.id === "string", "add_note answered over vsock", results);
  check(listed.notes.length === 6, `list_notes over the same connection sees 6 notes (got ${listed.notes.length})`, results);
  check(listed2.notes.length === 8 && both.every((x) => typeof x.id === "string"), "two concurrent host connections share one app (8 notes)", results);
  check(pid0 && st1.apps[0].pid === pid0 && st1.apps[0].state === "ready", `app pid unchanged across calls and connections (${pid0} -> ${st1.apps[0].pid})`, results);
  check(r.bad.length === 0 && r2.bad.length === 0, `RPC stream carried only RPC answers (stray lines: ${r.bad.length + r2.bad.length})`, results);
  check(s.logs.some((l) => l.src === "notes" && l.line.includes('[berth:runtime] "notes" ready')), "the app's own stderr arrived on the log port", results);
  check(s.logs.some((l) => l.src === "notes" && l.line.includes("ruleset=FullyEnforced")), "agent-init: Landlock ruleset=FullyEnforced for notes", results);
  check(s.bad.logs.length === 0 && s.bad.control.length === 0, "log and control streams well-formed", results);
  const cg = st1.apps[0].cgroup;
  check(cg && cg.path === "/berth/apps/notes" && cg.procs.includes(pid0), `notes' pid is in /berth/apps/notes (${JSON.stringify(cg?.procs)})`, results);
  check(cg && cg.limits["cpu.max"] === "50000 100000" && cg.limits["memory.max"] === String(160 * 1024 * 1024) && cg.limits["pids.max"] === "256", `limits read back: ${JSON.stringify(cg?.limits)}`, results);
  check(off.powerOff && off.exit.code === 0, `clean power off on request (vm exit ${JSON.stringify(off.exit)}, ${off.vmExitMs} ms)`, results);
  return { results, firstRpcMs, shutdown: { vmExitMs: off.vmExitMs, powerOff: off.powerOff }, events: s.events.map(evSummary), logSample: logLines.slice(0, 80), console: b.consoleText.join("") };
}

const evSummary = (e) => {
  const { source: _s, bootId: _b, ...rest } = e;
  return rest;
};

async function multi() {
  const results = [];
  const b = await boot(["notes", "filesystem"], { mem: process.env.MEM ?? "1024" });
  const s = await attachStreams(b);
  const { r: notes } = await rpcConnect(RPC_PORT_BASE, (r) => r.call("add_note", { text: "multi" }));
  const { r: fs } = await rpcConnect(RPC_PORT_BASE + 1, (r) => r.call("write_file", { path: "hello.txt", content: "from the host" }));
  const read = await fs.call("read_file", { path: "hello.txt" });
  const files = await fs.call("list_files");
  const listed = await notes.call("list_notes");
  const st = await s.status();
  await new Promise((res) => setTimeout(res, 200));
  const off = await shutdown(b, s);
  const [n, f] = st.apps;
  check(read.content === "from the host", "filesystem write_file/read_file over vsock:5001", results);
  check(listed.notes.length === 1, "notes over vsock:5000 alongside", results);
  check(n.uid === 10000 && f.uid === 10001 && n.pid !== f.pid, "two apps, two uids, two processes", results);
  check(n.cgroup?.procs.includes(n.pid) && f.cgroup?.procs.includes(f.pid), "each app in its own cgroup", results);
  check(f.cgroup?.limits["cpu.max"] === "100000 100000" && f.cgroup?.limits["memory.max"] === String(192 * 1024 * 1024) && f.cgroup?.limits["pids.max"] === "256", `filesystem limits: ${JSON.stringify(f.cgroup?.limits)}`, results);
  check(n.cgroup?.limits["cpu.max"] === "50000 100000", `notes limits: ${JSON.stringify(n.cgroup?.limits)}`, results);
  check(st.daemonsCgroup?.procs.includes(1), `berth-init (pid 1) in /berth/daemons (${JSON.stringify(st.daemonsCgroup?.procs)})`, results);
  const bus = st.daemons.find((d) => d.name === "context-bus");
  check(bus && st.daemonsCgroup.procs.includes(bus.pid), "context-bus-daemon in /berth/daemons", results);
  check(s.logs.some((l) => l.src === "context-bus" && l.line.includes("ruleset=FullyEnforced")), "context-bus-daemon confined (FullyEnforced)", results);
  check(["notes", "filesystem"].every((a) => s.logs.some((l) => l.src === a && l.line.includes("ruleset=FullyEnforced"))), "both apps FullyEnforced", results);
  const deleg = s.events.find((e) => e.event === "cgroup_delegation");
  check(deleg?.status === "active", `cgroup_delegation ${JSON.stringify(deleg && evSummary(deleg))}`, results);
  check(off.powerOff && off.exit.code === 0, `clean power off (${off.vmExitMs} ms)`, results);
  check(notes.bad.length === 0 && fs.bad.length === 0, "RPC streams clean", results);
  return { results, status: st, files, events: s.events.map(evSummary), logSample: s.logs.map((l) => `[${l.src}/${l.stream}] ${l.line}`).slice(0, 120), console: b.consoleText.join("") };
}

/** PID 1's other two ways down: every app exiting, and a refused boot. */
async function exits() {
  const results = [];
  // An app whose code throws at load: the runtime exits, and with it the last app.
  const broken = join(GI_ART, "apps", "broken");
  rmSync(broken, { recursive: true, force: true });
  mkdirSync(join(broken, "dist"), { recursive: true });
  for (const f of ["berth.yml", "runtime.mjs"]) writeFileSync(join(broken, f), readFileSync(join(GI_ART, "apps", "notes", f)));
  mkdirSync(join(broken, "proto"), { recursive: true });
  writeFileSync(join(broken, "dist", "index.mjs"), 'throw new Error("this app fails at load");\n');
  let b = await boot(["broken"]);
  let s = await attachStreams(b);
  let ex = await b.exited;
  let exited = s.events.find((e) => e.event === "app_exited");
  let off = s.events.find((e) => e.event === "power_off");
  check(exited && exited.exit.code !== 0, `app exit recorded: ${JSON.stringify(exited?.exit)}`, results);
  check(off?.reason === "every app has exited" && off.exitCode === 1 && ex.code === 0, `VM powered off by itself once no app was left (${off?.reason}, exitCode ${off?.exitCode}, ${Math.round(ex.atMs)} ms)`, results);
  check(s.logs.some((l) => l.src === "notes" && l.line.includes("this app fails at load")), "the app's error is on the log port", results);

  // A configuration berth-init refuses outright.
  b = await boot(["notes"], { env: { BERTH_VM_RPC: "tcp" } });
  s = await attachStreams(b);
  ex = await b.exited;
  const failed = s.events.find((e) => e.event === "boot_failed");
  off = s.events.find((e) => e.event === "power_off");
  check(failed && /BERTH_VM_RPC/.test(failed.reason) && off?.exitCode === 1, `refused boot reported on control, then power off (${failed?.reason})`, results);
  return { results };
}

/** feat/vm-image's state disk: /workspace survives a reboot of the same sandbox. */
async function state() {
  const results = [];
  const img = join(GI_ART, "run", "state.img");
  rmSync(img, { force: true });
  writeFileSync(img, "");
  truncateSync(img, 64 * 1024 * 1024);
  const opts = { extra: ["--disk", `state:${img}`], env: { BERTH_STATE_DEV: "/dev/vda" } };
  let b = await boot(["notes"], opts);
  let s = await attachStreams(b);
  let { r } = await rpcConnect(RPC_PORT_BASE, (x) => x.call("add_note", { text: "survives a reboot" }));
  await shutdown(b, s);
  const formatted = s.logs.some((l) => l.line.includes("formatting ext4"));
  const off1 = s.events.find((e) => e.event === "power_off");
  // libkrun 1.19.6 truncates a raw image when the guest write-zeroes its last
  // blocks (mkfs.ext4 does): feat/vm-image's berth-vmm --state restores the
  // size before boot (b5cecef); this branch's berth-vmm predates that, so the
  // test does the same here.
  const truncatedTo = statSync(img).size;
  truncateSync(img, 64 * 1024 * 1024);
  b = await boot(["notes"], opts);
  s = await attachStreams(b);
  ({ r } = await rpcConnect(RPC_PORT_BASE, (x) => x.call("list_notes")));
  const listed = await r.call("list_notes");
  const off2 = await shutdown(b, s);
  check(formatted, "first boot formats the blank state disk", results);
  check(!s.logs.some((l) => l.line.includes("formatting ext4")), "second boot reuses it", results);
  check(listed.notes.some((n) => n.text === "survives a reboot"), `the note from the first boot is there after the second (${listed.notes.length} notes)`, results);
  check(off1?.unmountFailed.length === 0 && off2.powerOff?.unmountFailed.length === 0, "state disk unmounted cleanly at both power offs", results);
  return { results, truncatedTo };
}

async function bench() {
  const runs = Number(process.env.RUNS ?? 6);
  const out = [];
  for (let i = 0; i < runs; i++) {
    const b = await boot([process.env.BENCH_APP ?? "notes"]);
    const s = await attachStreams(b);
    await rpcConnect(RPC_PORT_BASE, (r) => r.call("add_note", { text: "bench" }));
    const ms = Math.round(performance.now() - b.t0);
    const marks = Object.fromEntries(
      s.events.filter((e) => e.event === "boot_phase" || e.event === "app_ready" || e.event === "boot_start").map((e) => [e.phase ?? e.event, e.uptimeMs]),
    );
    const off = await shutdown(b, s);
    out.push({ run: i, firstRpcMs: ms, guestUptimeMs: marks, shutdownMs: off.vmExitMs });
    console.error(JSON.stringify(out.at(-1)));
  }
  const repeats = out.slice(1).map((r) => r.firstRpcMs).sort((a, b) => a - b);
  return { runs: out, first: out[0].firstRpcMs, repeats, medianRepeat: repeats[Math.floor(repeats.length / 2)] };
}

const mode = process.argv[2] ?? "single";
const res =
  mode === "multi" ? await multi() : mode === "bench" ? await bench() : mode === "exits" ? await exits() : mode === "state" ? await state() : await single(mode === "stdio" ? "stdio" : undefined);
writeFileSync(join(runDir, `e2e-${mode}.json`), JSON.stringify(res, null, 2));
const { console: consoleText, logSample, events, ...summary } = res;
console.log(JSON.stringify(summary, null, 2));
if (res.results?.some((r) => !r.pass)) process.exit(1);
