import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berth/manifest-schema";

const manifest = { name: "x" } as unknown as BerthManifest;

test("upload() calls snapshot.create and returns its name as remoteImageRef", async (t) => {
  const created = { name: "snap-abc" };
  const snapshotCreate = t.mock.fn(async (_params: { name: string; image: string }) => created);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        snapshot = { create: snapshotCreate };
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const result = await createDaytonaAdapter().upload({ imageRef: "berth/x:1.0.0", manifest });

  assert.equal(result.remoteImageRef, "snap-abc");
  assert.equal(snapshotCreate.mock.calls.length, 1);
  assert.deepEqual(snapshotCreate.mock.calls[0]?.arguments[0], {
    name: "x",
    image: "berth/x:1.0.0",
  });
});

test("start() calls client.create({snapshot, envVars}) and wraps the returned sandbox", async (t) => {
  const sandbox = { id: "sbx-1", state: "started" };
  const create = t.mock.fn(async (_params: { snapshot: string; envVars?: Record<string, string> }) => sandbox);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        create = create;
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const handle = await createDaytonaAdapter().start("snap-abc", {
    imageRef: "berth/x:1.0.0",
    manifest,
    env: { FOO: "1" },
  });

  assert.equal(handle.id, "sbx-1");
  assert.equal(create.mock.calls.length, 1);
  assert.deepEqual(create.mock.calls[0]?.arguments[0], {
    snapshot: "snap-abc",
    envVars: { FOO: "1" },
  });
  assert.equal(await handle.status(), "running");
});
