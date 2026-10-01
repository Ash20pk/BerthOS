#!/usr/bin/env node
// End-to-end checks for the microVM runtime: the pinned kernel, the
// content-addressed erofs rootfs, the Rust berth-init as PID 1 and a state
// disk, all booted through `berth-vmm run` the way the CLI will.
//
//   node e2e.mjs single    notes on a new state disk: calls over one relay
//                          connection and a second one, same pid, logs apart,
//                          FullyEnforced, the measurement line; shutdown over
//                          the control port, reboot on the same disk, the
//                          notes are still there
//   node e2e.mjs multi     notes + filesystem + probe: per-app cgroups and
//                          uids, context-bus-daemon confined, and an event
//                          published by filesystem delivered to probe through it
//   node e2e.mjs enforce   the probe app: an undeclared write on a writable
//                          path, outbound connect, io_uring, vsock, UDP
//   node e2e.mjs stdio     notes with BERTH_VM_RPC=stdio (one app process,
//                          host connections multiplexed onto its stdio)
//   node e2e.mjs exits     the VM powers off when its last app exits, and
//                          after a refused boot
//   node e2e.mjs bench     boot timing, interleaved rounds: single (tmpfs and
//                          state disk), multi, and the spike's layout as a control
//   node e2e.mjs all       single, multi, enforce, stdio, exits
//   node e2e.mjs egress    network:host: through the in-guest broker and the
//                          host dialer on vsock 1026 (real network: fetches
//                          example.com); the guest-root bypass, internal
//                          addresses behind declared names, an app with no
//                          network capability (docs/design/microvm-egress.md)
//
// The host side follows the rule in docs/design/microvm-guest-init.md: every
// line from the guest is bounded, parsed as a JSON object and checked for the
// shape that port carries before it is used.
//
// Env: BERTH_VMM_ARTIFACTS (default ../../../vm-runtime-artifacts), CPUS, MEM,
// ROUNDS (bench, default 6: the first round is a warm-up), SPIKE_ART (the
// spike's artifacts, for the bench control), VERBOSE=1.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vmmDir = join(here, "..");
const wt = join(vmmDir, "..", "..", "..");
const ART = process.env.BERTH_VMM_ARTIFACTS ?? join(wt, "vm-runtime-artifacts");
const SPIKE_ART = process.env.SPIKE_ART ?? join(wt, "libkrun-vm-artifacts");
const VMM = join(vmmDir, "target/release/berth-vmm");
const APPS = join(ART, "apps");
const RUN = join(ART, "run");
const VERBOSE = process.env.VERBOSE === "1";
mkdirSync(RUN, { recursive: true });
const MAX_LINE = 1 << 20;
const pinned = (file, key) => new RegExp(`^${key} = "([0-9a-f]{64})"`, "m").exec(readFileSync(join(vmmDir, file), "utf8"))[1];
const KERNEL_PIN = pinned("kernel/manifest.toml", "image_sha256");
// Default: the rootfs pinned in rootfs/manifest.toml, as berth-vmm run picks it.
const ROOTFS_PIN = pinned("rootfs/manifest.toml", "image_sha256");
const ROOTFS = process.env.ROOTFS;

const fail = (m) => {
  throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  sock.on("error", () => {});
  if (initial) feed(initial);
}

async function connectPath(path, deadlineMs = 20000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (existsSync(path)) {
      const s = await new Promise((resolve) => {
        const c = net.createConnection(path);
        c.once("connect", () => resolve(c));
        c.once("error", () => resolve(null));
      });
      if (s) return s;
    }
    if (Date.now() > end) fail(`could not connect to ${path}`);
    await sleep(5);
  }
}

/** libkrun accepts before the guest listens; control and logs greet first, so wait for that. */
async function connectGreeted(path, deadlineMs = 20000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const s = await connectPath(path, Math.max(1, end - Date.now()));
    const first = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2000);
      s.once("data", (d) => (clearTimeout(t), resolve(d.toString("utf8"))));
      s.once("close", () => (clearTimeout(t), resolve(null)));
    });
    if (first !== null) return { sock: s, first };
    s.destroy();
    if (Date.now() > end) fail(`${path}: no greeting from the guest`);
    await sleep(5);
  }
}

const isEvent = (v) => v.source === "berth-init" && typeof v.event === "string";
const isLog = (v) => typeof v.src === "string" && typeof v.stream === "string" && typeof v.line === "string" && typeof v.t === "number";
const isRpc = (v) => typeof v.id === "string";

class Rpc {
  constructor(sock) {
    this.sock = sock;
    this.pending = new Map();
    this.bad = [];
    this.next = 1;
    lines(sock, isRpc, (v) => {
      this.pending.get(v.id)?.(v);
      this.pending.delete(v.id);
    }, (l) => this.bad.push(l));
    sock.on("close", () => {
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
        if (v.error) reject(new Error(`${exp}: ${typeof v.error === "string" ? v.error : JSON.stringify(v.error)}`));
        else resolve(v.result);
      });
      this.sock.write(JSON.stringify({ id, export: exp, input }) + "\n");
    });
  }
}

