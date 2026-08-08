#!/usr/bin/env node
// Real, running verification that startContainer()'s `httpRpc` option
// produces a live, host-reachable HTTP RPC bridge into a resident app's
// exports — port mapping, the three BERTH_HTTP_RPC_* env vars, and
// @berth/sdk's startHttpRpcServer's bearer-token auth, all exercised for
// real against a real container, not mocked. Uses target:"dev" deliberately
// (not buildComputerImage()'s "production", which @berth/agents' own
// Computer.boot({httpRpc}) milestone test — computer-http-rpc-milestone.mjs
// — uses) so this test verifies the actual bridge mechanism independent of
// the already-documented, unrelated Docker-Desktop-for-Mac Landlock
// limitation (BERTH_REQUIRE_ENFORCEMENT refuses to exec on a kernel that
// can't enforce Landlock) that blocks every production-target milestone
// test on this class of dev machine — see docs/capability-tokens-reference.md.
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";
import Docker from "dockerode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const IMAGE_TAG = "berth/filesystem-http-rpc-milestone:dev";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const docker = new Docker();
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));

  console.log("--- Building filesystem's dev image ---");
  await buildImage({ appDir: APP_DIR, tag: IMAGE_TAG, target: "dev", docker });

  const authToken = randomBytes(32).toString("hex");
  console.log("\n--- Starting the container with httpRpc enabled ---");
  const { container, ports } = await startContainer({
    image: IMAGE_TAG,
    name: "berth-http-rpc-bridge-milestone",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    httpRpc: { authToken },
    // Where `berth dev` puts app data. Apps run as their own uid now (Step 2
    // of docs/per-app-uid-design.md) and cannot write the bind-mounted
    // repository root, which is owned by the developer or the CI runner.
    env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" },
    docker,
  });

  const containerLog = await startLogCapture(container, docker);
  try {
    console.log("ports:", ports);
    assert(ports.httpRpc, `expected a host-mapped httpRpc port, got: ${JSON.stringify(ports)}`);
    const url = `http://127.0.0.1:${ports.httpRpc}`;

    // 60s, not 30 — a fresh, cold CI runner (no warm Docker layer cache, a
    // shared/noisier CPU) has real, higher boot latency than a dev machine
    // that's already run this image before. Print the container's own log
    // on failure either way, so a real future failure is diagnosable from
    // the CI log instead of just "ECONNREFUSED" with no context.
    console.log("\n--- Test: /healthz becomes reachable within 60s, no auth required ---");
    await waitFor(async () => {
      try {
        return (await fetch(`${url}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 60000, "GET /healthz to return 200");

    console.log("\n--- Test: a real write_file/read_file round trip over POST /rpc ---");
    const writeRes = await rpcCall(url, authToken, "write_file", { path: "http-rpc-bridge-milestone.txt", content: "verified over http" });
    assert(writeRes.status === 200 && !writeRes.body.error, `expected write_file to succeed, got: ${JSON.stringify(writeRes)}`);

    const readRes = await rpcCall(url, authToken, "read_file", { path: "http-rpc-bridge-milestone.txt" });
    assert(
      readRes.body.result?.content === "verified over http",
      `expected the written content to round-trip, got: ${JSON.stringify(readRes.body)}`,
    );

    console.log("\n--- Test: a wrong bearer token gets a real 401, not a silent pass-through ---");
    const unauthorized = await rpcCall(url, "wrong-token", "read_file", { path: "http-rpc-bridge-milestone.txt" });
    assert(unauthorized.status === 401, `expected 401 for a wrong token, got ${unauthorized.status}`);

    console.log("\n--- Test: a missing bearer header also gets 401 ---");
    const noAuthRes = await fetch(`${url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", export: "read_file", input: {} }),
    });
    assert(noAuthRes.status === 401, `expected 401 for a missing bearer header, got ${noAuthRes.status}`);

    console.log(
      "\nPASS — startContainer()'s httpRpc option produces a real, host-reachable, bearer-token-authenticated RPC bridge.",
    );
  } catch (err) {
    console.error("\n--- Container log (for diagnosing the failure above) ---");
    console.error(containerLog.text());
    throw err;
  } finally {
    await containerLog.stop();
    await stopContainer(container).catch(() => {});
  }
}

async function startLogCapture(container, docker) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer, stop: async () => raw.destroy() };
}

async function rpcCall(url, authToken, exportName, input) {
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ id: "1", export: exportName, input }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitFor(predicate, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nHTTP RPC BRIDGE MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
