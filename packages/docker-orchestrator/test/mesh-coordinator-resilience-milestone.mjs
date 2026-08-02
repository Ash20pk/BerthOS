#!/usr/bin/env node
// Real, running verification of mesh-daemon's documented degrade path
// (packages/mesh-daemon/src/main.rs's reconcile_loop): "reconcile poll
// failed (...) — keeping last known peer set" is a comment and a log line
// today, never exercised by a test that actually kills mesh-coordinator.
// This test does exactly that — establishes a real mutually-matched
// WireGuard tunnel between two containers (same setup as mesh-milestone.mjs,
// trimmed to two peers), kills the coordinator process mid-reconcile with a
// real SIGKILL, and proves three things a crash could plausibly break:
// mesh-daemon logs the degrade rather than panicking or hanging, the
// already-established tunnel keeps carrying real traffic while the
// coordinator is down (the reconcile loop's failure must not tear down
// wg0's existing config), and the daemon self-heals once the coordinator
// comes back — without the container itself ever restarting.
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
const MESH_COORDINATOR_PORT = 56516; // distinct from mesh-milestone.mjs's port — safe to run concurrently

const FIXTURES = {
  planner: { dir: join(FIXTURES_DIR, "mesh-echo-planner"), name: "mesh-echo-planner" },
  browser: { dir: join(FIXTURES_DIR, "mesh-echo-browser"), name: "mesh-echo-browser" },
};

