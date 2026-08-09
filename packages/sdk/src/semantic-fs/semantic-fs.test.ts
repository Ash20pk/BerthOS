import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUnavailableSemanticFs } from "./unavailable.js";
import { createUnixSocketSemanticFs } from "./unix-socket.js";

// REMEDIATION.md 1.14's third part: killing semantic-fs used to be worse than
// a crash, because the runtime fell back to a stub that returned empty query
// results. Retrieval, checkpoints, sessions and traces all read through here,
// so a dead daemon reported success while losing data.

test("the unavailable client throws on query rather than returning an empty result set", async () => {
  const fs = createUnavailableSemanticFs("/tmp/berth-semantic-fs.sock", "ECONNREFUSED");
  await assert.rejects(() => fs.query("anything"), /cannot query "anything"/);
  // The message has to name the daemon, or this is just as opaque as an empty
  // array was — it is read by whoever is looking at why retrieval went quiet.
  await assert.rejects(() => fs.query("anything"), /semantic-fs daemon is not reachable/);
});

test("the unavailable client throws on tag, because a tag that stored nothing is a lost write", async () => {
  const fs = createUnavailableSemanticFs("/tmp/berth-semantic-fs.sock", "ECONNREFUSED");
  await assert.rejects(() => fs.tag("notes/a.md", { task: "x" }), /cannot tag "notes\/a\.md"/);
});

// register() is the deliberate exception: it runs at boot, and taking the app
// down because attribution is unavailable would be worse than running with
// /context writes unattributed. It must still say so loudly.
test("the unavailable client warns but does not throw on register", async () => {
  const fs = createUnavailableSemanticFs("/tmp/berth-semantic-fs.sock", "ECONNREFUSED");
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fs.register({ app: "notes" });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /WARNING/);
  assert.match(lines[0]!, /"notes" will not be attributed/);
});

// The other half of the same failure: a daemon that dies *after* the client
// connected. This used to write to a destroyed socket, whose "error" event
// nothing listened for — an uncaught exception that takes the app down — and
// before that, hang every call for the full 5s call timeout.
test("a client whose daemon dies mid-life rejects promptly and does not crash the process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-semantic-fs-test-"));
  const socketPath = join(dir, "control.sock");
  const accepted: net.Socket[] = [];
  // Accepts and says nothing: this test is about the socket going away, not
  // about the protocol.
  const server = net.createServer((socket) => void accepted.push(socket));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    const fs = await createUnixSocketSemanticFs(socketPath);

    // The daemon dies. Connections are destroyed *before* close() rather than
    // after: close() waits for existing connections to end, and this client
    // holds one, so the other order never resolves.
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // register(), not query(): query() computes an embedding first, which
    // loads a WASM ONNX model — this test is about the socket, and pulling a
    // model load into it would make a fast assertion slow and flaky.
    const started = Date.now();
    await assert.rejects(() => fs.register({ app: "notes" }), /control socket (closed|failed)/);
    assert.ok(
      Date.now() - started < 2000,
      "a call after the daemon died must reject on the closed socket, not sit until the 5s call timeout",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