async function rpcConnect(path, firstCall) {
  const end = Date.now() + 30000;
  for (;;) {
    const r = new Rpc(await connectPath(path));
    try {
      return { r, result: await firstCall(r) };
    } catch (e) {
      r.sock.destroy();
      if (Date.now() > end) throw e;
      await sleep(5);
    }
  }
}

/** Starts `berth-vmm run` and collects its own structured lines (endpoints, measurements). */
async function run(name, apps, { state, env = {}, mem, extra = [] } = {}) {
  const runDir = join(RUN, name);
  const args = [
    "run", "--artifacts", ART, ...(ROOTFS ? ["--rootfs", ROOTFS] : []), "--run-dir", runDir,
    "--cpus", process.env.CPUS ?? "2",
    ...(mem ?? process.env.MEM ? ["--mem", mem ?? process.env.MEM] : []),
    ...apps.flatMap((a) => ["--app", join(APPS, a)]),
    ...(state ? ["--state", state, "--state-size", "256"] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ...extra,
  ];
  const t0 = performance.now();
  const vm = spawn(VMM, args, { env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
  const vmm = {};
  const stderr = [];
  let got;
  const endpoints = new Promise((r) => (got = r));
  let buf = "";
  vm.stderr.setEncoding("utf8");
  vm.stderr.on("data", (d) => {
    stderr.push(d);
    if (VERBOSE) process.stderr.write(d);
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.startsWith('{"source":"berth-vmm"')) continue;
      const v = JSON.parse(l); // berth-vmm's own output, not the guest's
      vmm[v.event] = v;
      if (v.event === "endpoints") got(v);
    }
  });
  vm.stdout.resume();
  const exited = new Promise((r) => vm.on("exit", (code, sig) => r({ code, sig, atMs: performance.now() - t0 })));
  const ep = await Promise.race([endpoints, exited.then((x) => fail(`berth-vmm exited before booting: ${JSON.stringify(x)} ${stderr.join("")}`))]);
  return { vm, t0, exited, vmm, ep, stderr };
}

async function attach(b) {
  const events = [];
  const logs = [];
  const bad = { control: [], logs: [] };
  const waiters = [];
  const { sock: ctl, first } = await connectGreeted(b.ep.control);
  lines(ctl, isEvent, (v) => {
    events.push(v);
    for (const w of [...waiters]) if (w.match(v)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(v));
  }, (l) => bad.control.push(l), first);
  const { sock: lg, first: lf } = await connectGreeted(b.ep.logs);
  lines(lg, isLog, (v) => logs.push(v), (l) => bad.logs.push(l), lf);
  const waitEvent = (match, ms = 20000) => {
    const hit = events.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error(`timed out waiting for an event; have: ${events.map((e) => e.event).join(",")}`)), ms);
    });
  };
  const status = () => {
    ctl.write(JSON.stringify({ op: "status" }) + "\n");
    return waitEvent((v) => v.event === "status" && !v._seen && (v._seen = true));
  };
  return { ctl, events, logs, bad, waitEvent, status };
}

async function shutdown(b, s) {
  const t = performance.now();
  s.ctl.write(JSON.stringify({ op: "shutdown" }) + "\n");
  const ex = await Promise.race([b.exited, sleep(15000).then(() => (b.vm.kill("SIGKILL"), { code: null, sig: "SIGKILL(timeout)" }))]);
  return { ms: Math.round(performance.now() - t), exit: ex, powerOff: s.events.find((e) => e.event === "power_off") };
}

function check(results, cond, what) {
  results.push({ check: what, pass: !!cond });
  console.error(`${cond ? "ok  " : "FAIL"} ${what}`);
}

const hex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const rpcPath = (b, i) => b.ep.rpc[i].socket;

