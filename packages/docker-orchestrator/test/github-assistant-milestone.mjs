#!/usr/bin/env node
// Real, running verification that apps/github-assistant (promoted from
// examples/github-assistant, now a deployed apps/* resident app) actually
// calls the GitHub REST API for real — against a local mock standing in for
// api.github.com, not a mock of the app itself.
//
// apps/github-assistant/berth.yml declares network:connect:443 (GitHub's
// real port) so the app is kernel-permitted to reach out at all under
// deny-by-default network policy, but this test's mock listens on an
// arbitrary high port instead of 443 — so it grants network:connect:<mock
// port> through a real running @berth/grants-server + the `berth grants
// approve` HTTP contract (same pattern as grants-server-milestone.mjs),
// rather than hand-editing the manifest for the test.
import Docker from "dockerode";
import http from "node:http";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "github-assistant");
const GRANTS_SERVER_ENTRY = join(REPO_ROOT, "packages", "grants-server", "dist", "server.js");
const GRANTS_PORT = 56902;
const MOCK_GITHUB_PORT = 56900;
const GRANTED_CAPABILITY = `network:connect:${MOCK_GITHUB_PORT}`;

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));

  const dataDir = await mkdtemp(join(tmpdir(), "berth-github-assistant-milestone-"));
  const grantsServer = await startGrantsServer(dataDir);
  const mock = await startMockGithub(MOCK_GITHUB_PORT);

  try {
    console.log(`\n--- Requesting+approving ${GRANTED_CAPABILITY} for "github-assistant" ---`);
    const created = await grantsFetch("/grants", {
      method: "POST",
      body: JSON.stringify({ appName: "github-assistant", capability: GRANTED_CAPABILITY, reason: "milestone test" }),
    });
    assert(created.status === "pending", `expected a fresh grant to be pending, got ${created.status}`);
    const approved = await grantsFetch(`/grants/${created.id}/approve`, {
      method: "POST",
      body: JSON.stringify({ decidedBy: "milestone-test" }),
    });
    assert(approved.status === "approved", `expected approval to stick, got ${approved.status}`);

    console.log("\n--- Building github-assistant's dev image ---");
    await buildImage({ appDir: APP_DIR, tag: "berth/github-assistant:dev", target: "dev", docker });

    console.log("\n--- Booting github-assistant's sandbox, pointed at the mock GitHub + grants server ---");
    const running = await startContainer({
      image: "berth/github-assistant:dev",
      name: "berth-github-assistant-milestone",
      manifest,
      bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
      workingDir: "/workspace/apps/github-assistant",
      env: {
        GITHUB_TOKEN: "milestone-test-token",
        GITHUB_REPO: "octocat/hello-world",
        GITHUB_API_BASE_URL: `http://host.docker.internal:${MOCK_GITHUB_PORT}`,
        BERTH_GRANTS_SERVER_URL: `http://host.docker.internal:${GRANTS_PORT}`,
      },
      docker,
    });

    const containerLog = await startLogCapture(running.container);
    try {
      await waitFor(() => /\[berth:capability-policy\] wrote/.test(containerLog.text()), 20000, "capability policy to be written");
      const policyLine = containerLog.text().match(/\[berth:capability-policy\] wrote.*$/m)?.[0] ?? "";
      console.log("\npolicy line:", policyLine);
      assert(
        /networkPorts=.*\b56900\b/.test(policyLine),
        `expected the approved ${GRANTED_CAPABILITY} to appear in the written policy's networkPorts: ${policyLine || "(no policy line seen)"}`,
      );

      await waitFor(() => /"github-assistant" ready/.test(containerLog.text()), 20000, "github-assistant runtime ready");

      const rpc = await createRpcClient(running.container);

      console.log("\n--- Test 1: get_repo_summary calls the real (mocked) GitHub API ---");
      const summary = await rpc.call({ id: "1", export: "get_repo_summary", input: { repo: "octocat/hello-world" } });
      console.log("response:", summary);
      assert(!summary.error, `expected get_repo_summary to succeed, got error: ${summary.error}`);
      assert(summary.result?.summary === "A mock repo", `expected the mock's description to come through, got: ${JSON.stringify(summary.result)}`);
      assert(summary.result?.open_issues === 7, `expected the mock's open_issues_count to come through, got: ${JSON.stringify(summary.result)}`);

      const getReq = mock.requestsReceived.find((r) => r.method === "GET" && r.url === "/repos/octocat/hello-world");
      assert(getReq, "expected the mock to have received a GET /repos/octocat/hello-world request");
      assert(getReq.headers.authorization === "Bearer milestone-test-token", `expected the real token in the Authorization header, got: ${getReq.headers.authorization}`);

      console.log("\n--- Test 2: create_issue POSTs the real (mocked) GitHub API ---");
      const created2 = await rpc.call({ id: "2", export: "create_issue", input: { title: "a title", body: "a body" } });
      console.log("response:", created2);
      assert(!created2.error, `expected create_issue to succeed, got error: ${created2.error}`);

      const postReq = mock.requestsReceived.find((r) => r.method === "POST" && r.url === "/repos/octocat/hello-world/issues");
      assert(postReq, "expected the mock to have received a POST /repos/octocat/hello-world/issues request");
      assert(postReq.body?.title === "a title" && postReq.body?.body === "a body", `expected the real request body to arrive, got: ${JSON.stringify(postReq.body)}`);

      rpc.close();
      console.log(
        "\nPASS — apps/github-assistant, now a real deployed app, made real HTTP requests to (a mock of) the " +
          "GitHub API over a capability granted through a real grants-server round trip.",
      );
    } finally {
      await containerLog.stop();
      await stopContainer(running.container);
    }
  } finally {
    grantsServer.kill();
    mock.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function startGrantsServer(dataDir) {
  const proc = spawn(process.execPath, [GRANTS_SERVER_ENTRY], {
    env: {
      ...process.env,
      BERTH_GRANTS_PORT: String(GRANTS_PORT),
      BERTH_GRANTS_HOST: "0.0.0.0",
      BERTH_GRANTS_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ready = false;
  proc.stdout.on("data", (chunk) => {
    if (chunk.toString("utf-8").includes("listening on")) ready = true;
  });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[berth-grants] ${chunk}`));

  await waitFor(() => ready, 10000, "berth-grants server to start listening");
  return proc;
}

async function grantsFetch(path, init) {
  const res = await fetch(`http://127.0.0.1:${GRANTS_PORT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`grants-server ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Stands in for api.github.com — records every request it receives and serves fixed JSON, so assertions can check the app made a real HTTP call with the right method/path/body/headers. */
async function startMockGithub(port) {
  const requestsReceived = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsedBody = body ? JSON.parse(body) : undefined;
      requestsReceived.push({ method: req.method, url: req.url, headers: req.headers, body: parsedBody });

      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/repos/octocat/hello-world") {
        res.end(JSON.stringify({ description: "A mock repo", open_issues_count: 7 }));
      } else if (req.method === "POST" && req.url === "/repos/octocat/hello-world/issues") {
        res.statusCode = 201;
        res.end(JSON.stringify({ number: 1 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "not found in mock" }));
      }
    });
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return { requestsReceived, close: () => server.close() };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startLogCapture(container) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer, stop: async () => raw.destroy() };
}

async function createRpcClient(container) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  const pending = new Map();

  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      } catch {
        // not a JSON line — ignore
      }
    }
  });

  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 30000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        stream.write(JSON.stringify(request) + "\n");
      });
    },
    close() {
      stream.end();
    },
  };
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
    console.error("\nGITHUB ASSISTANT MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
