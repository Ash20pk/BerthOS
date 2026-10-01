#!/usr/bin/env node
// `berth attest <runId>` emits a per-run record binding the
// audit-chain head, enforcement AS MEASURED for the boot, the enforced
// capability-policy hash, boot id, and image digest — and the standalone
// verifier (scripts/verify-attestation.mjs, no Berth dependency) accepts the
// genuine record and rejects edited ones. Two boots of the same fixture:
//
//   Measured boot — whatever this host really is:
//     1. `berth attest` exits 0 and the record parses;
//     2. the standalone verifier accepts it;
//     3. enforcement.status equals what this test measures INDEPENDENTLY
//        (probeKernel + agent-init's own ruleset line in `docker logs`) —
//        ACTIVE on an enforcing host (Colima/CI), NOT_ENFORCED on Docker
//        Desktop. Neither outcome is a failure; a *mismatch* is.
//     4. boot.bootId matches the entrypoint's logged boot id;
//        boot.imageDigest matches `docker inspect`;
//        policies[].sha256 matches an in-container `sha256sum` re-run;
//        auditChain.head matches verifyAuditChain over the cited file;
//        run.records counts exactly the records with meta.runId === runId.
//     5. Tamper (hand-edit): flipping boot.imageDigest → verifier rejects
//        (self-hash breaks).
//     6. Tamper (verdict upgrade WITH recomputed self-hash): setting
//        enforcement.status to a verdict the embedded measurements don't
//        support → verifier rejects (derivation mismatch). This is what
//        makes the verdict field not worth editing.
//
//   Control boot — the negative control IS the feature:
//     7. the same app booted under a seccomp profile that ENOSYSes the
//        landlock syscalls (the same shape Docker Desktop's linuxkit kernel
//        presents — see capability-enforcement.mjs's header) attests
//        NOT_ENFORCED, with agent-init's NotEnforced report named in
//        reasons[]. Proves an attestation can say no — a record that can
//        only ever read ACTIVE proves nothing.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { loadManifest } from "@berthos/manifest-schema";
import { createFileAuditSink, readAuditFile, verifyAuditChain, attestationDigest } from "@berthos/audit";
import Docker from "dockerode";
import { buildImage, checkoutTag, startContainer, stopContainer, probeKernel } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(__dirname, "fixtures", "boundary-app-a");
const APP_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-a";
const IMAGE_TAG = checkoutTag("berth/boundary-app-a:dev", APP_DIR);
const CONTAINER_NAME = "berth-attestation-milestone";
const DEV_WORKSPACE = "/workspace/.berth/dev-workspace";
const DEV_WORKSPACE_HOST_DIR = join(REPO_ROOT, ".berth", "dev-workspace");
const BERTH_CLI = join(REPO_ROOT, "packages", "cli", "bin", "berth.js");
const VERIFIER = join(REPO_ROOT, "scripts", "verify-attestation.mjs");
const RUN_ID = "attestation-milestone-run";

// Allow everything, refuse only Landlock — the minimal seccomp profile that
// turns an enforcing kernel into a Docker-Desktop-shaped one (syscall table
// says ENOSYS, everything else untouched). errnoRet 38 = ENOSYS.
const NO_LANDLOCK_SECCOMP = JSON.stringify({
  defaultAction: "SCMP_ACT_ALLOW",
  syscalls: [
    {
      names: ["landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self"],
      action: "SCMP_ACT_ERRNO",
      errnoRet: 38,
    },
  ],
});

let failures = 0;
function check(what, ok, extra) {
  if (ok) console.log(`  PASS  ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`);
  }
}

async function execCapture(docker, container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  const chunks = [];
  stdout.on("data", (c) => chunks.push(c));
  await new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf-8");
}

