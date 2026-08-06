#!/usr/bin/env node
// Real, running verification of the human-approval workflow described in
// docs/capability-tokens-reference.md: a capability NOT declared in
// berth.yml, approved via a real running @berth/grants-server + the
// `berth grants approve` HTTP contract, actually lands in the effective
// capability policy generate-capability-policy.ts writes at the app's next
// boot. This is the "does approval actually gate anything" question,
// answered with a real round trip instead of code inspection.
//
// apps/filesystem/berth.yml declares no network:* capability today, so
// granting it network:connect:8443 here is a genuine addition, not
// something that would show up anyway.
import Docker from "dockerode";
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
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const GRANTS_SERVER_ENTRY = join(REPO_ROOT, "packages", "grants-server", "dist", "server.js");
const GRANTS_PORT = 56514;
const GRANTED_CAPABILITY = "network:connect:8443";
const OPERATOR_TOKEN = "milestone-test-operator-token";

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));
  assert(
    !manifest.capabilities.includes(GRANTED_CAPABILITY),
    `test setup bug: apps/filesystem already declares ${GRANTED_CAPABILITY} statically — pick a capability it doesn't declare`,
  );

  const dataDir = await mkdtemp(join(tmpdir(), "berth-grants-milestone-"));
  const grantsServer = await startGrantsServer(dataDir);

  try {
    console.log(`\n--- Requesting ${GRANTED_CAPABILITY} for "filesystem" (starts pending) ---`);
    const created = await grantsFetch("/grants", {
      method: "POST",
      body: JSON.stringify({ appName: "filesystem", capability: GRANTED_CAPABILITY, reason: "milestone test" }),
    });
    console.log("created:", created);
    assert(created.status === "pending", `expected a fresh grant to be pending, got ${created.status}`);

    console.log(`\n--- Confirming a requester can't self-approve without the operator token (gap #27) ---`);
    const selfApproveAttempt = await fetch(`http://127.0.0.1:${GRANTS_PORT}/grants/${created.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "filesystem" }),
    });
    assert(selfApproveAttempt.status === 401, `expected a token-less approve to be rejected with 401, got ${selfApproveAttempt.status}`);

    console.log(`\n--- Approving grant ${created.id} via the same HTTP contract "berth grants approve" uses ---`);
    const approved = await grantsFetch(`/grants/${created.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      body: JSON.stringify({ decidedBy: "milestone-test" }),
    });
    console.log("approved:", approved);
    assert(approved.status === "approved", `expected approval to stick, got ${approved.status}`);

    console.log("\n--- Building filesystem's dev image ---");
    await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });

    console.log("\n--- Booting filesystem's sandbox with BERTH_GRANTS_SERVER_URL set ---");
    const running = await startContainer({
      image: "berth/filesystem:dev",
      name: "berth-grants-milestone-filesystem",
      manifest,
      bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
      workingDir: "/workspace/apps/filesystem",
      env: { BERTH_GRANTS_SERVER_URL: `http://host.docker.internal:${GRANTS_PORT}` },
      docker,
    });

    const containerLog = await startLogCapture(running.container);
    try {
      await waitFor(() => /\[berth:capability-policy\] wrote/.test(containerLog.text()), 20000, "capability policy to be written");

      const policyLine = containerLog.text().match(/\[berth:capability-policy\] wrote.*$/m)?.[0] ?? "";
      console.log("\npolicy line:", policyLine);
      assert(
        policyLine.includes("networkPorts=8443") || /networkPorts=.*\b8443\b/.test(policyLine),
        `expected the approved ${GRANTED_CAPABILITY} to appear in the written policy's networkPorts — it didn't. ` +
          `Either the grants-server round trip or generate-capability-policy.ts's fetchApprovedCapabilities() regressed: ${policyLine || "(no policy line seen)"}`,
      );

      await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");
      console.log("\nPASS — a capability approved through a real running grants-server after the fact landed in " +
        "the effective policy at the app's next boot, exactly as docs/capability-tokens-reference.md describes.");
    } finally {
      await containerLog.stop();
      await stopContainer(running.container);
    }
  } finally {
    grantsServer.kill();
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
    console.error("\nGRANTS SERVER MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
