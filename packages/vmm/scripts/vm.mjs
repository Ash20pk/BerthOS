#!/usr/bin/env node
// A small host-side client for a sandbox started with `berth-vmm run`, for
// humans; the CLI's local-vm adapter will do the same over the same sockets.
//
//   node vm.mjs status <run-dir>                    berth-init's status (apps, pids, cgroups)
//   node vm.mjs call   <run-dir> <app> <export> [json-input]
//                                                   one RPC; <app> is the index or tag
//   node vm.mjs logs   <run-dir>                    follow the log stream (Ctrl-C to stop)
//   node vm.mjs stop   <run-dir>                    {"op":"shutdown"}: stop apps, sync, power off
//
// Socket layout (berth-vmm run): control.sock (vsock 1024), logs.sock (1025),
// rpc-<i>.sock (5000+i). Lines from the guest are untrusted: bounded, parsed
// as JSON objects, shape-checked, and only printed.
import net from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

const MAX_LINE = 1 << 20;
const [cmd, runDir, ...rest] = process.argv.slice(2);
if (!cmd || !runDir) {
  console.error("usage: vm.mjs status|call|logs|stop <run-dir> [...]");
  process.exit(2);
}

function connect(path, deadlineMs = 20000) {
  const end = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!existsSync(path)) return retry();
      const c = net.createConnection(path);
      c.once("connect", () => resolve(c));
      c.once("error", retry);
    };
    const retry = () => (Date.now() > end ? reject(new Error(`cannot connect to ${path}`)) : setTimeout(attempt, 20));
    attempt();
  });
}

/** Calls onObject for each JSON-object line; returns a stop function. */
function readLines(sock, onObject) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    if (buf.length > MAX_LINE && !buf.includes("\n")) return sock.destroy(new Error("line too long"));
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const v = JSON.parse(line);
        if (v && typeof v === "object" && !Array.isArray(v)) onObject(v);
      } catch {}
    }
  });
}

/** Control: wait for the greeting, then send one op and take the first matching event. */
async function control(op, want) {
  for (let tries = 0; tries < 100; tries++) {
    const s = await connect(join(runDir, "control.sock"));
    const got = await new Promise((resolve) => {
      let greeted = false;
      const t = setTimeout(() => resolve(greeted ? "timeout" : null), greeted ? 10000 : 2000);
      readLines(s, (v) => {
        if (v.source !== "berth-init" || typeof v.event !== "string") return;
        if (!greeted && v.event === "hello") {
          greeted = true;
          s.write(JSON.stringify({ op }) + "\n");
        } else if (greeted && want.includes(v.event)) {
          clearTimeout(t);
          resolve(v);
        }
      });
      s.once("close", () => (clearTimeout(t), resolve(greeted ? "closed" : null)));
    });
    s.destroy();
    if (got !== null) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no greeting on control.sock");
}

async function call(app, exp, input) {
  const index = /^\d+$/.test(app) ? Number(app) : (await control("status", ["status"])).apps.find((a) => a.tag === app || a.name === app)?.index;
  if (index === undefined) throw new Error(`no app ${app}`);
  for (let tries = 0; tries < 100; tries++) {
    const s = await connect(join(runDir, `rpc-${index}.sock`));
    const res = await new Promise((resolve) => {
      readLines(s, (v) => v.id === "1" && resolve(v));
      s.once("close", () => resolve(null));
      s.write(JSON.stringify({ id: "1", export: exp, input }) + "\n");
    });
    s.destroy();
    // A close before the answer: the guest was not listening yet.
    if (res) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no answer");
}

if (cmd === "status") {
  console.log(JSON.stringify(await control("status", ["status"]), null, 2));
} else if (cmd === "stop") {
  const v = await control("shutdown", ["power_off"]);
  console.log(JSON.stringify(v));
} else if (cmd === "call") {
  const [app, exp, json] = rest;
  const res = await call(app, exp, json === undefined ? undefined : JSON.parse(json));
  console.log(JSON.stringify(res.error !== undefined ? { error: res.error } : res.result ?? null, null, 2));
  if (res.error !== undefined) process.exitCode = 1;
} else if (cmd === "logs") {
  const s = await connect(join(runDir, "logs.sock"));
  readLines(s, (v) => {
    if (typeof v.src === "string" && typeof v.line === "string") console.log(`${String(v.t).padStart(7)} [${v.src}/${v.stream}] ${v.line}`);
  });
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