async function containerLogs(container) {
  const buf = await container.logs({ stdout: true, stderr: true, follow: false, tail: 10000 });
  // Strip docker's 8-byte multiplexing headers the blunt way — we only grep.
  return Buffer.from(buf).toString("utf-8");
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function runCli(args, env) {
  try {
    const stdout = execFileSync("node", [BERTH_CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf-8" });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function runVerifier(path) {
  try {
    return { code: 0, output: execFileSync("node", [VERIFIER, path], { encoding: "utf-8" }) };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

async function boot(docker, { extraSecurityOpt } = {}) {
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));
  return startContainer({
    image: IMAGE_TAG,
    name: CONTAINER_NAME,
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: APP_CONTAINER_DIR,
    env: { BERTH_WORKSPACE_ROOT: DEV_WORKSPACE },
    apps: [{ name: "boundary-app-a", workingDir: APP_CONTAINER_DIR, manifest }],
    ...(extraSecurityOpt ? { extraSecurityOpt } : {}),
    docker,
  });
}

async function waitForRulesetReport(docker, container) {
  let report;
  await waitFor(async () => {
    const logs = await containerLogs(container);
    for (const line of logs.split("\n")) {
      const idx = line.indexOf("{");
      if (idx === -1) continue;
      try {
        const event = JSON.parse(line.slice(idx));
        if (event.source === "agent-init" && event.event === "capability_policy_applied" && event.app === "boundary-app-a") {
          report = event;
          return true;
        }
      } catch {
        /* not this line */
      }
    }
    return false;
  }, 90000, "agent-init's capability_policy_applied report");
  return report;
}

async function attestAndRead(auditPath, outPath, berthHome) {
  const result = runCli(
    [
      "attest",
      RUN_ID,
      "--container",
      CONTAINER_NAME,
      "--image",
      IMAGE_TAG,
      "--file",
      auditPath,
      "--out",
      outPath,
    ],
    { BERTH_HOME: berthHome },
  );
  if (result.code !== 0) throw new Error(`berth attest failed: ${result.output}`);
  return JSON.parse(await readFile(outPath, "utf-8"));
}

async function main() {
  const docker = new Docker();
  await mkdir(join(REPO_ROOT, ".berth"), { recursive: true });
  await mkdir(join(DEV_WORKSPACE_HOST_DIR, "boundary-app-a"), { recursive: true });
  const workDir = await mkdtemp(join(REPO_ROOT, ".berth", "attestation-milestone-"));
  const berthHome = join(workDir, "berth-home"); // isolates the probe cache from the developer's real ~/.berth
  const auditPath = join(workDir, "audit.jsonl");

  // A small audit trail with this run's records surrounded by unrelated ones,
  // written by the real file sink — the same chain `berth audit verify` walks.
  const sink = createFileAuditSink({ path: auditPath });
  const actor = { kind: "agent", id: "milestone", verifiedBy: "self-asserted" };
  await sink.record({ ts: new Date().toISOString(), seq: 0, actor, action: "governance.evaluate", decision: "allowed" });
  for (const step of [1, 2, 3]) {
    await sink.record({
      ts: new Date().toISOString(),
      seq: 0,
      actor,
      action: "agent.tool-call",
      target: `tool:step-${step}`,
      decision: "allowed",
      meta: { runId: RUN_ID, nonce: randomBytes(4).toString("hex") },
    });
  }
  await sink.record({ ts: new Date().toISOString(), seq: 0, actor, action: "grant.approve", decision: "denied", reason: "milestone noise" });

  console.log("--- Building the fixture's dev image ---");
  await buildImage({ appDir: APP_DIR, tag: IMAGE_TAG, target: "dev", docker });
  await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});

  console.log("\n=== Measured boot: attest what this host really is ===");
  const running = await boot(docker);
  try {
    const report = await waitForRulesetReport(docker, running.container);
    const probe = await probeKernel(docker, IMAGE_TAG);
    const expected = probe.status === "enforcing" && report.ruleset === "FullyEnforced" ? "ACTIVE" : "NOT_ENFORCED";
    console.log(`(independent measurement: probe=${probe.status}, agent-init ruleset=${report.ruleset} → expecting ${expected})`);

    const outPath = join(workDir, "run.attestation.json");
    const record = await attestAndRead(auditPath, outPath, berthHome);

    check("1. berth attest exits 0 and the record parses", record.kind === "berth.attestation");

    const accepted = runVerifier(outPath);
    check("2. the standalone verifier accepts the genuine record", accepted.code === 0, accepted.output);

    check(
      `3. enforcement.status matches the independent measurement (${expected})`,
      record.enforcement.status === expected,
      `record says ${record.enforcement.status}`,
    );

    const logs = await containerLogs(running.container);
    const loggedBootId = [...logs.matchAll(/\[berth:entrypoint\] boot id: (\S+)/g)].map((m) => m[1]).pop();
    check("4a. boot.bootId matches the entrypoint's logged boot id", record.boot.bootId === loggedBootId, `record ${record.boot.bootId}, log ${loggedBootId}`);

    const inspected = await running.container.inspect();
    check(
      "4b. boot.imageDigest matches docker inspect",
      record.boot.imageDigest === inspected.Image || record.boot.imageDigest.includes("sha256:"),
      `record ${record.boot.imageDigest}, inspect ${inspected.Image}`,
    );

    const policyPath = record.policies.find((p) => p.app === "boundary-app-a")?.path;
    const rehash = policyPath ? (await execCapture(docker, running.container, ["sha256sum", policyPath])).slice(0, 64) : "no-policy-row";
    check(
      "4c. policies[].sha256 matches an in-container sha256sum re-run",
      record.policies.some((p) => p.app === "boundary-app-a" && p.sha256 === rehash),
      `record ${JSON.stringify(record.policies)}, re-run ${rehash}`,
    );

    const chain = verifyAuditChain(readAuditFile(auditPath));
    check("4d. auditChain.head matches verifyAuditChain over the cited file", chain.valid && record.auditChain.head === chain.endHash);
    check("4e. run.records counts exactly this run's records", record.run.records === 3, `got ${record.run.records}`);

    // 5. Hand-edit: any field change breaks the self-hash.
    const editedPath = join(workDir, "edited.attestation.json");
    await writeFile(editedPath, JSON.stringify({ ...record, boot: { ...record.boot, imageDigest: "sha256:" + "0".repeat(64) } }, null, 2));
    const editedResult = runVerifier(editedPath);
    check("5. verifier rejects a hand-edited record (self-hash)", editedResult.code !== 0, "verifier accepted an edited record");

    // 6. Verdict upgrade with a recomputed self-hash: still rejected, because
    // the stated status no longer follows from the embedded measurements.
    const upgradedStatus = record.enforcement.status === "ACTIVE" ? "NOT_ENFORCED" : "ACTIVE";
    const forged = { ...record, enforcement: { ...record.enforcement, status: upgradedStatus, reasons: [] } };
    forged.recordSha256 = attestationDigest(forged);
    const forgedPath = join(workDir, "forged.attestation.json");
    await writeFile(forgedPath, JSON.stringify(forged, null, 2));
    const forgedResult = runVerifier(forgedPath);
    check("6. verifier rejects a verdict edit even with a recomputed self-hash", forgedResult.code !== 0, "verifier accepted a forged verdict");
  } finally {
    await stopContainer(running.container).catch(() => {});
    await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
  }

  console.log("\n=== Control boot: same app, landlock syscalls ENOSYSed — the negative control is the feature ===");
  const control = await boot(docker, { extraSecurityOpt: [`seccomp=${NO_LANDLOCK_SECCOMP}`] });
  try {
    const report = await waitForRulesetReport(docker, control.container);
    check("7a. agent-init itself reports a non-enforced ruleset under the profile", report.ruleset !== "FullyEnforced", `ruleset=${report.ruleset}`);

    const outPath = join(workDir, "control.attestation.json");
    const record = await attestAndRead(auditPath, outPath, berthHome);
    check("7b. the control boot attests NOT_ENFORCED", record.enforcement.status === "NOT_ENFORCED", `record says ${record.enforcement.status}`);
    check(
      "7c. reasons[] names agent-init's report",
      record.enforcement.reasons.some((r) => r.includes("agent-init reported")),
      JSON.stringify(record.enforcement.reasons),
    );
    const accepted = runVerifier(outPath);
    check("7d. the standalone verifier accepts the honest NOT_ENFORCED record too", accepted.code === 0, accepted.output);
  } finally {
    await stopContainer(control.container).catch(() => {});
    await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
  }

  await rm(workDir, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll attestation-milestone checks passed." : `\n${failures} attestation-milestone check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
