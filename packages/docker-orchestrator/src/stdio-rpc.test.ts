import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex, type PassThrough } from "node:stream";
import type Docker from "dockerode";
import { createStdioRpcClient } from "./stdio-rpc.js";

// No Docker here: the attach stream and demux are the only two things the
// client touches, so both are stood in for. `answer` plays the app's side.
function fakeContainer() {
  const written: string[] = [];
  let stdout: PassThrough | undefined;
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      written.push(chunk.toString());
      done();
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
  await assert.rejects(rpc.call({ id: "2", export: "slow" }, { signal: AbortSignal.abort() }), /not sent/);
  assert.equal(fake.written.length, before);
});
