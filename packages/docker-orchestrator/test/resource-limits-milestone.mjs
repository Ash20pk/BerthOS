#!/usr/bin/env node
// Per-app resource limits, in a real two-app sandbox. cgroup-hog declares
// `resources: { cpu: 0.5, memory_mb: 96, pids: 64 }` and then forks, allocates
// and spins past every one of them; cgroup-neighbour declares nothing and has
// to keep answering, as do the daemons.
//
//   Enforced boot:
//     1. the sandbox got a writable cgroup namespace and nothing else — no
//        SYS_ADMIN, not privileged — and its PidsLimit is the apps' sum plus
//        the daemon reserve, not the max;
//     2. each app runs in its own cgroup (/berth/apps/<app>), context-bus-
//        daemon in /berth/daemons, and the kernel holds the declared limits
//        (and the defaults, for the neighbour);
//     3. the hog cannot write any cgroup file — its own, a sibling's, the
//        daemons', the root's — nor make a child cgroup; neither can its uid
//        from outside agent-init, where only DAC stands in the way;
//     4. a fork bomb stops at the hog's 64 tasks, and while it holds them the
//        neighbour answers RPC and a context-bus round trip completes;
//     5. an allocation past 96 MiB never gets there: with no memory.high to
//        throttle it, it is OOM-killed at memory.max, promptly, in the hog's
//        cgroup (memory.events oom_kill >= 1, the process gone); the hog
//        itself survives, and the neighbour and the bus answer meanwhile;
//     6. eight busy loops are held to about half a core, and the neighbour's
//        RPC and a bus round trip stay fast while they run.
//
//   Control boot (BERTH_DISABLE_APP_CGROUPS=1):
//     7. the same hog, in the same image, is in no cgroup of its own and forks
//        200 tasks without a refusal — so 4 is the per-app limit at work, not
//        something else that happens to stop at 64.
//
// Production image, no bind mount, so it runs wherever Docker does. It needs a
// host that delegates cgroups (cgroup v2 with nsdelegate, Docker 28+), which
// the first check makes explicit rather than letting the rest fail obscurely.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest, DAEMON_RESERVE, DEFAULT_APP_PIDS } from "@berthos/manifest-schema";
import { buildImage, startContainer, stopContainer, invokeAppExport, demuxLogBuffer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const IMAGE_TAG = "berth/resource-limits-milestone:test";
const HOG = "cgroup-hog";
const NEIGHBOUR = "cgroup-neighbour";
// apps[] index -> uid, per entrypoint.sh's export_app_identity.
const HOG_UID = "10000";
const NEIGHBOUR_UID = "10001";

const docker = new Docker();

let failures = 0;
function check(what, ok, extra) {
  if (ok) console.log(`  PASS  ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`);
  }
}

async function exec(container, command, user) {
  const run = await container.exec({ Cmd: ["sh", "-c", command], AttachStdout: true, AttachStderr: true, ...(user ? { User: user } : {}) });
  const stream = await run.start({ hijack: true, stdin: false });
  const chunks = [];
  const out = new PassThrough();
  out.on("data", (c) => chunks.push(c));
  docker.modem.demuxStream(stream, out, out);
  await new Promise((resolve) => stream.on("end", resolve));
  const { ExitCode } = await run.inspect();
  return { output: Buffer.concat(chunks).toString("utf8").trim(), exitCode: ExitCode };
}

const bootLog = async (container) => demuxLogBuffer(Buffer.from(await container.logs({ stdout: true, stderr: true })));

const call = (container, app, exportName, input, timeoutMs = 15000) =>
  invokeAppExport(container, app, { id: exportName, export: exportName, input }, { docker, timeoutMs });

