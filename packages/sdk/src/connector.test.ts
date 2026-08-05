import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConnectorApp, type ConnectorConfig } from "./connector.js";
import type { ContextBusClient } from "./context-bus/client.js";
import type { BerthManifest } from "@berth/manifest-schema";

function fakeManifest(name: string): BerthManifest {
  return { name } as unknown as BerthManifest;
}

/** Swaps globalThis.fetch for the duration of one test, capturing every call — restored even if the test throws. */
async function withFakeFetch<T>(
  respond: (url: URL, init: RequestInit) => { status: number; json?: unknown; text?: string },
  run: (calls: { url: URL; init: RequestInit }[]) => Promise<T>,
): Promise<T> {
  const calls: { url: URL; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const response = respond(url, init ?? {});
    return {
      status: response.status,
      ok: response.status < 400,
      json: async () => response.json,
      text: async () => response.text ?? "",
    } as unknown as Response;
  }) as typeof fetch;

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("defineConnectorApp registers one export per operation", () => {
  const config: ConnectorConfig = {
    baseUrl: "https://api.example.com",
    operations: [
      { export: "op_a", method: "GET", path: "/a" },
      { export: "op_b", method: "POST", path: "/b" },
    ],
  };
  const app = defineConnectorApp(config);
  assert.deepEqual([...app._exports.keys()].sort(), ["op_a", "op_b"]);
});

test("a GET operation fills a path param and adds query params", async () => {
  await withFakeFetch(
    () => ({ status: 200, json: { ok: true } }),
    async (calls) => {
      const config: ConnectorConfig = {
        baseUrl: "https://api.example.com",
        operations: [
          {
            export: "get_repo",
            method: "GET",
            path: "/repos/{owner}/{repo}",
            params: {
              owner: { in: "path", type: "string" },
              repo: { in: "path", type: "string" },
              verbose: { in: "query", type: "boolean", required: false },
            },
          },
        ],
      };
      const app = defineConnectorApp(config);
      const def = app._exports.get("get_repo")!;

      const result = await def.handler(def.input!.parse({ owner: "ash", repo: "berth", verbose: true }));

      assert.equal(calls[0]!.url.toString(), "https://api.example.com/repos/ash/berth?verbose=true");
      assert.equal(calls[0]!.init.method, "GET");
      assert.deepEqual(result, { status: 200, data: { ok: true } });
    },
  );
});

test("a POST operation sends body params as JSON with a Content-Type header", async () => {
  await withFakeFetch(
    () => ({ status: 201, json: { id: 42 } }),
    async (calls) => {
      const config: ConnectorConfig = {
        baseUrl: "https://api.example.com",
        operations: [
          {
            export: "create_widget",
            method: "POST",
            path: "/widgets",
            params: { name: { in: "body", type: "string" }, color: { in: "body", type: "string", required: false } },
          },
        ],
      };
      const app = defineConnectorApp(config);
      const def = app._exports.get("create_widget")!;

      await def.handler(def.input!.parse({ name: "gadget" }));

      assert.equal(calls[0]!.init.method, "POST");
      assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { name: "gadget" });
      assert.equal((calls[0]!.init.headers as Record<string, string>)["Content-Type"], "application/json");
    },
  );
});

test("bearer auth adds an Authorization header from the configured env var", async () => {
  process.env.TEST_CONNECTOR_TOKEN = "secret-123";
  try {
    await withFakeFetch(
      () => ({ status: 200, json: {} }),
      async (calls) => {
        const config: ConnectorConfig = {
          baseUrl: "https://api.example.com",
          auth: { type: "bearer", envVar: "TEST_CONNECTOR_TOKEN" },
          operations: [{ export: "ping", method: "GET", path: "/ping" }],
        };
        const app = defineConnectorApp(config);
        const def = app._exports.get("ping")!;

        await def.handler(def.input!.parse({}));

        assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer secret-123");
      },
    );
  } finally {
    delete process.env.TEST_CONNECTOR_TOKEN;
  }
});

test("bearer auth with no credential configured returns a stub and never calls fetch", async () => {
  delete process.env.TEST_CONNECTOR_TOKEN_UNSET;
  await withFakeFetch(
    () => {
      throw new Error("fetch should never be called without a credential");
    },
    async (calls) => {
      const config: ConnectorConfig = {
        baseUrl: "https://api.example.com",
        auth: { type: "bearer", envVar: "TEST_CONNECTOR_TOKEN_UNSET" },
        operations: [{ export: "ping", method: "GET", path: "/ping" }],
      };
      const app = defineConnectorApp(config);
      const def = app._exports.get("ping")!;

      const result = await def.handler(def.input!.parse({}));

      assert.equal(calls.length, 0);
      assert.deepEqual(result, { stub: true, note: "set TEST_CONNECTOR_TOKEN_UNSET for live data — this operation is a no-op stub without it" });
    },
  );
});

test("header auth uses the configured header name instead of Authorization", async () => {
  process.env.TEST_CONNECTOR_APIKEY = "abc";
  try {
    await withFakeFetch(
      () => ({ status: 200, json: {} }),
      async (calls) => {
        const config: ConnectorConfig = {
          baseUrl: "https://api.example.com",
          auth: { type: "header", envVar: "TEST_CONNECTOR_APIKEY", headerName: "X-Api-Key" },
          operations: [{ export: "ping", method: "GET", path: "/ping" }],
        };
        const app = defineConnectorApp(config);
        const def = app._exports.get("ping")!;

        await def.handler(def.input!.parse({}));

        const headers = calls[0]!.init.headers as Record<string, string>;
        assert.equal(headers["X-Api-Key"], "abc");
        assert.equal(headers.Authorization, undefined);
      },
    );
  } finally {
    delete process.env.TEST_CONNECTOR_APIKEY;
  }
});

test("auth type none never sends a credential, even with the env var set", async () => {
  process.env.TEST_CONNECTOR_IGNORED = "should-not-be-sent";
  try {
    await withFakeFetch(
      () => ({ status: 200, json: {} }),
      async (calls) => {
        const config: ConnectorConfig = {
          baseUrl: "https://api.example.com",
          auth: { type: "none", envVar: "TEST_CONNECTOR_IGNORED" },
          operations: [{ export: "ping", method: "GET", path: "/ping" }],
        };
        const app = defineConnectorApp(config);
        const def = app._exports.get("ping")!;

        await def.handler(def.input!.parse({}));

        assert.equal(calls.length, 1);
        assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, undefined);
      },
    );
  } finally {
    delete process.env.TEST_CONNECTOR_IGNORED;
  }
});

test("registers with the context bus using the manifest's own name, not anything hardcoded in the config", async () => {
  const registeredAs: { app: string }[] = [];
  const contextBus: ContextBusClient = {
    register: async (info) => {
      registeredAs.push(info);
    },
    publish: async () => {},
    subscribe: () => () => {},
  };

  const config: ConnectorConfig = { baseUrl: "https://api.example.com", operations: [] };
  const app = defineConnectorApp(config);

  for (const hook of app._onAgentReadyHooks) {
    await hook({ contextBus, semanticFs: undefined as never, manifest: fakeManifest("my-connector") });
  }

  assert.deepEqual(registeredAs, [{ app: "my-connector" }]);
});
