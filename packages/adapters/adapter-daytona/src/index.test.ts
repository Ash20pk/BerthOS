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

test("upload() passes regionId through to snapshot.create() when target.region is set", async (t) => {
  const created = { name: "snap-abc" };
  const snapshotCreate = t.mock.fn(async (_params: unknown) => created);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        snapshot = { create: snapshotCreate };
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  await createDaytonaAdapter().upload({ imageRef: "berth/x:1.0.0", manifest, region: "eu-central-1" });

  assert.deepEqual(snapshotCreate.mock.calls[0]?.arguments[0], {
    name: "x",
    image: "berth/x:1.0.0",
    regionId: "eu-central-1",
  });
});

test("upload() omits regionId entirely when target.region isn't set", async (t) => {
  const created = { name: "snap-abc" };
  const snapshotCreate = t.mock.fn(async (_params: unknown) => created);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        snapshot = { create: snapshotCreate };
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  await createDaytonaAdapter().upload({ imageRef: "berth/x:1.0.0", manifest });

  assert.deepEqual(snapshotCreate.mock.calls[0]?.arguments[0], { name: "x", image: "berth/x:1.0.0" });
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

test("previewUrl() dials the sandbox's getPreviewLink(port)", async (t) => {
  const sandbox = {
    id: "sbx-2",
    state: "started",
    getPreviewLink: async (port: number) => ({ url: `https://${port}-sbx-2.daytona.example`, token: "tok" }),
  };
  const create = t.mock.fn(async (_params: unknown) => sandbox);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        create = create;
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const adapter = createDaytonaAdapter();
  const handle = await adapter.start("snap-abc", { imageRef: "berth/x:1.0.0", manifest });

  const url = await adapter.previewUrl!(handle, 6080);
  assert.equal(url, "https://6080-sbx-2.daytona.example");
});

test("previewUrl() returns null when the sandbox's getPreviewLink rejects (port not open)", async (t) => {
  const sandbox = {
    id: "sbx-3",
    state: "started",
    getPreviewLink: async () => {
      throw new Error("port not open");
    },
  };
  const create = t.mock.fn(async (_params: unknown) => sandbox);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        create = create;
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const adapter = createDaytonaAdapter();
  const handle = await adapter.start("snap-abc", { imageRef: "berth/x:1.0.0", manifest });

  const url = await adapter.previewUrl!(handle, 7681);
  assert.equal(url, null);
});

test("rpcUrl() appends the sandbox's preview-link token as a DAYTONA_SANDBOX_AUTH_KEY query param", async (t) => {
  const sandbox = {
    id: "sbx-4",
    state: "started",
    getPreviewLink: async (port: number) => ({ url: `https://${port}-sbx-4.daytona.example`, token: "sekrit-tok" }),
  };
  const create = t.mock.fn(async (_params: unknown) => sandbox);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        create = create;
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const adapter = createDaytonaAdapter();
  const handle = await adapter.start("snap-abc", { imageRef: "berth/x:1.0.0", manifest });

  const url = await adapter.rpcUrl!(handle, 7300);
  assert.equal(url, "https://7300-sbx-4.daytona.example/?DAYTONA_SANDBOX_AUTH_KEY=sekrit-tok");
});

test("fork() calls sandbox.fork(params) and wraps the returned Sandbox in a new handle", async (t) => {
  const forkedSandbox = { id: "sbx-fork-1", state: "started" };
  const fork = t.mock.fn(async (_params?: { name?: string }) => forkedSandbox);
  const sandbox = { id: "sbx-6", state: "started", fork };
  const create = t.mock.fn(async (_params: unknown) => sandbox);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        create = create;
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const adapter = createDaytonaAdapter();
  const handle = await adapter.start("snap-abc", { imageRef: "berth/x:1.0.0", manifest });

  const forkedHandle = await adapter.fork!(handle, { name: "my-fork" });

  assert.equal(forkedHandle.id, "sbx-fork-1");
  assert.equal(fork.mock.calls.length, 1);
  assert.deepEqual(fork.mock.calls[0]?.arguments[0], { name: "my-fork" });
});

test("fork() throws for a handle this adapter didn't create", async () => {
  const { createDaytonaAdapter } = await import("./index.js");
  const adapter = createDaytonaAdapter();
  const foreignHandle = {
    id: "not-daytona",
    status: async () => "running" as const,
    streamLogs: async function* () {},
    stop: async () => {},
  };

  await assert.rejects(() => adapter.fork!(foreignHandle), /needs a handle this adapter created/);
});

test("snapshot() calls sandbox.createSnapshot(name)", async (t) => {
  const createSnapshotFn = t.mock.fn(async (_name: string) => undefined);
  const sandbox = { id: "sbx-7", state: "started", createSnapshot: createSnapshotFn };
  const create = t.mock.fn(async (_params: unknown) => sandbox);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        create = create;
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const adapter = createDaytonaAdapter();
  const handle = await adapter.start("snap-abc", { imageRef: "berth/x:1.0.0", manifest });

  await adapter.snapshot!(handle, "my-snapshot");

  assert.equal(createSnapshotFn.mock.calls.length, 1);
  assert.equal(createSnapshotFn.mock.calls[0]?.arguments[0], "my-snapshot");
});

test("rpcUrl() leaves the URL bare when the preview link carries no token (non-private sandbox)", async (t) => {
  const sandbox = {
    id: "sbx-5",
    state: "started",
    getPreviewLink: async (port: number) => ({ url: `https://${port}-sbx-5.daytona.example` }),
  };
  const create = t.mock.fn(async (_params: unknown) => sandbox);
  t.mock.module("@daytonaio/sdk", {
    namedExports: {
      Daytona: class {
        create = create;
      },
    },
  });

  const { createDaytonaAdapter } = await import("./index.js");
  const adapter = createDaytonaAdapter();
  const handle = await adapter.start("snap-abc", { imageRef: "berth/x:1.0.0", manifest });

  const url = await adapter.rpcUrl!(handle, 7300);
  assert.equal(url, "https://7300-sbx-5.daytona.example");
});
