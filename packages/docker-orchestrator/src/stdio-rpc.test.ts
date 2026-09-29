import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex, type PassThrough } from "node:stream";
import type Docker from "dockerode";
import { createStdioRpcClient, RpcNotSentError } from "./stdio-rpc.js";

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