const docker = new Docker();

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-mesh-resilience-milestone-"));
  let coordinator = await startMeshCoordinator(dataDir);

  const running = {};
  try {
    for (const key of ["planner", "browser"]) {
      const { dir, name } = FIXTURES[key];
      console.log(`\n--- Building ${name}'s dev image ---`);
      await buildImage({ appDir: dir, tag: `berth/${name}:dev`, target: "dev", docker });
    }

    for (const key of ["planner", "browser"]) {
      const { dir, name } = FIXTURES[key];
      const manifest = await loadManifest(join(dir, "berth.yml"));
      console.log(`\n--- Booting "${name}" ---`);
      const container = await startContainer({
        image: `berth/${name}:dev`,
        // Deliberately NOT suffixed (e.g. "-resilience"): this becomes
        // BERTH_MESH_PEER_NAME, which mutual-match compares against the
        // OTHER fixture's hardcoded `network:peer:mesh-echo-<name>`
        // capability pattern (see fixtures/mesh-echo-*/berth.yml) — a
        // suffixed name would never match and mutual introduction would
        // never happen. Safe to reuse mesh-milestone.mjs's exact container
        // names since the two tests never run concurrently and both clean
        // up their containers in `finally`.
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
    for (const key of ["planner", "browser"]) {
      await waitFor(() => /\[mesh-daemon\] wg0 up:/.test(running[key].log.text()), 120000, `${running[key].name}'s wg0 to come up`);
    }

    console.log("\n--- Waiting for the mutual introduction to land via reconcile ---");
    await waitFor(
      () => /\[mesh-daemon\] peer "mesh-echo-browser" -> 100\.64\.\d+\.\d+/.test(running.planner.log.text()),
      30000,
      'planner\'s log to show a mesh IP for "mesh-echo-browser"',
    );
    const browserIpFromPlanner = running.planner.log.text().match(/\[mesh-daemon\] peer "mesh-echo-browser" -> (100\.64\.\d+\.\d+)/)?.[1];
    console.log(`planner sees browser at ${browserIpFromPlanner}`);

    console.log("\n--- Baseline: confirm real traffic crosses the tunnel BEFORE killing the coordinator ---");
    const baselineFetch = await fetchEchoWithRetry(running.planner.container, browserIpFromPlanner);
    assert(baselineFetch.includes('"from":"mesh-echo-browser"'), `expected baseline connectivity before the kill, got: ${baselineFetch}`);
    console.log("confirmed — tunnel is live before the coordinator is touched");

    const planLogLengthBeforeKill = running.planner.log.text().length;

    console.log("\n--- Killing mesh-coordinator with a real SIGKILL (not a graceful stop) ---");
    coordinator.kill("SIGKILL");
    await waitFor(() => coordinator.killed || coordinator.exitCode !== null, 10000, "mesh-coordinator process to actually exit");

    console.log("\n--- Test 1: mesh-daemon must detect the failure and degrade, not hang or panic ---");
    await waitFor(
      () => running.planner.log.text().slice(planLogLengthBeforeKill).includes("reconcile poll failed"),
      20000,
      'planner\'s mesh-daemon to log a "reconcile poll failed" warning after the coordinator died',
    );
    assert(
      !running.planner.log.text().slice(planLogLengthBeforeKill).includes("PANIC"),
      "mesh-daemon must not panic when mesh-coordinator disappears mid-reconcile",
    );
    assert(
      running.planner.log.text().slice(planLogLengthBeforeKill).includes("keeping last known peer set"),
      'expected the documented degrade message ("keeping last known peer set") in the log after the kill',
    );
    console.log('PASS — mesh-daemon logged "reconcile poll failed ... keeping last known peer set" and did not panic.');

    console.log("\n--- Test 2: the ALREADY-ESTABLISHED tunnel must keep working while the coordinator is down ---");
    // The real question: does a failed reconcile leave wg0's existing
    // config alone (correct), or does something in the failure path
    // inadvertently tear it down? Multiple attempts spanning >1 reconcile
    // tick (5s) make sure this isn't just "the old connection happened to
    // still be up for a few seconds."
    for (let i = 0; i < 3; i++) {
      const duringOutageFetch = await fetchEchoWithRetry(running.planner.container, browserIpFromPlanner);
      assert(
        duringOutageFetch.includes('"from":"mesh-echo-browser"'),
        `expected the tunnel to keep working while mesh-coordinator is down (attempt ${i + 1}/3), got: ${duringOutageFetch}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    console.log("PASS — the pre-established WireGuard tunnel kept carrying real traffic through the entire coordinator outage.");

    console.log("\n--- Restarting mesh-coordinator (same data dir — real persisted peer registrations reload from SQLite) ---");
    const planLogLengthBeforeRestart = running.planner.log.text().length;
    coordinator = await startMeshCoordinator(dataDir);

    console.log("\n--- Test 3: mesh-daemon must self-heal once the coordinator comes back, no container restart ---");
    await waitFor(
      () => /reconcile tick #\d+: poll returned \d+ peer\(s\)/.test(running.planner.log.text().slice(planLogLengthBeforeRestart)),
      20000,
      "planner's mesh-daemon to log a successful reconcile poll after the coordinator restarted",
    );
    console.log("PASS — mesh-daemon resumed successful reconciles against the restarted coordinator without any container restart.");

    const recoveredFetch = await fetchEchoWithRetry(running.planner.container, browserIpFromPlanner);
    assert(recoveredFetch.includes('"from":"mesh-echo-browser"'), `expected connectivity after coordinator recovery, got: ${recoveredFetch}`);
    console.log("confirmed — tunnel still works after recovery.");

    console.log(
      "\nALL PASS — mesh-daemon survives a real coordinator crash mid-reconcile: it degrades loudly instead of hanging " +
        "or panicking, the already-established tunnel is unaffected by the outage, and it self-heals once the " +
        "coordinator returns.",
    );
  } catch (err) {
    for (const key of Object.keys(running)) {
      console.error(`\n--- FULL ${running[key].name} container log (failure) ---\n${running[key].log.text()}`);
    }
    throw err;
  } finally {
    for (const key of Object.keys(running)) {
      await running[key].log.stop();
      await stopContainer(running[key].container).catch(() => {});
    }
    coordinator.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function fetchEchoWithRetry(container, ip) {
  let output = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    output = await execInContainer(container, [
      "node",
      "-e",
      `fetch("http://${ip}:9000",{signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j))).catch(e=>{console.log("ERR:"+e.message);process.exitCode=1})`,
    ]);
    if (output.includes('"from":"mesh-echo-browser"')) return output;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return output;
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
    console.error("\nMESH COORDINATOR RESILIENCE MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
