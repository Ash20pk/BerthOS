import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { DeployAdapter, DeployHandle, DeployTarget } from "@berth/adapter-core";
import type { BerthManifest } from "@berth/manifest-schema";
import { HttpBridgeComputer } from "./fleet-computer.js";
import type { ComputerAppSpec } from "./resolve-apps.js";

/**
 * Doesn't touch Docker or any real cloud provider — a fake DeployAdapter
 * whose start() boots a real local http.createServer speaking the exact
 * wire protocol @berth/sdk's startHttpRpcServer does (POST /rpc with a
 * bearer token, {id,export,input} in, {id,result}/{id,error} out), using
 * the port/token HttpBridgeComputer.deploy() itself generates. This tests
 * the real dispatch/health-check/auth logic in fleet-computer.ts end-to-end
 * at the protocol level, without needing an E2B/Daytona/K8s account or
 * reaching into @berth/sdk's internals — same mocked-adapter posture
 * adapter-e2b/adapter-daytona's own tests already use for the parts that
 * need a live account.
 */
function fakeAdapterBackedByRealServer() {
  let server: http.Server | undefined;
  const adapter: DeployAdapter = {
    name: "fake",
    async upload(_target: DeployTarget) {
      return { remoteImageRef: "fake-image" };
    },
    async start(_remoteImageRef: string, target: DeployTarget) {
      const port = Number(target.env!.BERTH_HTTP_RPC_PORT);
      const authToken = target.env!.BERTH_HTTP_RPC_TOKEN!;

      server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/healthz") {
          res.writeHead(200).end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.headers.authorization !== `Bearer ${authToken}`) {
          res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { id, export: exportName, input } = JSON.parse(body);
          const result = exportName === "greet" ? `hello ${(input as { name: string }).name}` : undefined;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result !== undefined ? { id, result } : { id, error: `no such export "${exportName}"` }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));

      const handle: DeployHandle = {
        id: "fake-1",
        status: async () => "running",
        streamLogs: async function* () {},
        stop: async () => {
          await new Promise((resolve) => server!.close(resolve));
        },
      };
      return handle;
    },
    async teardown(handle: DeployHandle) {
      await handle.stop();
    },
    async rpcUrl(_handle: DeployHandle, rpcPort: number) {
      return `http://127.0.0.1:${rpcPort}`;
    },
  };
  return adapter;
}

const manifest = {
  name: "greeter",
  exports: [{ name: "greet", input: { name: "string" } }],
} as unknown as BerthManifest;

const apps: ComputerAppSpec[] = [{ name: "greeter", appDir: "/fake", manifest }];

test("HttpBridgeComputer.deploy() brings up a real HTTP RPC bridge and dispatches through it", async () => {
  const port = 22000 + Math.floor(Math.random() * 5000);
  const computer = await HttpBridgeComputer.deploy({
    adapter: fakeAdapterBackedByRealServer(),
    port,
    imageRef: "fake-image",
    manifest,
    apps,
  });

  try {
    assert.ok(computer.tools.some((t) => t.name === "greet"));
    const result = await computer.call("greet", { name: "world" });
    assert.equal(result, "hello world");
  } finally {
    await computer.stop();
  }
});

test("HttpBridgeComputer.deploy() throws if the adapter doesn't support rpcUrl()", async () => {
  const adapter: DeployAdapter = {
    name: "no-rpc-url",
    async upload() {
      return { remoteImageRef: "x" };
    },
    async start() {
      return { id: "x", status: async () => "running" as const, streamLogs: async function* () {}, stop: async () => {} };
    },
    async teardown() {},
  };

  await assert.rejects(
    () => HttpBridgeComputer.deploy({ adapter, port: 9999, imageRef: "x", manifest, apps }),
    /doesn't support rpcUrl/,
  );
});

test("HttpBridgeComputer.deploy() tears down the instance if the bridge never comes up", async () => {
  let tornDown = false;
  const adapter: DeployAdapter = {
    name: "never-ready",
    async upload() {
      return { remoteImageRef: "x" };
    },
    async start() {
      return { id: "x", status: async () => "starting" as const, streamLogs: async function* () {}, stop: async () => {} };
    },
    async teardown() {
      tornDown = true;
    },
    async rpcUrl() {
      return null;
    },
  };

  await assert.rejects(() => HttpBridgeComputer.deploy({ adapter, port: 9999, imageRef: "x", manifest, apps, readyTimeoutMs: 200 }));
  assert.equal(tornDown, true);
});