async function single() {
  const results = [];
  const img = join(RUN, "single-state.img");
  rmSync(img, { force: true });
  // Boot 1: a new disk.
  let b = await run("single", ["notes"], { state: img });
  let s = await attach(b);
  const { r, result: first } = await rpcConnect(rpcPath(b, 0), (r) => r.call("add_note", { text: "survives a reboot" }));
  const st0 = await s.status();
  const pid0 = st0.apps[0].pid;
  for (let i = 2; i <= 5; i++) await r.call("add_note", { text: `note ${i}` });
  const { r: r2 } = await rpcConnect(rpcPath(b, 0), (x) => x.call("list_notes"));
  const both = await Promise.all([r.call("add_note", { text: "from A" }), r2.call("add_note", { text: "from B" })]);
  const listed = await r.call("list_notes");
  const st1 = await s.status();
  await sleep(200);
  const off1 = await shutdown(b, s);
  const m1 = b.vmm.measurements;
  const boot1 = s.events.find((e) => e.event === "boot_start");
  check(results, typeof first?.id === "string", "boot 1: add_note answered over vsock 5000");
  check(results, listed.notes.length === 7 && both.every((x) => typeof x?.id === "string"), `two host connections, one app: ${listed.notes.length} notes`);
  check(results, pid0 && st1.apps[0].pid === pid0 && st1.apps[0].state === "ready", `same app pid across calls and connections (${pid0} -> ${st1.apps[0].pid})`);
  check(results, r.bad.length === 0 && r2.bad.length === 0, `RPC streams carried only RPC (stray lines: ${r.bad.length + r2.bad.length})`);
  check(results, s.logs.some((l) => l.src === "notes" && l.line.includes('"notes" ready')), "app stderr arrived on the log port (1025), not on RPC");
  check(results, s.logs.some((l) => l.src === "notes" && l.line.includes("ruleset=FullyEnforced")), "notes: Landlock ruleset=FullyEnforced");
  check(results, s.bad.logs.length === 0 && s.bad.control.length === 0, "control and log streams well-formed");
  check(results, boot1?.pid === 1, `berth-init is PID 1 (pid ${boot1?.pid}), no init.krun`);
  check(results, /nsdelegate/.test(boot1?.cgroup2) && /favordynmods/.test(boot1?.cgroup2), `cgroup2 mounted ${boot1?.cgroup2}`);
  check(results, s.logs.some((l) => l.line.includes("formatting ext4")), "boot 1 formats the blank state disk");
  check(results, m1?.kernel?.sha256 === KERNEL_PIN && m1.kernel.pinned, `measurements: kernel ${m1?.kernel?.sha256?.slice(0, 12)} (pinned)`);
  check(results, hex64(m1?.rootfs?.sha256) && (ROOTFS ? ROOTFS.includes(m1.rootfs.sha256) : m1.rootfs.pinned && m1.rootfs.sha256 === ROOTFS_PIN), `measurements: rootfs ${m1?.rootfs?.sha256?.slice(0, 12)} (pinned: ${m1?.rootfs?.pinned})`);
  check(results, hex64(m1?.state?.chunkedSha256) && m1.state.created, `measurements: state ${m1?.state?.chunkedSha256?.slice(0, 12)} (new disk, ${m1?.state?.hashMs} ms)`);
  check(results, off1.exit.code === 0 && off1.powerOff?.unmountFailed?.length === 0, `shutdown via control: exit ${off1.exit.code}, ${off1.ms} ms, unmountFailed ${JSON.stringify(off1.powerOff?.unmountFailed)}`);

  // Boot 2: the same disk.
  b = await run("single", ["notes"], { state: img });
  s = await attach(b);
  const { result: again } = await rpcConnect(rpcPath(b, 0), (x) => x.call("list_notes"));
  const off2 = await shutdown(b, s);
  const m2 = b.vmm.measurements;
  check(results, again.notes.some((n) => n.text === "survives a reboot") && again.notes.length === 7, `boot 2: list_notes keeps the notes (${again.notes.length})`);
  check(results, !s.logs.some((l) => l.line.includes("formatting ext4")) && m2.state.created === false, `boot 2 reuses the disk (restoredBytes ${m2.state.restoredBytes})`);
  check(results, hex64(m2.state.chunkedSha256) && m2.state.chunkedSha256 !== m1.state.chunkedSha256, `state digest changed with the writes (${m1.state.chunkedSha256.slice(0, 12)} -> ${m2.state.chunkedSha256.slice(0, 12)}, ${m2.state.hashedBytes} bytes read)`);
  check(results, off2.exit.code === 0, `boot 2 clean shutdown (${off2.ms} ms)`);
  return { results, measurements: [m1, m2], shutdownMs: [off1.ms, off2.ms], powerOff: off1.powerOff };
}

