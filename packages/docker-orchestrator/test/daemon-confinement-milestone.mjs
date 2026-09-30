#!/usr/bin/env node
// The pre-agent-init daemons are confined (threat model B4).
//
//   Confined boot (the new default):
//     1. context-bus-daemon runs as uid 9001 (berth-context-bus), not root,
//        and its socket still carries the 0660 root:berth-group access model;
//     2. **compromised-daemon simulation** — a process started with exactly
//        the daemon's policy, uid, and groups (the same agent-init applier)
//        attempts a write outside its domain (DAC would allow it: /context is
//        group-writable to gid 9999, which the simulation holds) and an
//        outbound TCP connect. The kernel refuses both.
//     3. mesh-daemon's own Landlock domain, via its --confinement-probe:
//        a write outside the domain is denied, a write inside it succeeds
//        (the positive control that the domain grants what it declares);
//     4. the semantic-fs sidecar's post-mount narrowing: pid 1's bounding
//        set is empty (SYS_ADMIN gone), its effective set keeps only the
//        file-ownership caps — and /context still round-trips a write.
//
//   Negative control boot (BERTH_DISABLE_DAEMON_CONFINEMENT=1):
//     5. context-bus-daemon is root again, the same out-of-domain write
//        SUCCEEDS, the probe's write succeeds, and the sidecar's bounding
//        set still holds SYS_ADMIN — proving every check above can fail,
//        and that the escape hatch restores exactly the pre-M1.2 posture.
//
// Landlock-dependent checks (2 and 3's denial half) are gated on the kernel
// actually enforcing Landlock, detected from the probe's own ruleset status
// — on a non-enforcing host (Docker Desktop) they are reported as SKIPPED
// rather than silently passed, the same honesty rule agent-init's boot
// banner follows.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berthos/manifest-schema";
import Docker from "dockerode";
import { buildImage, checkoutTag, startContainer, stopContainer, sidecarName } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const IMAGE_TAG = checkoutTag("berth/filesystem-daemon-confinement:dev", APP_DIR);
const CONTAINER_NAME = "berth-daemon-confinement-milestone";

const CONTEXT_BUS_UID = "9001";
const SHARED_GID = "9999";
// CAP_* bit numbers, from linux/capability.h.
const CAP_CHOWN = 0n;
const CAP_SYS_ADMIN = 21n;

let failures = 0;
function check(what, ok, extra) {
  if (ok) console.log(`  PASS  ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`);
  }
}
function skip(what, why) {
  console.log(`  SKIP  ${what} — ${why}`);
}

async function execCapture(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const { ExitCode } = await exec.inspect();
  return { output: Buffer.concat(chunks).toString("utf-8"), exitCode: ExitCode };
}

// The daemon's uid, read from /proc by exact argv[0] match — comm is
// truncated at 15 chars and a substring match would find this very exec's
// own shell, whose command line contains the daemon's name.
//
// `2>/dev/null` comes before `<` on purpose: redirections apply left to
// right, so with it after, a process that exited between the glob and the
// read made the shell itself print "can't open '/proc/443/cmdline'" to
// stderr, and the first number in the output (443, a pid) was read back as
// the uid. The value is tagged UID= and parsed by tag for the same reason.
const UID_OF_CONTEXT_BUS = `for d in /proc/[0-9]*; do [ "$(tr '\\0' '\\n' 2>/dev/null < "$d/cmdline" | head -n1)" = "/usr/local/bin/context-bus-daemon" ] && awk '/^Uid:/{print "UID=" $2}' "$d/status" 2>/dev/null && break; done`;

