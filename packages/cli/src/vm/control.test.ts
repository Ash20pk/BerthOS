import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { openControl, waitForReady } from "./control.js";

function server(script: (s: net.Socket, n: number) => void) {
  const path = join(mkdtempSync("/tmp/bctl-"), "control.sock");
  let n = 0;
  const srv = net.createServer((s) => script(s, n++)).listen(path);
  return { path, close: () => srv.close() };
}
const line = (o: object) => `${JSON.stringify(o)}\n`;

test("a connection that never greets is retried; events of another boot are dropped", async () => {
  const srv = server((s, n) => {
    if (n === 0) return s.destroy(); // libkrun: accepted, then the guest wasn't listening
    s.write(line({ source: "berth-init", event: "hello", bootId: "b1", protocol: 1 }));
    s.write(line({ source: "berth-init", event: "app_started", bootId: "OTHER", app: "x" }));
    s.write(line({ source: "not-init", event: "app_ready", bootId: "b1", app: "x" }));
    s.write("garbage\n");
    s.write(line({ source: "berth-init", event: "app_ready", bootId: "b1", app: "x" }));
  });
  try {
    const c = await openControl(srv.path, { timeoutMs: 5_000 });
    assert.equal(c.bootId, "b1");
    const ready = await waitForReady(c, 1, 2_000);
    assert.deepEqual(ready.apps, ["x"]);
    assert.deepEqual(c.events.map((e) => e.event), ["app_ready"]);
    c.close();
  } finally {
    srv.close();
  }
});

test("boot_failed ends the wait with berth-init's reason", async () => {
  const srv = server((s) => {
    s.write(line({ source: "berth-init", event: "hello", bootId: "b2", protocol: 1 }));
    setTimeout(() => s.write(line({ source: "berth-init", event: "boot_failed", bootId: "b2", reason: "no app's capability policy compiled" })), 20);
  });
  try {
    const c = await openControl(srv.path, { timeoutMs: 5_000 });
    await assert.rejects(waitForReady(c, 1, 2_000), /failed to boot: no app's capability policy compiled/);
    c.close();
  } finally {
    srv.close();
  }
});

test("no greeting at all within the deadline is an error, not a hang", async () => {
  const srv = server(() => {});
  try {
    await assert.rejects(openControl(srv.path, { timeoutMs: 300 }), /no greeting from berth-init/);
  } finally {
    srv.close();
  }
});