async function multi() {
  const results = [];
  const apps = ["notes", "filesystem", "probe"];
  const b = await run("multi", apps);
  const s = await attach(b);
  const { r: notes } = await rpcConnect(rpcPath(b, 0), (r) => r.call("add_note", { text: "multi" }));
  const { r: probe } = await rpcConnect(rpcPath(b, 2), (r) => r.call("received"));
  const { r: fs } = await rpcConnect(rpcPath(b, 1), (r) => r.call("write_file", { path: "hello.txt", content: "from the host" }));
  const read = await fs.call("read_file", { path: "hello.txt" });
  let got = [];
  for (let i = 0; i < 100 && got.length === 0; i++) {
    got = (await probe.call("received")).events;
    if (!got.length) await sleep(20);
  }
  const insp = await probe.call("inspect");
  const st = await s.status();
  await sleep(200);
  const off = await shutdown(b, s);
  const [n, f, p] = st.apps;
  check(results, read.content === "from the host", "filesystem write_file/read_file over vsock 5001");
  check(results, n.uid === 10000 && f.uid === 10001 && p.uid === 10002 && new Set([n.pid, f.pid, p.pid]).size === 3, `three apps, three uids (${n.uid}, ${f.uid}, ${p.uid}), three processes`);
  for (const a of st.apps) check(results, a.cgroup?.path === `/berth/apps/${a.name}` && a.cgroup.procs.includes(a.pid), `${a.name} in ${a.cgroup?.path}: ${JSON.stringify(a.cgroup?.limits)}`);
  check(results, f.cgroup?.limits["cpu.max"] === "100000 100000" && n.cgroup?.limits["cpu.max"] === "50000 100000" && p.cgroup?.limits["pids.max"] === "1024", "per-app limits from resources: (and the defaults for probe)");
  check(results, insp.cgroup === "0::/berth/apps/probe" && insp.uid === 10002, `inside probe: ${insp.cgroup}, uid ${insp.uid}, groups ${JSON.stringify(insp.groups)}`);
  check(results, ["berth-notes", "berth-filesystem", "berth-probe"].every((u) => insp.passwd.some((l) => l.startsWith(`${u}:x:`))), `identities written at boot: ${insp.passwd.join(" | ")}`);
  const bus = st.daemons.find((d) => d.name === "context-bus");
  check(results, bus && st.daemonsCgroup.procs.includes(bus.pid) && st.daemonsCgroup.procs.includes(1), "context-bus-daemon and berth-init in /berth/daemons");
  check(results, s.logs.some((l) => l.src === "context-bus" && l.line.includes("ruleset=FullyEnforced")) && s.logs.some((l) => l.src === "context-bus" && l.line.includes("as uid 9001")), "context-bus-daemon confined: uid 9001, FullyEnforced");
  check(results, apps.every((a) => s.logs.some((l) => l.src === a && l.line.includes("ruleset=FullyEnforced"))), "all three apps FullyEnforced");
  check(results, got.some((e) => e.topic === "fs.file_created" && e.payload?.path === "hello.txt"), `context bus: filesystem's fs.file_created reached probe through the daemon (${JSON.stringify(got)})`);
  check(results, ["notes", "filesystem", "probe"].every((a) => s.logs.some((l) => l.src === "context-bus" && l.line.includes(`registered as "${a}"`))), "the daemon registered each app by its berth-<app> peer identity");
  check(results, off.exit.code === 0, `clean shutdown (${off.ms} ms)`);
  check(results, notes.bad.length + fs.bad.length + probe.bad.length === 0, "RPC streams clean");
  return { results, status: st, inspect: insp };
}

async function enforce() {
  const results = [];
  const b = await run("enforce", ["probe"], { state: join(RUN, "enforce-state.img") });
  const s = await attach(b);
  const { r, result: ws } = await rpcConnect(rpcPath(b, 0), (x) => x.call("probe", { dir: "/workspace" }));
  const tmp = (await r.call("probe", { dir: "/tmp" })).checks;
  const shm = (await r.call("probe", { dir: "/dev/shm" })).checks;
  const insp = await r.call("inspect");
  const off = await shutdown(b, s);
  rmSync(join(RUN, "enforce-state.img"), { force: true });
  const c = ws.checks;
  check(results, c.uid === "ok:10000", `probe runs as the app uid (${c.uid})`);
  check(results, c.landlock_abi === "ok:6", `Landlock ABI ${c.landlock_abi}`);
  check(results, c.write_declared?.startsWith("ok"), `write to declared /workspace (state disk): ${c.write_declared}`);
  check(results, insp.owners["/tmp"] === "0:0 1777", `/tmp is writable by any uid (${insp.owners["/tmp"]}), so a refusal there is Landlock's`);
  check(results, tmp.write_declared === "EACCES", `undeclared write to /tmp/probe-ok: ${tmp.write_declared}`);
  check(results, shm.write_declared === "EACCES", `undeclared write to /dev/shm/probe-ok: ${shm.write_declared}`);
  check(results, ["EROFS", "EACCES"].includes(c.write_etc_x), `write /etc/x: ${c.write_etc_x}`);
  check(results, c["connect_1.1.1.1:443"] === "EACCES" || c["connect_1.1.1.1:443"] === "ENETUNREACH", `outbound connect: ${c["connect_1.1.1.1:443"]}`);
  check(results, c.io_uring_setup === "ENOSYS", `io_uring_setup: ${c.io_uring_setup}`);
  check(results, c.socket_af_vsock === "EPERM", `socket(AF_VSOCK): ${c.socket_af_vsock}`);
  check(results, c.socket_udp === "EPERM", `socket(UDP): ${c.socket_udp}`);
  check(results, off.exit.code === 0, `clean shutdown (${off.ms} ms)`);
  return { results, workspace: c, tmp, shm, inspect: insp };
}

