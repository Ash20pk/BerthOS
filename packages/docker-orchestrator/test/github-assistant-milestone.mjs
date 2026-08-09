#!/usr/bin/env node
// Real, running verification that apps/github-assistant (promoted from
// examples/github-assistant, now a deployed apps/* resident app) actually
// calls the GitHub REST API for real.
//
// Two scenarios:
//   runBypassScenario() — the app's own request-shaping logic (auth header,
//   body, path construction), against a local plain-HTTP mock reached
//   directly (GITHUB_API_BASE_URL override), independent of the broker.
//   runBrokerScenario() — the actual github-api-broker.cjs path: the app
//   really dials https://api.github.com through undici's ProxyAgent, the
//   broker terminates that TLS session for real (its own generated CA/leaf
//   cert), decrypts, checks the real method+path against declared
//   github:read:*/github:write:* capabilities, and either forwards to a
//   mock upstream (redirected via BERTH_GITHUB_API_UPSTREAM_HOST, matching
//   what a real broker->api.github.com hop would do) or refuses outright
//   for an out-of-scope request — proving real verb/path enforcement, not
//   simulated.
import Docker from "dockerode";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
const BROKER_UPSTREAM_MOCK_PORT = 56904;
const OPERATOR_TOKEN = "milestone-test-operator-token";

const docker = new Docker();

async function main() {
  await runBypassScenario();
  await runBrokerScenario();
}

async function runBypassScenario() {
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
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
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

async function runBrokerScenario() {
  console.log("\n=== Broker scenario: real TLS-terminating verb/path enforcement ===");
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));

  // A cert dir under the bind-mounted REPO_ROOT, so the mock upstream's CA
  // (generated on the host) is readable from inside the container too, via
  // /workspace — the same trick startContainer's bindMount already provides
  // for everything else in this repo.
  const certDir = await mkdtemp(join(REPO_ROOT, ".tmp-github-broker-test-"));
  const relativeCertDir = certDir.slice(REPO_ROOT.length + 1);

  try {
    const mockUpstream = await startMockUpstreamHttps(BROKER_UPSTREAM_MOCK_PORT, certDir);

    console.log("\n--- Building github-assistant's dev image ---");
    await buildImage({ appDir: APP_DIR, tag: "berth/github-assistant:dev", target: "dev", docker });

    console.log("\n--- Booting github-assistant's sandbox with the real GitHub API broker active ---");
    const running = await startContainer({
      image: "berth/github-assistant:dev",
      name: "berth-github-assistant-broker-milestone",
      manifest,
      bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
      workingDir: "/workspace/apps/github-assistant",
      env: {
        GITHUB_TOKEN: "milestone-test-token",
        GITHUB_REPO: "octocat/hello-world",
        // No GITHUB_API_BASE_URL here — the app dials the real
        // "https://api.github.com", exactly as it would in production, so
        // the broker's CONNECT-interception of that literal hostname is
        // genuinely exercised rather than bypassed.
        BERTH_GITHUB_API_UPSTREAM_HOST: "host.docker.internal",
        BERTH_GITHUB_API_UPSTREAM_PORT: String(BROKER_UPSTREAM_MOCK_PORT),
        BERTH_GITHUB_API_UPSTREAM_CA_PATH: `/workspace/${relativeCertDir}/mock-ca.crt`,
      },
      docker,
    });

    const containerLog = await startLogCapture(running.container);
    try {
      await waitFor(
        () => /\[github-api-broker\] listening on/.test(containerLog.text()),
        20000,
        "github-api-broker to start",
      );
      await waitFor(() => /"github-assistant" ready/.test(containerLog.text()), 20000, "github-assistant runtime ready");

      const rpc = await createRpcClient(running.container);

      console.log("\n--- Test 3: get_repo_summary, routed through undici's ProxyAgent + the real broker ---");
      const summary = await rpc.call({ id: "3", export: "get_repo_summary", input: { repo: "octocat/hello-world" } });
      console.log("response:", summary);
      assert(!summary.error, `expected get_repo_summary to succeed through the broker, got error: ${summary.error}`);
      assert(
        summary.result?.summary === "A mock repo (via broker)",
        `expected the mock upstream's real response to arrive through the broker, got: ${JSON.stringify(summary.result)}`,
      );

      const getReq = mockUpstream.requestsReceived.find((r) => r.method === "GET" && r.url === "/repos/octocat/hello-world");
      assert(getReq, "expected the mock upstream to have received a real GET, forwarded by the broker");

      const allowedLog = containerLog.text().match(/\[github-api-broker\] \{"event":"allowed".*"github:read:repos".*\}/);
      assert(allowedLog, "expected the broker's own allow-log for this request — the app's traffic may be bypassing the broker entirely");
      console.log("PASS — a real HTTPS request to api.github.com was genuinely decrypted, allowed, and forwarded by the broker.");

      console.log("\n--- Test 4: a request for a scope NOT covered by any declared capability is really denied ---");
      // Driven directly against the broker (not through the app, which
      // never calls this endpoint) — proves the broker enforces scope for
      // real, not just for whatever the app happens to call today.
      // apps/github-assistant declares github:read:repos/github:write:issues
      // only — "pulls" is covered by neither.
      const denied = await execInContainer(running.container, [
        "node",
        "-e",
        rawBrokerRequestScript("POST", "/repos/octocat/hello-world/pulls"),
      ]);
      console.log("raw broker response status:", denied.trim());
      assert(denied.includes("403"), `expected a 403 for an out-of-scope request, got: ${denied}`);
      assert(
        !mockUpstream.requestsReceived.some((r) => r.url.includes("/pulls")),
        "expected the denied request to never reach the mock upstream at all",
      );
      const deniedLog = containerLog.text().match(/\[github-api-broker\] \{"event":"denied".*"github:write:pulls".*\}/);
      assert(deniedLog, "expected the broker's own denial-log for this out-of-scope request");
      console.log("PASS — a request outside every declared github:*  capability's scope was refused by the broker before ever reaching the real API.");

      rpc.close();
      console.log(
        "\nALL PASS — github-api-broker.cjs performs a genuine decrypt/decide/re-encrypt round trip: an in-scope " +
          "request is forwarded for real, an out-of-scope one is refused before the real API is ever touched.",
      );
    } finally {
      await containerLog.stop();
      await stopContainer(running.container);
    }

    mockUpstream.close();
  } finally {
    await rm(certDir, { recursive: true, force: true });
  }
}

