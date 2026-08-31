import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berth/manifest-schema";

const manifest = { name: "x" } as unknown as BerthManifest;

test("start() wraps the created sandbox, and previewUrl() dials its getHost(port)", async (t) => {
  const sandbox = {
    sandboxId: "sbx-1",
    getHost: (port: number) => `${port}-sbx-1.e2b.dev`,
  };
  const create = t.mock.fn(async (_ref: string, _opts: unknown) => sandbox);
  t.mock.module("e2b", {
    namedExports: {
      Sandbox: { create },
      Template: { build: async () => ({ templateId: "tmpl-1" }) },
    },
  });

  const { createE2bAdapter } = await import("./index.js");
  const adapter = createE2bAdapter();
  const handle = await adapter.start("tmpl-1", { imageRef: "berth/x:1.0.0", manifest });

  assert.equal(handle.id, "sbx-1");
  assert.equal(create.mock.calls.length, 1);

  const url = await adapter.previewUrl!(handle, 6080);
  assert.equal(url, "https://6080-sbx-1.e2b.dev");
});

test("previewUrl() returns null for a handle this adapter didn't create", async () => {
  const { createE2bAdapter } = await import("./index.js");
  const adapter = createE2bAdapter();
  const foreignHandle = {
    id: "not-e2b",
    status: async () => "running" as const,
    streamLogs: async function* () {},
    stop: async () => {},
  };

  const url = await adapter.previewUrl!(foreignHandle, 6080);
  assert.equal(url, null);
});

test("rpcUrl() dials the sandbox's getHost(port), same as previewUrl()", async (t) => {
  const sandbox = {
    sandboxId: "sbx-1",
    getHost: (port: number) => `${port}-sbx-1.e2b.dev`,
  };
  const create = t.mock.fn(async (_ref: string, _opts: unknown) => sandbox);
  t.mock.module("e2b", {
    namedExports: {
      Sandbox: { create },
      Template: { build: async () => ({ templateId: "tmpl-1" }) },
    },
  });

  const { createE2bAdapter } = await import("./index.js");
  const adapter = createE2bAdapter();
  const handle = await adapter.start("tmpl-1", { imageRef: "berth/x:1.0.0", manifest });

  const url = await adapter.rpcUrl!(handle, 7300);
  assert.equal(url, "https://7300-sbx-1.e2b.dev");
});

test("rpcUrl() returns null for a handle this adapter didn't create", async () => {
  const { createE2bAdapter } = await import("./index.js");
  const adapter = createE2bAdapter();
  const foreignHandle = {
    id: "not-e2b",
    status: async () => "running" as const,
    streamLogs: async function* () {},
    stop: async () => {},
  };

  const url = await adapter.rpcUrl!(foreignHandle, 7300);
  assert.equal(url, null);
});

class FakeConnectionConfig {
  getSignal() {
    return undefined;
  }
}

test("pause() POSTs the raw /sandboxes/{sandboxID}/pause endpoint via ApiClient", async (t) => {
  const post = t.mock.fn(async (path: string, opts: any) => {
    assert.equal(path, "/sandboxes/{sandboxID}/pause");
    assert.deepEqual(opts.params, { path: { sandboxID: "sbx-1" } });
    return { data: undefined, error: undefined };
  });
  t.mock.module("e2b", {
    namedExports: {
      ConnectionConfig: FakeConnectionConfig,
      ApiClient: class {
        api = { POST: post };
      },
    },
  });

  const { createE2bAdapter } = await import("./index.js");
  const adapter = createE2bAdapter();
  await adapter.pause!({ id: "sbx-1", status: async () => "running", streamLogs: async function* () {}, stop: async () => {} });

  assert.equal(post.mock.calls.length, 1);
});

test("pause() throws a clear error when the API responds with an error", async (t) => {
  t.mock.module("e2b", {
    namedExports: {
      ConnectionConfig: FakeConnectionConfig,
      ApiClient: class {
        api = { POST: async () => ({ data: undefined, error: { code: 404, message: "not found" } }) };
      },
    },
  });

  const { createE2bAdapter } = await import("./index.js");
  const adapter = createE2bAdapter();
  await assert.rejects(
    () => adapter.pause!({ id: "sbx-missing", status: async () => "running", streamLogs: async function* () {}, stop: async () => {} }),
    /e2b POST \/sandboxes\/sbx-missing\/pause failed/,
  );
});

test("resume() POSTs the raw /resume endpoint with a 300s timeout, then connects via Sandbox.connect", async (t) => {
  const post = t.mock.fn(async (path: string, opts: any) => {
    assert.equal(path, "/sandboxes/{sandboxID}/resume");
    assert.deepEqual(opts.body, { autoPause: false, timeout: 300 });
    return { data: { sandboxID: "sbx-1" }, error: undefined };
  });
  const connect = t.mock.fn(async (id: string) => ({ sandboxId: id, getHost: (port: number) => `${port}-${id}.e2b.dev` }));
  t.mock.module("e2b", {
    namedExports: {
      ConnectionConfig: FakeConnectionConfig,
      ApiClient: class {
        api = { POST: post };
      },
      Sandbox: { connect },
    },
  });

  const { createE2bAdapter } = await import("./index.js");
  const adapter = createE2bAdapter();
  const handle = await adapter.resume!("sbx-1");

  assert.equal(handle.id, "sbx-1");
  assert.equal(post.mock.calls.length, 1);
  assert.equal(connect.mock.calls.length, 1);
});