async function stdio() {
  const results = [];
  const b = await run("stdio", ["notes"], { env: { BERTH_VM_RPC: "stdio" } });
  const s = await attach(b);
  const { r } = await rpcConnect(rpcPath(b, 0), (x) => x.call("add_note", { text: "a" }));
  const { r: r2 } = await rpcConnect(rpcPath(b, 0), (x) => x.call("add_note", { text: "b" }));
  const [l1, l2] = await Promise.all([r.call("list_notes"), r2.call("list_notes")]);
  const st = await s.status();
  const off = await shutdown(b, s);
  check(results, st.rpc === "stdio" && l1.notes.length === 2 && l2.notes.length === 2, `stdio relay: two connections, one app process (${st.apps[0].pid})`);
  check(results, r.bad.length + r2.bad.length === 0, "answers routed back to the right connection, nothing else on RPC");
  check(results, off.exit.code === 0, `clean shutdown (${off.ms} ms)`);
  return { results };
}

async function exits() {
  const results = [];
  // An app that throws at load: the runtime exits, and with it the last app.
  const broken = join(APPS, "broken");
  rmSync(broken, { recursive: true, force: true });
  mkdirSync(join(broken, "dist"), { recursive: true });
  for (const f of ["berth.yml", "runtime.mjs"]) writeFileSync(join(broken, f), readFileSync(join(APPS, "notes-plain", f)));
  writeFileSync(join(broken, "dist", "index.mjs"), 'throw new Error("this app fails at load");\n');
  let b = await run("exits", ["broken"]);
  let s = await attach(b);
  let ex = await b.exited;
  const off = s.events.find((e) => e.event === "power_off");
  check(results, off?.reason === "every app has exited" && off.exitCode === 1 && ex.code === 0, `powered off once no app was left (${off?.reason}, exitCode ${off?.exitCode}, ${Math.round(ex.atMs)} ms)`);
  check(results, s.logs.some((l) => l.line.includes("this app fails at load")), "the app's error is on the log port");
  rmSync(broken, { recursive: true, force: true });
  b = await run("exits", ["notes-plain"], { env: { BERTH_VM_RPC: "tcp" } });
  s = await attach(b);
  ex = await b.exited;
  const failed = s.events.find((e) => e.event === "boot_failed");
  check(results, failed && /BERTH_VM_RPC/.test(failed.reason) && s.events.find((e) => e.event === "power_off")?.exitCode === 1, `refused boot reported on control, then power off (${failed?.reason})`);
  return { results };
}