/** Stands in for the real api.github.com on the far side of the broker's own outbound leg — a real HTTPS server, with a cert the broker is told to trust via BERTH_GITHUB_API_UPSTREAM_CA_PATH. */
async function startMockUpstreamHttps(port, certDir) {
  const caKey = join(certDir, "mock-ca.key");
  const caCert = join(certDir, "mock-ca.crt");
  const serverKey = join(certDir, "mock-server.key");
  const serverCsr = join(certDir, "mock-server.csr");
  const serverCert = join(certDir, "mock-server.crt");
  const extFile = join(certDir, "mock-server.ext");

  execFileSync("openssl", ["genrsa", "-out", caKey, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-x509", "-new", "-key", caKey, "-sha256", "-days", "2", "-out", caCert, "-subj", "/CN=Milestone Test Mock Upstream CA"], {
    stdio: "ignore",
  });
  execFileSync("openssl", ["genrsa", "-out", serverKey, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", "-key", serverKey, "-out", serverCsr, "-subj", "/CN=api.github.com"], { stdio: "ignore" });
  await writeFile(extFile, "subjectAltName=DNS:api.github.com\n");
  execFileSync(
    "openssl",
    ["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", serverCert, "-days", "2", "-sha256", "-extfile", extFile],
    { stdio: "ignore" },
  );

  const { readFile } = await import("node:fs/promises");
  const requestsReceived = [];
  const server = https.createServer({ cert: await readFile(serverCert), key: await readFile(serverKey) }, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requestsReceived.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/repos/octocat/hello-world") {
        res.end(JSON.stringify({ description: "A mock repo (via broker)", open_issues_count: 3 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "not found in mock upstream" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
  return { requestsReceived, close: () => server.close() };
}

/** A tiny, self-contained script (run via `docker exec node -e ...`) that speaks raw CONNECT+TLS+HTTP/1.1 to the broker directly, printing the response status line — used to exercise a request path the app itself never makes. */
function rawBrokerRequestScript(method, path) {
  return `
    const net = require("node:net");
    const tls = require("node:tls");
    const fs = require("node:fs");
    const caCert = fs.readFileSync("/tmp/berth-github-api-broker/ca.crt");
    const raw = net.connect(8092, "127.0.0.1", () => {
      raw.write("CONNECT api.github.com:443 HTTP/1.1\\r\\nHost: api.github.com:443\\r\\n\\r\\n");
    });
    let buf = "";
    raw.on("data", function onData(chunk) {
      buf += chunk.toString("utf-8");
      if (buf.includes("\\r\\n\\r\\n")) {
        raw.removeListener("data", onData);
        const tlsSocket = tls.connect({ socket: raw, servername: "api.github.com", ca: [caCert] }, () => {
          tlsSocket.write(${JSON.stringify(`${method} ${path} HTTP/1.1\r\nHost: api.github.com\r\nConnection: close\r\n\r\n`)});
        });
        let out = "";
        tlsSocket.on("data", (c) => (out += c.toString("utf-8")));
        tlsSocket.on("end", () => { process.stdout.write(out.split("\\r\\n")[0]); process.exit(0); });
        tlsSocket.on("error", (err) => { console.error(err); process.exit(1); });
      }
    });
    raw.on("error", (err) => { console.error(err); process.exit(1); });
  `;
}

async function execInContainer(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  let out = "";
  stdout.on("data", (chunk) => (out += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => process.stderr.write(`[exec stderr] ${chunk}`));
  await new Promise((resolve) => stream.on("end", resolve));
  return out;
}

async function startGrantsServer(dataDir) {
  const proc = spawn(process.execPath, [GRANTS_SERVER_ENTRY], {
    env: {
      ...process.env,
      BERTH_GRANTS_PORT: String(GRANTS_PORT),
      BERTH_GRANTS_HOST: "0.0.0.0",
      BERTH_GRANTS_DATA_DIR: dataDir,
      BERTH_GRANTS_OPERATOR_TOKEN: OPERATOR_TOKEN,
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
  // Terminates the attach options object docker-modem sends as this POST's
  // body straight into the container's stdin, so it can't concatenate onto the
  // first real request — see @berth/docker-orchestrator's stdio-rpc.ts for the
  // full explanation.
  stream.write("\n");
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
