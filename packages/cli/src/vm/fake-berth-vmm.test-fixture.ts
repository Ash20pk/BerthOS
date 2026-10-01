/**
 * A stand-in for `berth-vmm run` in the sandbox tests: no VM, just the host
 * side of berth-init's port plan on the run dir's Unix sockets. FAKE_VMM sets
 * how it misbehaves:
 *
 *   ok          greets, reports every app ready, serves RPC (echo) and logs,
 *               powers off on {"op":"shutdown"}
 *   silent      as ok, but the first connection to each socket is closed
 *               without a byte (libkrun accepting before the guest listens)
 *   refuse      prints a berth-vmm refusal and exits 2 before any line
 *   wedged      as ok, but ignores shutdown (needs SIGKILL)
 *   app-exits   the app exits before it is ready
 */
import net from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_VMM ?? "ok";
const args = process.argv.slice(2);
const runDir = args[args.indexOf("--run-dir") + 1]!;
const apps = args.filter((_, i) => args[i - 1] === "--app");
const bootId = `fake-${process.pid}`;
const out = (o: object) => process.stderr.write(`${JSON.stringify(o)}\n`);

if (mode === "refuse") {
  process.stderr.write("berth-vmm: kernel /x has sha256 0000, but this berth-vmm is pinned to 8f79; refusing to boot it\n");
  process.exit(2);
}

out({ source: "berth-vmm", event: "endpoints", runDir, control: join(runDir, "control.sock"), logs: join(runDir, "logs.sock"), rpc: apps.map((a, i) => ({ index: i, app: a, socket: join(runDir, `rpc-${i}.sock`) })) });
out({ source: "berth-vmm", event: "vm_config", pid: process.pid, cpus: 2, memMiB: 512, tsi: false, nics: 0 });
out({
  source: "berth-vmm",
  event: "measurements",
  kernel: { sha256: "8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8", pinned: true, linux: "6.12.109" },
  rootfs: { sha256: "57e7ef8b56a30280beeb2f96eb77c35b0e2fcd0c585e9259e2899d47e565bf0d", pinned: true, fstype: "erofs", readOnly: true },
  state: null,
});

const ev = (event: string, fields: object = {}) => ({ source: "berth-init", event, bootId, uptimeMs: Date.now() % 100000, ...fields });
const events: object[] = [];
const ctlReaders = new Set<net.Socket>();
const emit = (e: object) => {
  events.push(e);
  for (const s of ctlReaders) s.write(`${JSON.stringify(e)}\n`);
};
const logs: object[] = [];
let logReader: net.Socket | undefined;
const log = (src: string, line: string) => {
  const l = { t: logs.length, src, stream: "stderr", line };
  logs.push(l);
  logReader?.write(`${JSON.stringify(l)}\n`);
};

const firstClosed = new Set<string>();
function listen(name: string, onConn: (s: net.Socket) => void) {
  const path = join(runDir, name);
  rmSync(path, { force: true });
  net
    .createServer((s) => {
      s.on("error", () => {});
      if (mode === "silent" && !firstClosed.has(name)) {
        firstClosed.add(name);
        s.destroy();
        return;
      }
      onConn(s);
    })
    .listen(path);
}

function powerOff(code = 0) {
  emit(ev("shutting_down", { reason: "host request" }));
  emit(ev("power_off", { reason: "host request", exitCode: code, unmountFailed: [], shutdownMs: 3 }));
  setTimeout(() => process.exit(code), 20);
}

listen("control.sock", (s) => {
  s.write(`${JSON.stringify(ev("hello", { protocol: 1 }))}\n${events.map((e) => JSON.stringify(e)).join("\n")}${events.length ? "\n" : ""}`);
  ctlReaders.add(s);
  s.on("close", () => ctlReaders.delete(s));
  let buf = "";
  s.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const op = (JSON.parse(line) as { op?: string }).op;
      if (op === "status") s.write(`${JSON.stringify(ev("status", { apps: apps.map((a, index) => ({ index, name: `app${index}`, state: "ready" })) }))}\n`);
      if (op === "shutdown" && mode !== "wedged") powerOff();
    }
  });
});
listen("logs.sock", (s) => {
  logReader?.destroy();
  logReader = s;
  for (const l of logs) s.write(`${JSON.stringify(l)}\n`);
});
apps.forEach((_, i) =>
  listen(`rpc-${i}.sock`, (s) => {
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      let j: number;
      while ((j = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, j)) as { id: string; export: string; input?: unknown };
        buf = buf.slice(j + 1);
        if (req.export === "die") s.destroy();
        else s.write(`${JSON.stringify({ id: req.id, result: { app: i, echo: req.input } })}\n`);
      }
    });
  }),
);

emit(ev("boot_start", { lsm: "capability,landlock,yama", pid: 1 }));
setTimeout(() => {
  apps.forEach((_, i) => {
    const name = `app${i}`;
    emit(ev("app_started", { app: name, pid: 200 + i }));
    log(name, JSON.stringify({ source: "agent-init", event: "capability_policy_applied", bootId, app: name, ruleset: "FullyEnforced" }));
    if (mode === "app-exits") emit(ev("app_exited", { app: name, pid: 200 + i, exit: { code: 1 } }));
    else emit(ev("app_ready", { app: name, pid: 200 + i }));
  });
  emit(ev("boot_complete", {}));
  // The egress dialer's log line (feat/vm-egress), as berth-vmm prints it after boot.
  out({ source: "berth-vmm", event: "egress", id: 1, decision: "denied", host: "example.net", port: 443, reason: "not in --egress-allow" });
}, 30);

process.on("SIGTERM", () => process.exit(143));