/** The spike's layout: virtio-fs root dir, init.krun + berth-init.sh + socat, same pinned kernel. */
async function spikeBoot() {
  const sock = join(RUN, "spike-5000.sock");
  rmSync(sock, { force: true });
  const args = [
    "--cpus", process.env.CPUS ?? "2", "--mem", "512",
    "--kernel", join(ART, "kernel/sha256", KERNEL_PIN, "Image"),
    "--root", join(SPIKE_ART, "rootfs-notes"), "--root-ro",
    "--share", `app:${join(SPIKE_ART, "app-notes")}:ro`,
    "--vsock", `5000:${sock}:listen`, "--env", "BERTH_VM_MODE=rpc",
    "--", "/sbin/berth-init",
  ];
  const t0 = performance.now();
  const vm = spawn(VMM, args, { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore"] });
  const exited = new Promise((r) => vm.on("exit", r));
  await rpcConnect(sock, (r) => r.call("add_note", { text: "bench" }));
  const ms = Math.round(performance.now() - t0);
  vm.kill("SIGKILL");
  await exited;
  return ms;
}

async function imageBoot(apps, state) {
  const b = await run(`bench-${apps.length}`, apps, { state });
  const s = await attach(b);
  await Promise.all(apps.map((a, i) => rpcConnect(rpcPath(b, i), (r) => (a.startsWith("notes") ? r.call("add_note", { text: "bench" }) : r.call("list_files")))));
  const ms = Math.round(performance.now() - b.t0);
  const marks = Object.fromEntries(s.events.filter((e) => ["boot_start", "boot_phase", "app_ready"].includes(e.event)).map((e) => [e.phase ?? (e.event === "app_ready" ? `ready:${e.app}` : e.event), e.uptimeMs]));
  const off = await shutdown(b, s);
  return { ms, marks, shutdownMs: off.ms, hashMs: { kernel: b.vmm.measurements.kernel.hashMs, rootfs: b.vmm.measurements.rootfs.hashMs, state: b.vmm.measurements.state?.hashMs } };
}

async function bench() {
  const rounds = Number(process.env.ROUNDS ?? 6);
  const configs = {
    single: () => imageBoot(["notes-plain"]),
    "single+state": () => imageBoot(["notes-plain"], join(RUN, "bench-state.img")),
    multi: () => imageBoot(["notes-plain", "filesystem"]),
    spike: () => spikeBoot().then((ms) => ({ ms })),
  };
  if (!existsSync(join(SPIKE_ART, "rootfs-notes"))) delete configs.spike;
  const out = Object.fromEntries(Object.keys(configs).map((k) => [k, []]));
  const loads = [];
  for (let i = 0; i < rounds; i++) {
    loads.push(os.loadavg()[0]);
    for (const [k, f] of Object.entries(configs)) {
      const r = await f();
      out[k].push(r);
      console.error(JSON.stringify({ round: i, config: k, ...r }));
    }
  }
  rmSync(join(RUN, "bench-state.img"), { force: true });
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const summary = Object.fromEntries(
    Object.entries(out).map(([k, rs]) => {
      const repeats = rs.slice(1).map((r) => r.ms);
      return [k, { first: rs[0].ms, repeats, median: med(repeats) }];
    }),
  );
  return { summary, loadAvg1m: loads, cpus: os.cpus().length, runs: out };
}

/**
 * What the CLI hands berth-vmm: the network:host: and browser:navigate:
 * scopes of the sandbox's manifests, read on the host (never from the guest).
 */
function egressAllow(apps) {
  const scopes = [];
  for (const a of apps) {
    for (const m of readFileSync(join(APPS, a, "berth.yml"), "utf8").matchAll(/^\s*-\s*["']?(?:network:host|browser:navigate):([^\s"'#]+)/gm)) scopes.push(m[1]);
  }
  return scopes.join(",");
}

/** An app directory like http-fetch's, declaring these capabilities instead. */
function fetchAppWith(name, caps) {
  const dir = join(APPS, name);
  rmSync(dir, { recursive: true, force: true });
  execFileSync("cp", ["-R", join(APPS, "http-fetch"), dir]);
  const yml = readFileSync(join(APPS, "http-fetch", "berth.yml"), "utf8").replace(/^capabilities:[\s\S]*?^exports:/m, `capabilities:\n${caps.map((c) => `  - ${c}`).join("\n")}\n\nexports:`);
  writeFileSync(join(dir, "berth.yml"), yml.replace(/^name: http-fetch$/m, `name: ${name}`));
  return name;
}

async function egress() {
  const results = [];
  const egressLines = (b) => b.stderr.join("").split("\n").filter((l) => l.startsWith('{"source":"berth-vmm","event":"egress')).map((l) => JSON.parse(l));
  const raw = async (s, request, send) => {
    s.ctl.write(JSON.stringify({ op: "egress_raw", request, ...(send ? { send } : {}) }) + "\n");
    return s.waitEvent((v) => v.event === "egress_raw" && v.request === request && !v._seen && (v._seen = true), 40000);
  };
  const fetchText = (r, url) => r.call("fetch_text", { url }, 40000).then((x) => ({ ok: true, text: x.text }), (e) => ({ ok: false, error: e.message }));
  // The first call on a new connection: a close before the answer means the
  // app was not serving yet (libkrun accepts first), so rpcConnect retries.
  const fetchFirst = (url) => async (r) => {
    const res = await fetchText(r, url);
    if (!res.ok && /connection closed/.test(res.error)) throw new Error(res.error);
    return res;
  };

  // Boot 1: http-fetch (network:host:example.com, network:connect:8090) and
  // probe (no network capability), the allowlist from their manifests.
  const apps = ["http-fetch", "probe"];
  const allow = egressAllow(apps);
  let b = await run("egress", apps, { env: { BERTH_VM_TEST_HOOKS: "1" }, extra: ["--egress-allow", allow] });
  let s = await attach(b);
  const { r: hf, result: https } = await rpcConnect(rpcPath(b, 0), fetchFirst("https://example.com/"));
  const http = await fetchText(hf, "http://example.com/");
  const undeclared = await fetchText(hf, "https://www.google.com/");
  const { r: probe, result: pnet } = await rpcConnect(rpcPath(b, 1), (r) => r.call("net"));
  const pchecks = (await probe.call("probe", { dir: "/workspace" })).checks;
  const bypassUndeclared = await raw(s, "DIAL www.google.com 443");
  const bypassMetadata = await raw(s, "DIAL 169.254.169.254 80");
  const bypassPort = await raw(s, "DIAL example.com 22");
  const bypassGarbage = await raw(s, "GET http://example.com/ HTTP/1.1");
  const bypassShorthand = await raw(s, "DIAL 127.1 443");
  const bypassDeclared = await raw(s, "DIAL example.com 80", "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
  const st = await s.status();
  await sleep(200);
  const off = await shutdown(b, s);
  const host = egressLines(b);
  const started = s.events.find((e) => e.event === "daemon_started" && e.daemon === "egress-broker");
  const vsock1026 = b.vmm.vm_config?.vsock?.find((v) => v.port === 1026);
  check(results, b.ep.egress?.port === 1026 && b.ep.egress.allow.join(",") === "example.com" && vsock1026 && vsock1026.listen === false, `endpoints: egress on vsock 1026 (guest connects out) -> ${b.ep.egress?.socket?.split("/").pop()}, allow ${JSON.stringify(b.ep.egress?.allow)} (from the manifests: ${allow})`);
  check(results, started?.listening && started.uid === 9002 && started.port === 8090, `egress broker started for http-fetch: uid ${started?.uid}, 127.0.0.1:${started?.port}, ${started?.waitMs} ms`);
  check(results, s.logs.some((l) => l.src === "egress-broker" && l.line.includes("ruleset=FullyEnforced")), "egress broker confined by agent-init: FullyEnforced");
  check(results, st.daemons.some((d) => d.name === "egress-broker") && st.daemonsCgroup.procs.includes(started?.pid), "egress broker in /berth/daemons");
  check(results, https.ok && /Example Domain/.test(https.text), `https://example.com through broker + host dialer: ${https.ok ? `${https.text.length} bytes, "Example Domain"` : https.error}`);
  check(results, http.ok && /Example Domain/.test(http.text), `http://example.com (plain-http forward) through the host dialer: ${http.ok ? "ok" : http.error}`);
  check(results, host.some((e) => e.event === "egress" && e.decision === "allowed" && e.host === "example.com" && e.port === 443) && host.some((e) => e.event === "egress_closed" && e.host === "example.com" && e.bytesDown > 0), `host dialer logged example.com:443 allowed (${host.find((e) => e.decision === "allowed")?.address}) and the tunnel's bytes`);
  check(results, !undeclared.ok && s.logs.some((l) => l.src === "egress-broker" && l.line.includes('"navigate_denied","host":"www.google.com"')) && !host.some((e) => e.host === "www.google.com" && e.id && e.decision === "allowed"), `undeclared www.google.com refused by the guest broker (${undeclared.error?.slice(0, 80)})`);
  check(results, bypassUndeclared.reply?.startsWith("ERR denied not in this sandbox's egress allowlist"), `guest root on vsock 1026, bypassing the broker: DIAL www.google.com 443 -> ${bypassUndeclared.reply}`);
  check(results, bypassMetadata.reply?.startsWith("ERR denied"), `guest root: DIAL 169.254.169.254 80 -> ${bypassMetadata.reply}`);
  check(results, bypassPort.reply?.startsWith("ERR denied"), `guest root: DIAL example.com 22 (undeclared port) -> ${bypassPort.reply}`);
  check(results, bypassGarbage.reply?.startsWith("ERR bad_request") && bypassShorthand.reply?.startsWith("ERR bad_request"), `guest root: malformed frames refused (${bypassGarbage.reply}; ${bypassShorthand.reply})`);
  check(results, bypassDeclared.reply?.startsWith("OK ") && /^HTTP\/1\.1 \d{3}/.test(bypassDeclared.data ?? ""), `guest root gets only what the host allows: DIAL example.com 80 -> ${bypassDeclared.reply}, ${JSON.stringify((bypassDeclared.data ?? "").split("\r\n")[0])}`);
  check(results, host.filter((e) => e.event === "egress" && e.decision === "denied").length >= 5, `every refusal is on the host log (${host.filter((e) => e.decision === "denied").map((e) => `${e.host || "-"}:${e.port} ${e.code}`).join(", ")})`);
  check(results, pnet.broker === "EACCES" && pnet.outbound === "EACCES" && pnet.dialSocket === "EACCES", `probe (no network capability): broker port ${pnet.broker}, dial socket ${pnet.dialSocket}, 1.1.1.1:443 ${pnet.outbound}`);
  check(results, pchecks.socket_af_vsock === "EPERM" && pchecks.socket_udp === "EPERM", `probe: socket(AF_VSOCK) ${pchecks.socket_af_vsock}, UDP ${pchecks.socket_udp}`);
  check(results, st.apps.every((a) => a.state === "ready") && s.bad.control.length + s.bad.logs.length === 0 && hf.bad.length + probe.bad.length === 0, "port plan: control (status), logs and rpc 5000/5001 alongside 1026, streams well-formed");
  check(results, off.exit.code === 0 && off.powerOff?.unmountFailed?.length === 0, `clean shutdown (${off.ms} ms), relay closed before the unmounts (unmountFailed ${JSON.stringify(off.powerOff?.unmountFailed)})`);

  // Boot 2: declared names that resolve to internal addresses. The guest
  // broker allows them (they are declared), the host refuses them after its
  // own resolution. 10.0.0.1.nip.io and 169.254.169.254.nip.io are public
  // wildcard DNS (they answer the address in the name).
  const tricked = fetchAppWith("egress-tricked", [
    "network:host:localhost:*", "network:host:10.0.0.1.nip.io", "network:host:169.254.169.254.nip.io", "network:host:127.0.0.1:*", "network:connect:8090",
  ]);
  b = await run("egress-tricked", [tricked], { env: { BERTH_VM_TEST_HOOKS: "1" }, extra: ["--egress-allow", egressAllow([tricked])] });
  s = await attach(b);
  const { r: tr, result: viaLocalhost } = await rpcConnect(rpcPath(b, 0), fetchFirst("http://localhost:8090/"));
  const viaNip = await fetchText(tr, "https://10.0.0.1.nip.io/");
  const viaNipMeta = await fetchText(tr, "http://169.254.169.254.nip.io/latest/meta-data/");
  const viaLiteral = await fetchText(tr, "http://127.0.0.1:8090/");
  const rawLocal = await raw(s, "DIAL localhost 1024");
  const rawLiteral = await raw(s, "DIAL 127.0.0.1 22");
  const rawNip = await raw(s, "DIAL 169.254.169.254.nip.io 80");
  const off2 = await shutdown(b, s);
  const host2 = egressLines(b);
  // A plain-http request the broker refuses is still an HTTP answer (403/502
  // with the reason as its body), so fetch() resolves with it.
  const refused = (x) => !x.ok || /^egress (denied|failed)/.test(x.text);
  const refusedAfterResolve = (h) => host2.find((e) => e.host === h && e.decision === "denied" && /^resolves to /.test(e.reason ?? ""));
  check(results, refused(viaLocalhost) && refusedAfterResolve("localhost"), `declared localhost: the host resolved it and refused (${refusedAfterResolve("localhost")?.reason})`);
  check(results, refused(viaNip) && (refusedAfterResolve("10.0.0.1.nip.io") || host2.some((e) => e.host === "10.0.0.1.nip.io" && e.code === "unresolved")), `declared 10.0.0.1.nip.io: ${refusedAfterResolve("10.0.0.1.nip.io")?.reason ?? host2.find((e) => e.host === "10.0.0.1.nip.io")?.reason}`);
  check(results, refused(viaNipMeta) && !host2.some((e) => e.host === "169.254.169.254.nip.io" && e.decision === "allowed"), `declared 169.254.169.254.nip.io (metadata by DNS): ${refusedAfterResolve("169.254.169.254.nip.io")?.reason ?? host2.find((e) => e.host === "169.254.169.254.nip.io")?.reason}`);
  check(results, refused(viaLiteral) && s.logs.some((l) => l.src === "egress-broker" && l.line.includes('"blocked_address","host":"127.0.0.1"')), "declared 127.0.0.1:*: the guest broker refuses the literal itself");
  check(results, rawLocal.reply?.startsWith("ERR denied resolves to") && rawLiteral.reply?.startsWith("ERR denied resolves to 127.0.0.1") && rawNip.reply?.startsWith("ERR denied resolves to 169.254.169.254"), `guest root, same names: ${rawLocal.reply} | ${rawLiteral.reply} | ${rawNip.reply}`);
  check(results, !host2.some((e) => e.decision === "allowed"), `nothing was dialled (${host2.filter((e) => e.event === "egress").length} requests, 0 allowed)`);
  check(results, off2.exit.code === 0, `clean shutdown (${off2.ms} ms)`);
  rmSync(join(APPS, tricked), { recursive: true, force: true });

  // Boot 3: an app declares network:host:, but the host was given no
  // allowlist: vsock 1026 is not mapped and there is no way out.
  b = await run("egress-none", ["http-fetch"]);
  s = await attach(b);
  const { result: none } = await rpcConnect(rpcPath(b, 0), fetchFirst("https://example.com/"));
  const off3 = await shutdown(b, s);
  check(results, b.ep.egress === null && !b.vmm.vm_config.vsock.some((v) => v.port === 1026), "no --egress-allow: no dialer, vsock 1026 not mapped");
  check(results, !none.ok && s.logs.some((l) => l.src === "egress-broker" && l.line.includes('"host_dialer_refused","host":"example.com"')), `and https://example.com fails in the guest (${none.error?.slice(0, 80)})`);
  check(results, off3.exit.code === 0, `clean shutdown (${off3.ms} ms)`);
  return { results, host: { boot1: host, boot2: host2 }, tricked: { viaLocalhost, viaNip, viaNipMeta, viaLiteral }, probeNet: pnet, raw: { bypassUndeclared, bypassMetadata, bypassPort, bypassGarbage, bypassShorthand, bypassDeclared: { reply: bypassDeclared.reply, firstLine: (bypassDeclared.data ?? "").split("\r\n")[0] }, rawLocal, rawLiteral, rawNip } };
}

const mode = process.argv[2] ?? "all";
const modes = { single, multi, enforce, stdio, exits, bench, egress };
const todo = mode === "all" ? ["single", "multi", "enforce", "stdio", "exits"] : [mode];
let failed = false;
const report = {};
for (const m of todo) {
  if (!modes[m]) fail(`unknown mode ${m}`);
  console.error(`== ${m} (load ${os.loadavg().map((x) => x.toFixed(1)).join(" ")})`);
  const res = await modes[m]();
  report[m] = res;
  writeFileSync(join(RUN, `e2e-${m}.json`), JSON.stringify(res, null, 2));
  if (res.results?.some((r) => !r.pass)) failed = true;
  if (res.results) console.error(`== ${m}: ${res.results.filter((r) => r.pass).length}/${res.results.length}`);
  else console.log(JSON.stringify(res.summary, null, 2));
}
process.exit(failed ? 1 : 0);
