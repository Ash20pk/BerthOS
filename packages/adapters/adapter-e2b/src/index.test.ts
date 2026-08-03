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
