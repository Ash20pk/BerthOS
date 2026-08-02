#!/usr/bin/env node
// Real, running verification of @berth/adapter-k8s against a live (if
// throwaway) Kubernetes cluster — provisioned via `kind` (Kubernetes-in-
// Docker), which needs no cloud account, unlike adapter-e2b (zero tests,
// real or mocked) and adapter-daytona (mocked-only) — both need paid live
// accounts for anything beyond that. Exercises the full DeployAdapter
// lifecycle for real: upload (no-op) -> start (creates a real Pod) ->
// status transitions to running -> list sees it -> streamLogs yields real
// container output -> previewUrl() creates a real Service whose DNS name
// actually resolves inside the cluster -> teardown deletes it.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Docker from "dockerode";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage } from "@berth/docker-orchestrator";
import { createK8sAdapter } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const CLUSTER_NAME = "berth-adapter-k8s-milestone";
const IMAGE_TAG = "berth/filesystem:k8s-milestone";

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log(`\n--- Creating throwaway kind cluster "${CLUSTER_NAME}" ---`);
  await execFileAsync("kind", ["create", "cluster", "--name", CLUSTER_NAME]);

  try {
    console.log("\n--- Building filesystem's production image ---");
    await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: IMAGE_TAG, target: "production", docker: new Docker() });

    console.log(`\n--- Loading the image into the kind cluster's node ---`);
    await execFileAsync("kind", ["load", "docker-image", IMAGE_TAG, "--name", CLUSTER_NAME]);

    const adapter = createK8sAdapter();

    console.log("\n--- Test 1: upload() is a documented no-op returning the same imageRef ---");
    const { remoteImageRef } = await adapter.upload({ imageRef: IMAGE_TAG, manifest });
    assert(remoteImageRef === IMAGE_TAG, `expected upload() to pass the imageRef through unchanged, got ${remoteImageRef}`);

    console.log("\n--- Test 2: start() creates a real Pod, status transitions to running ---");
    const handle = await adapter.start(remoteImageRef, { imageRef: remoteImageRef, manifest });
    console.log("started pod:", handle.id);

    let finalStatus;
    for (let i = 0; i < 30; i++) {
      finalStatus = await handle.status();
      if (finalStatus === "running") break;
      await sleep(1000);
    }
    assert(finalStatus === "running", `expected the Pod to reach "running" within 30s, last saw "${finalStatus}"`);
    console.log("PASS — status() reached running.");

    console.log("\n--- Test 3: list() sees the real running Pod ---");
    const listed = await adapter.list();
    assert(
      listed.some((h) => h.id === handle.id),
      `expected list() to include ${handle.id}, got: ${listed.map((h) => h.id).join(", ")}`,
    );
    console.log("PASS — list() includes the Pod started above.");

    console.log("\n--- Test 4: streamLogs() yields real container output ---");
    const collected = await collectLogsFor(handle, 15000, /"filesystem" ready|listening on/);
    assert(collected.matched, `expected to see real runtime startup output in the streamed logs, got: ${JSON.stringify(collected.text)}`);
    console.log("PASS — streamLogs() carried real output from the container:\n" + collected.text.trim());

    console.log("\n--- Test 5: previewUrl() creates a real Service whose DNS name resolves inside the cluster ---");
    const previewPort = 8080;
    const previewUrl = await adapter.previewUrl(handle, previewPort);
    assert(previewUrl, "expected previewUrl() to return an in-cluster DNS name, got null");
    assert(previewUrl.endsWith(`:${previewPort}`), `expected previewUrl to end with ":${previewPort}", got ${previewUrl}`);
    const dnsName = previewUrl.slice(0, previewUrl.lastIndexOf(":"));
    console.log("preview DNS name:", dnsName);

    // Resolve the Service's DNS name from *inside* the cluster (cluster DNS
    // is only reachable there, not from the host running kind) — reuses the
    // already-running filesystem Pod itself as the lookup point, via a
    // plain `node -e` dns.lookup() call, since every Berth image already
    // has Node installed. Kubernetes creates a real ClusterIP + DNS entry
    // for a Service regardless of whether anything's actually listening on
    // the target port yet, so this proves Service creation and DNS wiring
    // are real without needing filesystem to run a server on previewPort.
    const dnsCheckScript = `require('dns').lookup(${JSON.stringify(dnsName)},(e,a)=>{if(e){console.error(e.message);process.exit(1);}console.log(a);process.exit(0);})`;
    const { stdout: dnsStdout } = await execFileAsync("kubectl", [
      "--context",
      `kind-${CLUSTER_NAME}`,
      "exec",
      handle.id,
      "--",
      "node",
      "-e",
      dnsCheckScript,
    ]);
    assert(dnsStdout.trim().length > 0, "expected the preview Service's DNS name to resolve to a real address inside the cluster");
    console.log("PASS — previewUrl()'s Service DNS name resolved inside the cluster to", dnsStdout.trim());

    console.log("\n--- Test 6: teardown() deletes the real Pod ---");
    await adapter.teardown(handle);
    // deleteNamespacedPod() only *starts* a graceful termination (bound by
    // the Pod's terminationGracePeriodSeconds, 30s by default) - it doesn't
    // block until the kubelet confirms the container is actually gone, so
    // the Pod can legitimately still show as Terminating for a while after
    // teardown() itself has already returned. Poll for real removal rather
    // than assuming one fixed sleep is always enough, same pattern as the
    // status-transitions-to-running wait above.
    let remaining = "";
    for (let i = 0; i < 30; i++) {
      const { stdout } = await execFileAsync("kubectl", [
        "--context",
        `kind-${CLUSTER_NAME}`,
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/managed-by=berth",
        "--no-headers",
        "--ignore-not-found",
      ]);
      remaining = stdout.trim();
      if (remaining === "") break;
      await sleep(1000);
    }
    assert(remaining === "", `expected no berth-managed Pods left after teardown() within 30s, got: ${remaining}`);
    console.log("PASS — teardown() removed the Pod for real.");

    console.log(
      "\nALL PASS — @berth/adapter-k8s's full DeployAdapter lifecycle (upload/start/status/list/streamLogs/previewUrl/teardown) " +
        "works against a real, live Kubernetes API, not a mock.",
    );
  } finally {
    console.log(`\n--- Deleting the throwaway kind cluster ---`);
    await execFileAsync("kind", ["delete", "cluster", "--name", CLUSTER_NAME]).catch(() => {});
  }
}

async function collectLogsFor(handle, timeoutMs, matchPattern) {
  let text = "";
  let matched = false;
  const deadline = Date.now() + timeoutMs;
  for await (const chunk of handle.streamLogs()) {
    text += chunk;
    if (matchPattern.test(text)) {
      matched = true;
      break;
    }
    if (Date.now() > deadline) break;
  }
  return { text, matched };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nK8S ADAPTER MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
