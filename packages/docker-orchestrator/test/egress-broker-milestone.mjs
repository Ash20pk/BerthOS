#!/usr/bin/env node
// Real, running verification of the egress broker
// (packages/docker-orchestrator/docker/egress-broker.js), which enforces
// browser:navigate:<pattern> at the host level.
//
// Two parts:
//   Part A runs the actual shipped broker script directly (no Docker) with
//   a hand-written capability policy declaring a NARROW pattern, and proves
//   both outcomes for real: an in-scope host's CONNECT tunnel succeeds
//   (200), an out-of-scope host's is refused (403). browser-native's own
//   real manifest declares browser:navigate:* (any host, since it's meant
//   to navigate wherever the agent points it) — the wildcard match would
//   make a denial untestable against the real app, so this part is what
//   actually exercises the broker's host-matching/refusal logic for real.
//
//   Part B boots the real browser-native sandbox and drives an actual
//   Chromium navigation through the broker, confirming end-to-end wiring:
//   the proxy option really routes traffic through the broker (visible in
//   the broker's own allow-log line), not around it.
import Docker from "dockerode";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const BROKER_SCRIPT = join(__dirname, "..", "docker", "egress-broker.cjs");
const BROWSER_NATIVE_APP_DIR = join(REPO_ROOT, "apps", "browser-native");

const docker = new Docker();

async function main() {
  await runPartA();
  await runPartB();
}

async function runPartA() {
  console.log("\n=== Part A: broker host-matching, run directly (no Docker) ===");
  const dataDir = await mkdtemp(join(tmpdir(), "berth-egress-broker-milestone-"));
  const policyPath = join(dataDir, "capability-policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      appName: "scoped-test-app",
      declaredCapabilities: ["browser:navigate:example.com", "browser:navigate:*.example.org"],
      writePaths: [],
      readPaths: [],
      networkPorts: [],
      networkUnrestricted: false,
    }),
  );

  const port = 58090;
  const broker = spawn(process.execPath, [BROKER_SCRIPT], {
    env: { ...process.env, BERTH_EGRESS_BROKER_PORT: String(port), BERTH_CAPABILITY_POLICY: policyPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));

  try {
    await waitFor(() => stderr.includes("listening on"), 5000, "broker to start listening");
    console.log(stderr.trim());
    assert(stderr.includes("example.com") && stderr.includes("*.example.org"), "broker didn't log the expected declared patterns");

    console.log("\n--- CONNECT to an in-scope host (example.com) ---");
    const allowed = await connectThroughProxy(port, "example.com", 443);
    console.log(`status: ${allowed.statusCode}`);
    assert(allowed.statusCode === 200, `expected 200 for an in-scope host, got ${allowed.statusCode}`);

    console.log("\n--- CONNECT to an out-of-scope host (evil-not-declared.test) ---");
    const denied = await connectThroughProxy(port, "evil-not-declared.test", 443);
    console.log(`status: ${denied.statusCode}`);
    assert(denied.statusCode === 403, `expected 403 for an out-of-scope host, got ${denied.statusCode}`);

    console.log("\nPASS — the broker allowed an in-scope host and refused an out-of-scope one, for real.");
  } finally {
    broker.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function runPartB() {
  console.log("\n=== Part B: real browser-native sandbox, Chromium routed through the broker ===");
  const manifest = await loadManifest(join(BROWSER_NATIVE_APP_DIR, "berth.yml"));

  console.log("Building browser-native's dev image...");
  await buildImage({ appDir: BROWSER_NATIVE_APP_DIR, tag: "berth/browser-native:dev", target: "dev", docker });

  console.log("Starting browser-native's sandbox (headless, BERTH_TEST_MODE=1)...");
  const running = await startContainer({
    image: "berth/browser-native:dev",
    name: "berth-egress-broker-milestone-browser-native",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/browser-native",
    env: { BERTH_TEST_MODE: "1" },
    docker,
  });

  const containerLog = await startLogCapture(running.container);
  try {
    await waitFor(() => /\[egress-broker\] listening on/.test(containerLog.text()), 20000, "egress broker to start");
    await waitFor(() => /"browser-native" ready/.test(containerLog.text()), 20000, "browser-native runtime ready");

    const rpc = await createRpcClient(running.container);
    console.log("\n--- Navigating to a real page through the broker ---");
    const navigateResult = await rpc.call({ id: "1", export: "navigate", input: { url: "https://example.com" } });
    console.log("navigate response:", navigateResult);
    assert(!navigateResult.error, `expected navigate to succeed, got error: ${navigateResult.error}`);

    const textResult = await rpc.call({ id: "2", export: "get_page_text" });
    console.log("get_page_text response:", textResult);
    assert(!textResult.error, `expected get_page_text to succeed, got error: ${textResult.error}`);
    assert((textResult.result?.text ?? "").length > 0, "expected a non-empty page text — the real page didn't load");

    const brokerLog = containerLog.text().match(/\[egress-broker\] \{"event":"navigate_allowed".*example\.com.*$/m)?.[0];
    console.log("\nbroker allow-log line:", brokerLog ?? "(none found)");
    assert(brokerLog, "expected the broker's own allow-log for example.com — Chromium's traffic may be bypassing the broker entirely");

    rpc.close();
    console.log("\nPASS — Chromium's real navigation was actually routed through the egress broker, which allowed it and logged the decision.");
  } catch (err) {
    console.error("\n--- browser-native container log (Part B failure) ---");
    console.error(containerLog.text());
    throw err;
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function connectThroughProxy(port, host, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const statusLine = buffer.split("\r\n")[0];
      const match = statusLine?.match(/^HTTP\/1\.1 (\d+)/);
      if (match) {
        socket.destroy();
        resolve({ statusCode: Number(match[1]) });
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`timed out waiting for a CONNECT response for ${host}:${targetPort}`));
    });
  });
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
        // Deliberately above Playwright's own default navigation timeout
        // (30000ms) — this call wraps a real page.goto() inside the
        // container, and with the two clocks equal there was no margin for
        // RPC/Docker-stdio round-trip overhead or CI's slower compute. A run
        // that's genuinely slow-but-working got killed by this timer before
        // Playwright's own timeout could produce a real, diagnosable error,
        // which is exactly what made a prior CI failure look like an opaque
        // hang instead of a clear navigation-timeout message.
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 45000);
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
    console.error("\nEGRESS BROKER MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