async function waitForApps(container) {
  for (const app of [HOG, NEIGHBOUR]) {
    let response;
    for (let attempt = 0; attempt < 60; attempt++) {
      response = await call(container, app, "ping").catch((err) => ({ error: String(err) }));
      if (response.result?.ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!response?.result?.ok) {
      const logs = (await container.logs({ stdout: true, stderr: true, tail: 80 })).toString("utf8");
      throw new Error(`${app} never answered ping (${JSON.stringify(response)}). Log:\n${logs}`);
    }
  }
}

async function boot(disableCgroups) {
  const specs = [
    { name: HOG, appDir: join(FIXTURES, HOG) },
    { name: NEIGHBOUR, appDir: join(FIXTURES, NEIGHBOUR) },
  ];
  for (const spec of specs) spec.manifest = await loadManifest(join(spec.appDir, "berth.yml"));
  if (disableCgroups) process.env.BERTH_DISABLE_APP_CGROUPS = "1";
  else delete process.env.BERTH_DISABLE_APP_CGROUPS;
  try {
    const running = await startContainer({
      image: IMAGE_TAG,
      name: `berth-resource-limits-milestone-${Date.now()}`,
      manifest: specs[0].manifest,
      workingDir: `/app/apps/${HOG}`,
      apps: specs.map((s) => ({ name: s.name, workingDir: `/app/apps/${s.name}`, manifest: s.manifest })),
      docker,
    });
    await waitForApps(running.container);
    return running.container;
  } finally {
    delete process.env.BERTH_DISABLE_APP_CGROUPS;
  }
}

/** The neighbour's RPC and a context-bus round trip, timed. */
async function neighbourHealth(container) {
  const started = Date.now();
  const ping = await call(container, NEIGHBOUR, "ping").catch((err) => ({ error: String(err) }));
  const pingMs = Date.now() - started;
  const bus = await call(container, NEIGHBOUR, "bus_roundtrip", {}, 20000).catch((err) => ({ error: String(err) }));
  return { ping: ping.result?.ok === true, pingMs, bus: bus.result?.delivered === true, busMs: bus.result?.ms, raw: { ping, bus } };
}

async function cgroupFile(container, app, file) {
  return (await exec(container, `cat /sys/fs/cgroup/berth/apps/${app}/${file}`)).output;
}

// Called before each boot rather than once: the second is a cache hit, and it
// means a shared daemon whose images get cleaned up between the two boots
// still runs the control against the same image.
async function build() {
  await buildImage({
    appDir: join(FIXTURES, HOG),
    tag: IMAGE_TAG,
    target: "production",
    appName: HOG,
    companions: [{ name: NEIGHBOUR, appDir: join(FIXTURES, NEIGHBOUR) }],
    docker,
  });
}

async function main() {
  console.log("--- Building a production image with cgroup-hog and cgroup-neighbour ---");
  await build();

  console.log("\n=== Enforced boot ===");
  let container = await boot(false);
  try {
    const logs = await bootLog(container);
    const active = /per-app cgroups active/.test(logs);
    if (!active) {
      const why = logs.match(/per-app cgroups inactive: .*/)?.[0] ?? "(no cgroup line in the boot log)";
      throw new Error(`this host did not delegate a cgroup subtree to the sandbox, so there is nothing to verify: ${why}. Run \`berth doctor\`.`);
    }

    for (const line of logs.split("\n").filter((l) => /\[berth:entrypoint\].*cgroup/.test(l))) console.log(`  ${line.trim()}`);

    console.log("\n--- 1: what the sandbox was given ---");
    const info = await container.inspect();
    const host = info.HostConfig;
    check("writable-cgroups=true requested", (host.SecurityOpt ?? []).includes("writable-cgroups=true"), JSON.stringify(host.SecurityOpt));
    check("no CAP_SYS_ADMIN", !(host.CapAdd ?? []).includes("SYS_ADMIN"), JSON.stringify(host.CapAdd));
    check("not privileged", host.Privileged !== true);
    const expectedPids = 64 + DEFAULT_APP_PIDS + DAEMON_RESERVE.pids;
    check(`PidsLimit is the apps' sum plus the reserve (${expectedPids})`, host.PidsLimit === expectedPids, `got ${host.PidsLimit}`);
    check("no container memory cap, since the neighbour declares none", !host.Memory, `got ${host.Memory}`);

    console.log("\n--- 2: where everything runs, and what the kernel holds ---");
    const hogWhere = (await call(container, HOG, "whereami")).result;
    const neighbourWhere = (await call(container, NEIGHBOUR, "whereami")).result;
    check("hog is in /berth/apps/cgroup-hog", hogWhere?.cgroup === "0::/berth/apps/cgroup-hog", hogWhere?.cgroup);
    check("neighbour is in /berth/apps/cgroup-neighbour", neighbourWhere?.cgroup === "0::/berth/apps/cgroup-neighbour", neighbourWhere?.cgroup);
    const busCgroup = await exec(
      container,
      'for d in /proc/[0-9]*; do [ "$(cat $d/comm 2>/dev/null)" = "context-bus-dae" ] && cat $d/cgroup && break; done',
    );
    check("context-bus-daemon is in /berth/daemons", busCgroup.output === "0::/berth/daemons", busCgroup.output);
    const execCgroup = await exec(container, "cat /proc/self/cgroup");
    check("a docker exec (the RPC relay's path) lands with the daemons", execCgroup.output === "0::/berth/daemons", execCgroup.output);
    const hogLimits = {
      "cpu.max": await cgroupFile(container, HOG, "cpu.max"),
      "memory.max": await cgroupFile(container, HOG, "memory.max"),
      "memory.high": await cgroupFile(container, HOG, "memory.high"),
      "memory.swap.max": await cgroupFile(container, HOG, "memory.swap.max").catch(() => ""),
      "pids.max": await cgroupFile(container, HOG, "pids.max"),
    };
    console.log("  hog:", JSON.stringify(hogLimits));
    check("hog cpu.max = 50000 100000", hogLimits["cpu.max"] === "50000 100000");
    check("hog memory.max = 96 MiB", hogLimits["memory.max"] === String(96 * 1024 * 1024));
    check("hog memory.high is left at max, so going past memory.max kills rather than stalls", hogLimits["memory.high"] === "max", hogLimits["memory.high"]);
    check("hog pids.max = 64", hogLimits["pids.max"] === "64");
    const neighbourPids = await cgroupFile(container, NEIGHBOUR, "pids.max");
    const neighbourMem = await cgroupFile(container, NEIGHBOUR, "memory.max");
    check(`neighbour gets the default pids.max (${DEFAULT_APP_PIDS})`, neighbourPids === String(DEFAULT_APP_PIDS), neighbourPids);
    check("neighbour has no memory.max of its own", neighbourMem === "max", neighbourMem);
    const appsMem = (await exec(container, "cat /sys/fs/cgroup/berth/apps/memory.max")).output;
    check("the apps together are capped short of the whole sandbox (the daemon reserve)", /^\d+$/.test(appsMem), appsMem);
    const events = logs.split("\n").filter((l) => l.includes('"event":"cgroup_limits_applied"')).map((l) => JSON.parse(l.trim()));
    check("each app's applied limits are in the boot log as an event", events.map((e) => e.app).sort().join(",") === `${HOG},${NEIGHBOUR}`, JSON.stringify(events));

    console.log("\n--- 3: the hog cannot leave, or loosen, its cgroup ---");
    const escape = (await call(container, HOG, "escape_cgroup")).result ?? {};
    console.log("  ", JSON.stringify(escape));
    for (const [attempt, outcome] of Object.entries(escape)) {
      check(`hog: ${attempt} refused`, outcome !== "ok", `got ${outcome}`);
    }
    check("the escape probe tried every path", Object.keys(escape).length === 9, JSON.stringify(escape));
    // docker exec runs outside agent-init — no Landlock domain — so this is
    // DAC alone, which has to hold on its own too.
    const dac = await exec(container, "echo $$ > /sys/fs/cgroup/berth/apps/cgroup-hog/cgroup.procs", HOG_UID);
    check("hog's uid, outside Landlock, cannot write its cgroup.procs", dac.exitCode !== 0, dac.output);
    const dacLimit = await exec(container, "echo max > /sys/fs/cgroup/berth/apps/cgroup-hog/pids.max", NEIGHBOUR_UID);
    check("a sibling's uid cannot loosen the hog's limits", dacLimit.exitCode !== 0, dacLimit.output);
    check("the hog's pids.max is still 64 afterwards", (await cgroupFile(container, HOG, "pids.max")) === "64");

    console.log("\n--- 4: a fork bomb stops at the hog's 64 tasks; the neighbour and the daemons answer meanwhile ---");
    const bomb = call(container, HOG, "fork_bomb", { count: 10000, hold: 6 }, 60000);
    await new Promise((r) => setTimeout(r, 2000));
    const pidsNow = await cgroupFile(container, HOG, "pids.current");
    const duringBomb = await neighbourHealth(container);
    const bombResult = (await bomb).result;
    console.log("  fork_bomb:", JSON.stringify(bombResult), "pids.current during:", pidsNow, "neighbour:", JSON.stringify({ ...duringBomb, raw: undefined }));
    check("the fork bomb was refused (EAGAIN) before 64", bombResult?.error === "EAGAIN" && bombResult.forked < 64, JSON.stringify(bombResult));
    check("the hog sat at its limit while holding", Number(pidsNow) >= 60, pidsNow);
    check("pids.events recorded the refusals", /max [1-9]/.test(await cgroupFile(container, HOG, "pids.events")));
    check("neighbour answered RPC during the fork bomb", duringBomb.ping, JSON.stringify(duringBomb.raw.ping));
    check("a context-bus round trip completed during the fork bomb", duringBomb.bus, JSON.stringify(duringBomb.raw.bus));

    console.log("\n--- 5: memory past 96 MiB is OOM-killed in the hog's cgroup; the hog and its neighbour live ---");
    const eventsBefore = await cgroupFile(container, HOG, "memory.events");
    const oomKills = (events) => Number(events.match(/oom_kill (\d+)/)?.[1] ?? 0);
    const allocating = call(container, HOG, "alloc", { mb: 256, timeout: 30 }, 60000);
    // Asked straight away, while the child is still allocating toward the
    // limit, and again once the kernel has killed it.
    const duringAlloc = await neighbourHealth(container);
    const alloc = (await allocating).result;
    const afterAlloc = await neighbourHealth(container);
    const memEvents = await cgroupFile(container, HOG, "memory.events");
    const peak = Number(await cgroupFile(container, HOG, "memory.peak"));
    const gone = alloc?.pid ? (await call(container, HOG, "alive", { pid: alloc.pid })).result : undefined;
    console.log("  alloc:", JSON.stringify(alloc), `peak: ${peak}; events: ${memEvents.replace(/\n/g, ", ")}`);
    check("the 256 MiB allocation never completed", alloc?.allocated === false, JSON.stringify(alloc));
    check("it was SIGKILLed, not left throttled until the timeout", alloc?.returncode === -9 && alloc.timed_out === false, JSON.stringify(alloc));
    check(
      "by the OOM killer in the hog's cgroup (memory.events oom_kill went up)",
      oomKills(memEvents) >= 1 && oomKills(memEvents) > oomKills(eventsBefore),
      `before: ${eventsBefore.replace(/\n/g, ", ")}; after: ${memEvents.replace(/\n/g, ", ")}`,
    );
    check("promptly: the kill came in seconds, not after a stall", alloc?.seconds < 15, `${alloc?.seconds}s`);
    check("the allocating process is gone", gone?.alive === false, JSON.stringify(gone));
    check("the hog's memory never passed its memory.max", peak <= 96 * 1024 * 1024, String(peak));
    check("neighbour answered RPC while the hog ran into its memory limit", duringAlloc.ping, JSON.stringify(duringAlloc.raw.ping));
    check("a context-bus round trip completed meanwhile", duringAlloc.bus, JSON.stringify(duringAlloc.raw.bus));
    check("and both still answer after the kill", afterAlloc.ping && afterAlloc.bus, JSON.stringify(afterAlloc.raw));
    check("the hog itself survived", (await call(container, HOG, "ping")).result?.ok === true);

    console.log("\n--- 6: eight busy loops are held to half a core ---");
    await call(container, HOG, "spin", { workers: 8, seconds: 12 });
    await new Promise((r) => setTimeout(r, 1500));
    const usage = async () => Number((await cgroupFile(container, HOG, "cpu.stat")).match(/usage_usec (\d+)/)?.[1]);
    const u0 = await usage();
    const t0 = Date.now();
    const duringSpin = await neighbourHealth(container);
    await new Promise((r) => setTimeout(r, Math.max(0, 4000 - (Date.now() - t0))));
    const cores = (await usage() - u0) / 1000 / (Date.now() - t0);
    const throttled = (await cgroupFile(container, HOG, "cpu.stat")).match(/nr_throttled (\d+)/)?.[1];
    console.log(`  hog used ${cores.toFixed(2)} cores; nr_throttled ${throttled}; neighbour ping ${duringSpin.pingMs}ms, bus ${duringSpin.busMs}ms`);
    check("the hog used at most ~half a core", cores <= 0.65, `${cores.toFixed(2)} cores`);
    check("and was throttled to get there", Number(throttled) > 0, throttled);
    check("neighbour RPC answered promptly under the spin", duringSpin.ping && duringSpin.pingMs < 5000, `${duringSpin.pingMs}ms`);
    check("a context-bus round trip completed under the spin", duringSpin.bus, JSON.stringify(duringSpin.raw.bus));
  } finally {
    await stopContainer(container).catch(() => {});
  }

  console.log("\n=== Control boot: BERTH_DISABLE_APP_CGROUPS=1 ===");
  await build();
  container = await boot(true);
  try {
    const logs = await bootLog(container);
    console.log("\n--- 7: without per-app cgroups, the same fork bomb is not stopped at 64 ---");
    check("the boot log says per-app cgroups are inactive", /per-app cgroups inactive/.test(logs));
    const info = await container.inspect();
    check("and no writable cgroups were requested", !(info.HostConfig.SecurityOpt ?? []).includes("writable-cgroups=true"));
    const where = (await call(container, HOG, "whereami")).result;
    check("the hog is in no cgroup of its own", where?.cgroup === "0::/", where?.cgroup);
    const bomb = (await call(container, HOG, "fork_bomb", { count: 200, hold: 0 }, 60000)).result;
    console.log("  fork_bomb:", JSON.stringify(bomb));
    check("it forked all 200 — so the enforced boot's refusal was the per-app limit", bomb?.forked === 200 && bomb.error === null, JSON.stringify(bomb));
  } finally {
    await stopContainer(container).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nRESOURCE LIMITS MILESTONE VERIFIED");
}

main().catch((err) => {
  console.error("\nRESOURCE LIMITS MILESTONE VERIFICATION FAILED:", err);
  process.exit(1);
});
