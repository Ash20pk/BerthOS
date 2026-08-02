#!/usr/bin/env node
// Real, running verification of docs/mesh-reference.md's core claims: two
// independently-started containers — with NO shared Docker network passed to
// either (ruling out Crew.networked()'s existing Docker-bridge-DNS trick as
// the explanation) — reach each other over a real WireGuard tunnel (kernel
// wg0, or boringtun-cli userspace fallback) by a mesh-coordinator-assigned
// mesh IP, but ONLY when their declared network:peer:<name> capabilities
// mutually match. A third container that wants everyone (network:peer:*) but
// whom nobody names back must never be introduced to either. Also verifies
// the security-review fix this feature shipped with: even though the
// container itself gets NET_ADMIN (for mesh-daemon's benefit), the resident
// app's own process — after agent-init's capability bounding-set drop —
// cannot touch the network stack at that level.
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
const FIXTURES_DIR = join(__dirname, "fixtures");
const MESH_COORDINATOR_ENTRY = join(REPO_ROOT, "packages", "mesh-coordinator", "dist", "server.js");
const MESH_COORDINATOR_PORT = 56515;

const FIXTURES = {
  planner: { dir: join(FIXTURES_DIR, "mesh-echo-planner"), name: "mesh-echo-planner" },
  browser: { dir: join(FIXTURES_DIR, "mesh-echo-browser"), name: "mesh-echo-browser" },
  intruder: { dir: join(FIXTURES_DIR, "mesh-echo-intruder"), name: "mesh-echo-intruder" },
};