async function contextBusUid(container) {
  // The daemon starts before the apps but agent-init's own work is async
  // relative to this exec — poll briefly rather than read once.
  for (let i = 0; i < 20; i++) {
    const result = await execCapture(container, ["sh", "-c", UID_OF_CONTEXT_BUS]);
    const uid = /UID=(\d+)/.exec(result.output)?.[1];
    if (uid) return uid;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "(not found)";
}

async function runConfinementProbe(container, target, disabled) {
  const env = disabled ? "BERTH_DISABLE_DAEMON_CONFINEMENT=1 " : "";
  const result = await execCapture(container, ["sh", "-c", `${env}/usr/local/bin/mesh-daemon --confinement-probe ${target}`]);
  const match = result.output.match(/\{[^\n]*"confinement_probe"[^\n]*\}/);
  if (!match) return { parsed: null, raw: result.output };
  try {
    return { parsed: JSON.parse(match[0]), raw: result.output };
  } catch {
    return { parsed: null, raw: result.output };
  }
}

async function sidecarCaps(docker) {
  const sidecar = docker.getContainer(sidecarName(CONTAINER_NAME));
  // The narrowing happens just after the mount the boot already waited for —
  // poll a few times to close the last sliver of that race.
  for (let i = 0; i < 20; i++) {
    const result = await execCapture(sidecar, ["sh", "-c", "grep -E '^Cap(Bnd|Eff):' /proc/1/status"]);
    const bnd = result.output.match(/CapBnd:\s*([0-9a-f]+)/);
    const eff = result.output.match(/CapEff:\s*([0-9a-f]+)/);
    if (bnd && eff) return { bnd: BigInt(`0x${bnd[1]}`), eff: BigInt(`0x${eff[1]}`) };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function boot(docker, runDir, disableConfinement) {
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));
  // Reaches the sidecar via startSemanticFsSidecar's process-env passthrough
  // and the sandbox's daemons via options.env below.
  if (disableConfinement) process.env.BERTH_DISABLE_DAEMON_CONFINEMENT = "1";
  else delete process.env.BERTH_DISABLE_DAEMON_CONFINEMENT;
  try {
    return await startContainer({
      image: IMAGE_TAG,
      name: CONTAINER_NAME,
      manifest,
      bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
      workingDir: "/workspace/apps/filesystem",
      env: {
        BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace",
        ...(disableConfinement ? { BERTH_DISABLE_DAEMON_CONFINEMENT: "1" } : {}),
      },
      secretsRunDir: runDir,
      docker,
    });
  } finally {
    delete process.env.BERTH_DISABLE_DAEMON_CONFINEMENT;
  }
}

async function teardown(docker, running, runDir) {
  await stopContainer(running.container, { secretsRunDir: runDir, docker }).catch(() => {});
  await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
  await docker.getContainer(sidecarName(CONTAINER_NAME)).remove({ force: true }).catch(() => {});
}

async function main() {
  const docker = new Docker();
  await mkdir(join(REPO_ROOT, ".berth"), { recursive: true });
  const runDir = await mkdtemp(join(REPO_ROOT, ".berth", "daemon-confinement-run-"));

  console.log("--- Building apps/filesystem's dev image ---");
  await buildImage({ appDir: APP_DIR, tag: IMAGE_TAG, target: "dev", docker });
  await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
  await docker.getContainer(sidecarName(CONTAINER_NAME)).remove({ force: true }).catch(() => {});

  console.log("\n=== Confined boot (the new default) ===");
  const running = await boot(docker, runDir, false);
  let landlockEnforced = false;
  try {
    console.log("\n--- 1: context-bus-daemon has its own uid and a working socket ---");
    const uid = await contextBusUid(running.container);
    check(`context-bus-daemon runs as uid ${CONTEXT_BUS_UID}, not root`, uid === CONTEXT_BUS_UID, `uid was ${uid}`);
    const socketStat = await execCapture(running.container, ["sh", "-c", 'stat -c "%u %g %a" "${BERTH_CONTEXT_BUS_SOCKET:-/tmp/berth-context-bus.sock}"']);
    check(
      "its socket keeps the shared-group access model (gid 9999, mode 660)",
      socketStat.output.includes(`${CONTEXT_BUS_UID} ${SHARED_GID} 660`),
      socketStat.output.slice(0, 120),
    );

    // Enforcement detection: the probe reports the kernel's own answer.
    const detect = await runConfinementProbe(running.container, "/etc/berth-daemon-probe", false);
    landlockEnforced = detect.parsed?.rulesetStatus === "FullyEnforced";
    console.log(`\n(Landlock on this host: ${detect.parsed?.rulesetStatus ?? `unparseable: ${detect.raw.slice(0, 120)}`})`);

    console.log("\n--- 2: compromised-daemon simulation — the kernel refuses, not DAC ---");
    if (landlockEnforced) {
      // Same policy file, same uid, same groups, same applier as the real
      // daemon. /context is group-writable to gid 9999 (which this holds),
      // so only Landlock stands between the write and the disk.
      const escape = await execCapture(running.container, [
        "sh", "-c",
        "env BERTH_CAPABILITY_POLICY=/run/berth/daemon-policy.context-bus.json BERTH_APP_UID=9001 BERTH_APP_GID=9001 BERTH_APP_SUPPLEMENTARY_GIDS=9999 " +
          "/usr/local/bin/agent-init /bin/sh -c 'echo pwned > /context/daemon-escape.txt && echo WROTE' 2>&1",
      ]);
      check("a write outside the daemon's domain is denied", !escape.output.includes("WROTE"), escape.output.slice(-200));
      const connect = await execCapture(running.container, [
        "sh", "-c",
        "env BERTH_CAPABILITY_POLICY=/run/berth/daemon-policy.context-bus.json BERTH_APP_UID=9001 BERTH_APP_GID=9001 BERTH_APP_SUPPLEMENTARY_GIDS=9999 " +
          '/usr/local/bin/agent-init /usr/local/bin/node -e "const s=require(\'net\').connect(9,\'127.0.0.1\');s.on(\'error\',(e)=>{console.log(\'CODE:\'+e.code);process.exit(0)});s.on(\'connect\',()=>{console.log(\'CODE:CONNECTED\');process.exit(0)})" 2>&1',
      ]);
      check("an outbound TCP connect it never declared is denied (EACCES, not ECONNREFUSED)", connect.output.includes("CODE:EACCES"), connect.output.slice(-200));
    } else {
      skip("out-of-domain write + undeclared connect denials", "this kernel does not enforce Landlock — run on the Colima/Linux host");
    }

    console.log("\n--- 3: mesh-daemon's own domain — denies outside, grants inside ---");
    if (landlockEnforced) {
      check("a write outside mesh-daemon's domain is denied", detect.parsed?.writeDenied === true, JSON.stringify(detect.parsed));
      const inside = await runConfinementProbe(running.container, "/etc/wireguard/berth-probe-inside", false);
      check("a write inside its declared domain succeeds (positive control)", inside.parsed?.writeDenied === false, JSON.stringify(inside.parsed ?? inside.raw.slice(0, 120)));
    } else {
      skip("mesh-daemon Landlock denial/grant pair", "this kernel does not enforce Landlock");
    }

    console.log("\n--- 4: the semantic-fs sidecar narrowed itself post-mount ---");
    const caps = await sidecarCaps(docker);
    if (!caps) {
      check("sidecar pid 1 capability sets readable", false, "no sidecar (legacy in-sandbox mount?) or /proc/1/status unreadable");
    } else {
      check("bounding set is empty (SYS_ADMIN unreachable forever)", caps.bnd === 0n, `CapBnd=0x${caps.bnd.toString(16)}`);
      check("effective set dropped SYS_ADMIN", (caps.eff & (1n << CAP_SYS_ADMIN)) === 0n, `CapEff=0x${caps.eff.toString(16)}`);
      check("effective set keeps the file-ownership caps (CAP_CHOWN)", (caps.eff & (1n << CAP_CHOWN)) !== 0n, `CapEff=0x${caps.eff.toString(16)}`);
    }
    const write = await execCapture(running.container, ["sh", "-c", "echo m12-payload > /context/m12-probe.txt && cat /context/m12-probe.txt"]);
    check("/context still round-trips a write after the narrowing", write.exitCode === 0 && write.output.includes("m12-payload"), write.output.slice(0, 200));
  } finally {
    await teardown(docker, running, runDir);
  }

  console.log("\n=== Negative control boot (BERTH_DISABLE_DAEMON_CONFINEMENT=1) ===");
  const legacy = await boot(docker, runDir, true);
  try {
    console.log("\n--- 5: the pre-M1.2 posture, restored exactly — proving 1–4 can fail ---");
    const uid = await contextBusUid(legacy.container);
    check("context-bus-daemon is root again", uid === "0", `uid was ${uid}`);
    const escape = await execCapture(legacy.container, ["sh", "-c", "echo pwned > /context/daemon-escape.txt && echo WROTE && rm -f /context/daemon-escape.txt"]);
    check("the same out-of-domain write SUCCEEDS from an unconfined daemon's position", escape.output.includes("WROTE"), escape.output.slice(-200));
    const probe = await runConfinementProbe(legacy.container, "/etc/berth-daemon-probe", true);
    check("the probe's write succeeds with confinement disabled", probe.parsed?.writeDenied === false, JSON.stringify(probe.parsed ?? probe.raw.slice(0, 120)));
    const caps = await sidecarCaps(docker);
    check("the sidecar keeps SYS_ADMIN in its bounding set", caps !== null && (caps.bnd & (1n << CAP_SYS_ADMIN)) !== 0n, caps ? `CapBnd=0x${caps.bnd.toString(16)}` : "no caps read");
  } finally {
    await teardown(docker, legacy, runDir);
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll daemon-confinement checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
