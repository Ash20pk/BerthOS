import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex, type PassThrough } from "node:stream";
import type Docker from "dockerode";
import { createLineRpcClient, createStdioRpcClient, RpcNotSentError } from "./stdio-rpc.js";

// No Docker here: the attach stream and demux are the only two things the
// client touches, so both are stood in for. `answer` plays the app's side.
function fakeContainer({ stuck = false }: { stuck?: boolean } = {}) {
  const written: string[] = [];
  let stdout: PassThrough | undefined;
  const stream = new Duplex({
    // A stuck stream never finishes a write, so the next one is refused.
    ...(stuck ? { writableHighWaterMark: 1 } : {}),
    read() {},
    write(chunk, _encoding, done) {
      written.push(chunk.toString());
      if (!stuck) done();
    },
  });
  const container = { attach: async () => stream } as unknown as Docker.Container;
  const docker = {
    modem: {
      demuxStream: (_stream: unknown, out: PassThrough) => {
        stdout = out;
      },
    },
  } as unknown as Docker;
  return {
    container,
    docker,
    written,
    answer: (line: object) => stdout!.write(`${JSON.stringify(line)}\n`),
  };
}

test("a response resolves the call it answers", async () => {
  const fake = fakeContainer();
  const rpc = await createStdioRpcClient(fake.container, fake.docker);
  const call = rpc.call({ id: "1", export: "echo", input: {} });
  await new Promise((resolve) => setImmediate(resolve));
  fake.answer({ id: "1", result: "ok" });
  assert.deepEqual(await call, { id: "1", result: "ok" });
});

test("the wait is the caller's timeoutMs, not a fixed 30s", async () => {
  const fake = fakeContainer();
  const rpc = await createStdioRpcClient(fake.container, fake.docker);
  const startedAt = Date.now();
  await assert.rejects(rpc.call({ id: "1", export: "slow" }, { timeoutMs: 50 }), /timed out after 0s/);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("an aborted signal stops the wait, and one aborted before the call means nothing is sent", async () => {
  const fake = fakeContainer();
  const rpc = await createStdioRpcClient(fake.container, fake.docker);

  const controller = new AbortController();
  const call = rpc.call({ id: "1", export: "slow" }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.written.at(-1), `${JSON.stringify({ id: "1", export: "slow" })}\n`);
  controller.abort();
  await assert.rejects(call, /gave up waiting/);

  const before = fake.written.length;
  await assert.rejects(rpc.call({ id: "2", export: "slow" }, { signal: AbortSignal.abort() }), (err: unknown) => err instanceof RpcNotSentError && /not sent/.test(err.message));
  assert.equal(fake.written.length, before);
});

// These messages end up in berth mcp's audit `reason`, which is written even
// with payload capture off: the request's input must not be in them.
test("a failed call's error names the export and request id, never the input", async () => {
  const secret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG";
  const input = { path: "/workspace/.env", content: secret };

  const silent = fakeContainer();
  const silentRpc = await createStdioRpcClient(silent.container, silent.docker);
  const timedOut = await silentRpc.call({ id: "7", export: "write_file", input }, { timeoutMs: 10 }).catch((err: Error) => err);
  const unwritable = fakeContainer({ stuck: true });
  const unwritableRpc = await createStdioRpcClient(unwritable.container, unwritable.docker);
  const writeFailed = await unwritableRpc.call({ id: "8", export: "write_file", input }).catch((err: Error) => err);
  const abortable = fakeContainer();
  const abortableRpc = await createStdioRpcClient(abortable.container, abortable.docker);
  const notSent = await abortableRpc.call({ id: "9", export: "write_file", input }, { signal: AbortSignal.abort() }).catch((err: Error) => err);

  for (const [err, id] of [[timedOut, "7"], [writeFailed, "8"], [notSent, "9"]] as const) {
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(`write_file \\(request ${id}\\)`));
    assert.doesNotMatch(err.message, /wJalrXUtnFEMI|\.env|content/);
  }
  assert.match((writeFailed as Error).message, /could not write/);
});

// The transport-agnostic core, as the microVM's socket client uses it.
function fakeConnections() {
  const opened: { written: string[]; onLine: (line: string) => void; onClose: () => void; isOpen: boolean }[] = [];
  const connect = async (onLine: (line: string) => void, onClose: () => void) => {
    const c = { written: [] as string[], onLine, onClose, isOpen: true };
    opened.push(c);
    return {
      write: (line: string) => (c.written.push(line), true),
      open: () => c.isOpen,
      close: () => {
        c.isOpen = false;
      },
    };
  };
  return { opened, connect };
}

test("line client: answers resolve by id, and junk lines are ignored", async () => {
  const fake = fakeConnections();
  const rpc = await createLineRpcClient({ connect: fake.connect, target: "a socket" });
  const a = rpc.call({ id: "a", export: "x" });
  const b = rpc.call({ id: "b", export: "y" });
  await new Promise((resolve) => setImmediate(resolve));
  const conn = fake.opened[0]!;
  conn.onLine("not json");
  conn.onLine(JSON.stringify(["an", "array"]));
  conn.onLine(JSON.stringify({ id: "b", result: 2 }));
  conn.onLine(JSON.stringify({ id: "a", result: 1 }));
  assert.deepEqual(await a, { id: "a", result: 1 });
  assert.deepEqual(await b, { id: "b", result: 2 });
  assert.equal(fake.opened.length, 1, "one connection for both calls");
});

test("line client: a closed connection fails its waiting calls at once when asked to, and the next call reconnects", async () => {
  const fake = fakeConnections();
  const rpc = await createLineRpcClient({ connect: fake.connect, target: "a socket", failPendingOnClose: true });
  const startedAt = Date.now();
  const call = rpc.call({ id: "1", export: "write_file", input: { secret: "s3cr3t" } });
  await new Promise((resolve) => setImmediate(resolve));
  fake.opened[0]!.isOpen = false;
  fake.opened[0]!.onClose();
  const err = await call.catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /no answer to write_file \(request 1\): the connection closed/);
  assert.doesNotMatch(err.message, /s3cr3t/);
  assert.ok(Date.now() - startedAt < 1_000);

  const next = rpc.call({ id: "2", export: "ping" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.opened.length, 2);
  fake.opened[1]!.onLine(JSON.stringify({ id: "2", result: "pong" }));
  assert.deepEqual(await next, { id: "2", result: "pong" });
});

test("line client: without failPendingOnClose a close leaves the call to its timeout (Docker attach behaviour)", async () => {
  const fake = fakeConnections();
  const rpc = await createLineRpcClient({ connect: fake.connect, target: "a socket" });
  const call = rpc.call({ id: "1", export: "slow" }, { timeoutMs: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  fake.opened[0]!.onClose();
  await assert.rejects(call, /timed out/);
});