const docker = new Docker();

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-mesh-milestone-"));
  const coordinator = await startMeshCoordinator(dataDir);

  const running = {};
  try {
    for (const key of ["planner", "browser", "intruder"]) {
      const { dir, name } = FIXTURES[key];
      console.log(`\n--- Building ${name}'s dev image ---`);
      await buildImage({ appDir: dir, tag: `berth/${name}:dev`, target: "dev", docker });
    }

    // Registration order matters not at all for correctness (mutual-match is
    // symmetric), but starting planner/browser before intruder makes the
    // logs easier to read in order.
    for (const key of ["planner", "browser", "intruder"]) {
      const { dir, name } = FIXTURES[key];
      const manifest = await loadManifest(join(dir, "berth.yml"));
      console.log(`\n--- Booting "${name}" — no shared Docker network passed ---`);
      const container = await startContainer({
        image: `berth/${name}:dev`,
        name,
        manifest,
        bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
        workingDir: `/workspace/packages/docker-orchestrator/test/fixtures/${name}`,
        meshCoordinatorUrl: `http://host.docker.internal:${MESH_COORDINATOR_PORT}`,
        docker,
      });
      running[key] = { ...container, name, log: await startLogCapture(container.container) };
    }

    console.log("\n--- Waiting for each mesh-daemon to bring wg0 up ---");
    for (const key of ["planner", "browser", "intruder"]) {
      await waitFor(() => /\[mesh-daemon\] wg0 up:/.test(running[key].log.text()), 120000, `${running[key].name}'s wg0 to come up`);
      const upLine = running[key].log.text().match(/\[mesh-daemon\] wg0 up:.*$/m)?.[0] ?? "";
      console.log(`${running[key].name}: ${upLine}`);
    }

    console.log("\n--- Positive case: planner <-> browser must be mutually introduced ---");
    // Whichever of the two registered first saw an empty roster at boot (the
    // other hadn't registered yet) — the mutual introduction actually lands
    // via the 5s reconcile poll, not necessarily the initial registration
    // response. Wait for both logs to show it rather than asserting on the
    // boot-time snapshot alone.
    await waitFor(
      () => /\[mesh-daemon\] peer "mesh-echo-browser" -> 100\.64\.\d+\.\d+/.test(running.planner.log.text()),
      30000,
      'planner\'s log to show a mesh IP for "mesh-echo-browser"',
    );
    await waitFor(
      () => /\[mesh-daemon\] peer "mesh-echo-planner" -> 100\.64\.\d+\.\d+/.test(running.browser.log.text()),
      30000,
      'browser\'s log to show a mesh IP for "mesh-echo-planner"',
    );
    const plannerLog = running.planner.log.text();
    const browserLog = running.browser.log.text();
    const browserIpFromPlanner = plannerLog.match(/\[mesh-daemon\] peer "mesh-echo-browser" -> (100\.64\.\d+\.\d+)/)?.[1];
    const plannerIpFromBrowser = browserLog.match(/\[mesh-daemon\] peer "mesh-echo-planner" -> (100\.64\.\d+\.\d+)/)?.[1];
    console.log(`planner sees browser at ${browserIpFromPlanner}; browser sees planner at ${plannerIpFromBrowser}`);

    console.log("\n--- Negative case: intruder (network:peer:*) named nobody back — must be excluded from both ---");
    assert(!/peer "mesh-echo-intruder"/.test(plannerLog), "planner's wg0 must never have been given an intruder peer entry");
    assert(!/peer "mesh-echo-intruder"/.test(browserLog), "browser's wg0 must never have been given an intruder peer entry");
    assert(/\[mesh-daemon\] wg0 up: mesh IP [\d.]+, 0 peer\(s\)/.test(running.intruder.log.text()), "intruder should have been introduced to nobody");
    console.log("confirmed — mutual-match introduction correctly excluded the one-directional peer");

    console.log("\n--- Live reachability: fetch browser's echo server from inside planner, by mesh IP ---");
    // The route/peer just landed via the reconcile loop — the very first
    // WireGuard handshake over it can take a moment, so a single attempt
    // right away is occasionally too early (observed locally). Retrying a
    // few times still fails fast and hard if the tunnel is genuinely broken,
    // it just doesn't treat "the handshake hadn't finished yet" as that.
    let fetchOutput = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      fetchOutput = await execInContainer(running.planner.container, [
        "node",
        "-e",
        `fetch("http://${browserIpFromPlanner}:9000",{signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j))).catch(e=>{console.log("ERR:"+e.message);process.exitCode=1})`,
      ]);
      if (fetchOutput.includes('"from":"mesh-echo-browser"')) break;
      console.log(`attempt ${attempt}/5: ${fetchOutput.trim()}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    console.log("fetch result:", fetchOutput.trim());
    assert(fetchOutput.includes('"from":"mesh-echo-browser"'), `expected planner to reach browser's echo server over the mesh IP, got: ${fetchOutput}`);
    console.log("confirmed — real traffic crossed the WireGuard tunnel, not a Docker bridge (none was ever created)");

    console.log("\n--- Capability-drop verification: the resident app process itself must lack NET_ADMIN ---");
    for (const key of ["planner", "browser", "intruder"]) {
      const text = running[key].log.text();
      assert(
        new RegExp(`confirmed "${running[key].name}": this process cannot create network interfaces`).test(text),
        `expected ${running[key].name}'s own resident-app process to have no NET_ADMIN (capability bounding-set drop) — log:\n${text}`,
      );
    }
    console.log("confirmed for all three — NET_ADMIN (granted at the container level for mesh-daemon) never reached any resident app's own process");

    console.log(
      "\nPASS — two mutually-matched containers reached each other over a real WireGuard tunnel by mesh-coordinator-" +
        "assigned mesh IP with no shared Docker network, a one-directional peer was correctly excluded from both, and " +
        "the resident app processes themselves never inherited the container-level NET_ADMIN grant.",
    );
  } finally {
    for (const key of Object.keys(running)) {
      await running[key].log.stop();
      await stopContainer(running[key].container);
    }
    coordinator.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function startMeshCoordinator(dataDir) {
  const proc = spawn(process.execPath, [MESH_COORDINATOR_ENTRY], {
    env: {
      ...process.env,
      BERTH_MESH_COORDINATOR_PORT: String(MESH_COORDINATOR_PORT),
      BERTH_MESH_COORDINATOR_HOST: "0.0.0.0",
      BERTH_MESH_COORDINATOR_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ready = false;
  proc.stdout.on("data", (chunk) => {
    if (chunk.toString("utf-8").includes("listening on")) ready = true;
  });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[berth-mesh-coordinator] ${chunk}`));

  await waitFor(() => ready, 10000, "berth-mesh-coordinator to start listening");
  return proc;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function execInContainer(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  let out = "";
  stdout.on("data", (chunk) => (out += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (out += chunk.toString("utf-8")));
  await new Promise((resolve) => stream.on("end", resolve));
  return out;
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
    console.error("\nMESH MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
