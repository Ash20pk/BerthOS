#!/usr/bin/env node
// Real, running verification that Computer.boot({ httpRpc }) exposes a live,
// host-reachable HTTP RPC bridge into a resident app's exports — the
// mechanism a process with no Docker API access (a Python client, see
// packages/agents-python's Computer.connect()) uses instead of docker
// exec/attach. No mocking of Docker, the image build, the container port
// mapping, or the RPC transport.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const CODE_EDITOR_APP_DIR = join(REPO_ROOT, "apps", "code-editor");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function callOverHttp(httpRpc, exportName, input, authToken = httpRpc.authToken) {
  const res = await fetch(`${httpRpc.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ id: "1", export: exportName, input }),
  });
  return { status: res.status, body: await res.json() };
}

async function singleAppCase() {
  console.log("--- Single-app case: Computer.boot({ apps: [filesystem], httpRpc: true }) ---");
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR], httpRpc: true });

  try {
    assert(computer.httpRpc, "expected computer.httpRpc to be set");
    assert(computer.httpRpc.appName === undefined, `expected no appName for a single-app bridge, got: ${computer.httpRpc.appName}`);
    console.log("httpRpc:", { url: computer.httpRpc.url, appName: computer.httpRpc.appName });

    console.log("Healthz with no auth required...");
    const health = await fetch(`${computer.httpRpc.url}/healthz`);
    assert(health.ok, `expected /healthz to succeed unauthenticated, got ${health.status}`);
    assert((await health.json()).ok === true, "expected /healthz body {ok:true}");

    console.log("Writing through the normal stdio dispatch path...");
    await computer.call("write_file", { path: "http-rpc-milestone.txt", content: "hello over http" });

    console.log("Reading the same file back over the HTTP bridge instead...");
    const { status, body } = await callOverHttp(computer.httpRpc, "read_file", { path: "http-rpc-milestone.txt" });
    console.log("http /rpc response:", status, body);
    assert(status === 200, `expected HTTP 200 from /rpc, got ${status}`);
    assert(!body.error, `expected read_file to succeed over HTTP, got error: ${body.error}`);
    assert(
      body.result?.content === "hello over http",
      `expected the content written via stdio to round-trip over HTTP, got: ${JSON.stringify(body.result)}`,
    );

    console.log("A wrong bearer token gets a real 401, not a silent pass-through...");
    const unauthorized = await callOverHttp(computer.httpRpc, "read_file", { path: "http-rpc-milestone.txt" }, "wrong-token");
    assert(unauthorized.status === 401, `expected 401 for a wrong token, got ${unauthorized.status}`);

    console.log("PASS — single-app HTTP RPC bridge round-trips a real export call and rejects a bad token.\n");
  } finally {
    await computer.stop();
  }
}

async function multiAppCase() {
  console.log("--- Multi-app case: only the designated app's exports are reachable over HTTP ---");
  const computer = await Computer.boot({
    apps: [FILESYSTEM_APP_DIR, CODE_EDITOR_APP_DIR],
    httpRpc: { app: "filesystem" },
  });

  try {
    assert(computer.httpRpc, "expected computer.httpRpc to be set");
    assert(computer.httpRpc.appName === "filesystem", `expected appName "filesystem", got: ${computer.httpRpc.appName}`);

    console.log("Calling filesystem's own (bare, non-namespaced) export name over HTTP...");
    const { status, body } = await callOverHttp(computer.httpRpc, "write_file", { path: "multi-app-http-rpc.txt", content: "multi-app hello" });
    console.log("http /rpc response:", status, body);
    assert(status === 200 && !body.error, `expected write_file to succeed over HTTP, got: ${JSON.stringify(body)}`);

    console.log("Confirming code-editor's export is NOT reachable through filesystem's bridge process...");
    const wrongApp = await callOverHttp(computer.httpRpc, "open_file", { path: "multi-app-http-rpc.txt" });
    console.log("http /rpc response for a sibling app's export:", wrongApp.status, wrongApp.body);
    assert(
      wrongApp.status === 200 && wrongApp.body.error,
      `expected a real "no such export" error for a sibling app's export name, got: ${JSON.stringify(wrongApp.body)}`,
    );

    console.log("PASS — the HTTP bridge only ever serves its designated app's own exports, as documented.\n");
  } finally {
    await computer.stop();
  }
}

async function main() {
  await singleAppCase();
  await multiAppCase();
  console.log("PASS — Computer.boot({ httpRpc }) is a real, host-reachable bridge for both single- and multi-app computers.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCOMPUTER HTTP RPC MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
