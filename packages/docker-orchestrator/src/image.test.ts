import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { buildImage } from "./image.js";

// No Docker here: the daemon's side of a build is a stream that never ends,
// like a first build still compiling.
function fakeDocker() {
  const seen: { abortSignal?: AbortSignal }[] = [];
  let stream: PassThrough | undefined;
  const docker = {
    buildImage: async (_context: unknown, options: { abortSignal?: AbortSignal }) => {
      seen.push(options);
      stream = new PassThrough();
      return stream;
    },
    modem: {
      followProgress: (s: PassThrough, onFinished: (err: Error | null) => void) => {
        s.on("error", (err) => onFinished(err));
        s.on("end", () => onFinished(null));
        s.resume();
      },
    },
  } as unknown as Docker;
  return { docker, seen, stream: () => stream };
}

function appDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-image-"));
  writeFileSync(join(dir, "berth.yml"), "name: probe\nversion: 0.0.1\n");
  return dir;
}

test("a build is cancelled when its signal aborts, including the request to the daemon", async () => {
  const fake = fakeDocker();
  const controller = new AbortController();
  const building = buildImage({ appDir: appDir(), appName: "probe", tag: "berth/probe:dev", target: "dev", docker: fake.docker, signal: controller.signal });
  for (let i = 0; i < 200 && !fake.stream(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fake.stream(), "the build reached the daemon");
  assert.equal(fake.seen[0]!.abortSignal, controller.signal, "the daemon request carries the signal");

  controller.abort();
  await assert.rejects(building, /build of berth\/probe:dev was cancelled/);
  assert.equal(fake.stream()!.destroyed, true);
});

test("a build whose signal has already aborted doesn't start", async () => {
  const fake = fakeDocker();
  await assert.rejects(
    buildImage({ appDir: appDir(), appName: "probe", tag: "berth/probe:dev", target: "dev", docker: fake.docker, signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
  assert.equal(fake.seen.length, 0);
});
