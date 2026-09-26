import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDoctor,
  probeKernel,
  findProbeImage,
  PROBE_FALLBACK_IMAGE,
  unenforcedBanner,
  enforcementStatusForBoot,
  type LandlockProbeResult,
} from "./doctor.js";

/**
 * A Docker stub. Only the four calls doctor.ts makes are implemented, so a new
 * call site shows up as a TypeError here rather than as a silently-skipped check.
 */
function fakeDocker(opts: {
  ping?: () => Promise<unknown>;
  info?: Record<string, unknown>;
  images?: Array<{ RepoTags?: string[] }>;
} = {}) {
  return {
    ping: opts.ping ?? (async () => "OK"),
    info: async () => opts.info ?? { KernelVersion: "6.8.0-generic", Architecture: "x86_64", SecurityOptions: ["name=seccomp,profile=builtin"] },
    listImages: async () => opts.images ?? [{ RepoTags: ["berth/filesystem:dev"] }],
  } as never;
}

const probeReturning = (r: LandlockProbeResult) => async () => r;

// --- the verdict table ---------------------------------------------------

test("an enforcing kernel yields ACTIVE — the branch a macOS host can never reach", async () => {
  const report = await runDoctor({
    docker: fakeDocker(),
    probe: probeReturning({ status: "enforcing", abi: 5, reason: "write refused with Permission denied", fuse: true }),
  });

  assert.equal(report.enforcementActive, true);
  assert.equal(report.verdict, "enforcement: ACTIVE");
  assert.deepEqual(report.reasons, []);
  assert.equal(report.checks.find((c) => c.id === "landlock")?.status, "ok");
  assert.equal(report.checks.find((c) => c.id === "fuse")?.status, "ok");
});

test("landlock present but not in the LSM stack is a failure, and says which shape it is", async () => {
  const report = await runDoctor({
    docker: fakeDocker(),
    probe: probeReturning({ status: "present_not_enforcing", abi: 5, fuse: true }),
  });

  assert.equal(report.enforcementActive, false);
  const landlock = report.checks.find((c) => c.id === "landlock");
  assert.equal(landlock?.status, "fail");
  // The distinction that matters: the syscalls working is precisely why this one
  // is dangerous, so the detail has to name it rather than just saying "no".
  assert.match(landlock?.detail ?? "", /syscalls exist/);
  assert.match(landlock?.detail ?? "", /active LSM stack/);
  assert.match(report.verdict, /^enforcement: NOT ACTIVE \(/);
});

test("a kernel without the syscalls is a failure that points at the Mac recipe", async () => {
  const report = await runDoctor({
    docker: fakeDocker(),
    probe: probeReturning({ status: "unsupported", abi: null, reason: "Function not implemented", fuse: true }),
  });

  assert.equal(report.enforcementActive, false);
  const landlock = report.checks.find((c) => c.id === "landlock");
  assert.equal(landlock?.status, "fail");
  assert.match(landlock?.detail ?? "", /not available in this kernel/);
  assert.match(landlock?.remedy ?? "", /mac-enforcement/);
});

// --- checks that did not run must never read as passing ------------------

test("skipProbe reports unknown, not ok, and still refuses to call enforcement active", async () => {
  const report = await runDoctor({ docker: fakeDocker(), skipProbe: true });

  assert.equal(report.checks.find((c) => c.id === "landlock")?.status, "unknown");
  assert.equal(report.checks.find((c) => c.id === "fuse")?.status, "unknown");
  assert.equal(report.enforcementActive, false);
  assert.equal(report.probeImage, undefined);
});

test("an unreachable daemon fails the docker check and leaves the kernel unknowable", async () => {
  const report = await runDoctor({
    docker: fakeDocker({
      ping: async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      },
    }),
  });

  const docker = report.checks.find((c) => c.id === "docker");
  assert.equal(docker?.status, "fail");
  assert.match(docker?.detail ?? "", /ENOENT/);
  assert.equal(report.daemon, undefined);
  assert.equal(report.checks.find((c) => c.id === "landlock")?.status, "unknown");
  assert.equal(report.enforcementActive, false);
  // No seccomp check at all: it is read off the daemon, and inventing a status
  // for it here would be a guess.
  assert.equal(report.checks.find((c) => c.id === "seccomp"), undefined);
});

test("no local image to probe in, and no pull, is reported as unknown with an actionable remedy", async () => {
  const report = await runDoctor({
    docker: fakeDocker({ images: [{ RepoTags: ["<none>:<none>"] }] }),
    pull: async () => undefined,
  });

  const landlock = report.checks.find((c) => c.id === "landlock");
  assert.equal(landlock?.status, "unknown");
  assert.match(landlock?.detail ?? "", /no local image/);
  assert.match(landlock?.remedy ?? "", /berth dev|--image/);
});

test("a probe that throws is unknown, and names the image it failed in", async () => {
  const report = await runDoctor({
    docker: fakeDocker(),
    probe: async () => {
      throw new Error("no such image");
    },
  });

  const landlock = report.checks.find((c) => c.id === "landlock");
  assert.equal(landlock?.status, "unknown");
  assert.match(landlock?.detail ?? "", /berth\/filesystem:dev/);
  assert.match(landlock?.detail ?? "", /no such image/);
});

// --- the secondary checks -----------------------------------------------

test("an unconfined default seccomp profile warns rather than fails, and says why it isn't fatal", async () => {
  const report = await runDoctor({
    docker: fakeDocker({ info: { KernelVersion: "6.10.14-linuxkit", Architecture: "aarch64", SecurityOptions: ["name=seccomp,profile=unconfined"] } }),
    probe: probeReturning({ status: "enforcing", abi: 5, fuse: true }),
  });

  const seccomp = report.checks.find((c) => c.id === "seccomp");
  assert.equal(seccomp?.status, "warn");
  assert.match(seccomp?.detail ?? "", /unconfined/);
  assert.match(seccomp?.remedy ?? "", /do not depend on this/);
  // A warn must not drag the verdict down: agent-init installs its own filters.
  assert.equal(report.enforcementActive, true);
});

test("a builtin seccomp profile passes", async () => {
  const report = await runDoctor({ docker: fakeDocker(), probe: probeReturning({ status: "enforcing", fuse: true }) });
  assert.equal(report.checks.find((c) => c.id === "seccomp")?.status, "ok");
});

test("a missing /dev/fuse warns and explains what breaks, without failing enforcement", async () => {
  const report = await runDoctor({
    docker: fakeDocker(),
    probe: probeReturning({ status: "enforcing", abi: 5, fuse: false }),
  });

  const fuse = report.checks.find((c) => c.id === "fuse");
  assert.equal(fuse?.status, "warn");
  assert.match(fuse?.remedy ?? "", /Semantic FS|\/context/);
  assert.equal(report.enforcementActive, true);
});

// --- image selection ----------------------------------------------------

test("findProbeImage prefers a berth image over any other, and skips untagged ones", async () => {
  const image = await findProbeImage(
    fakeDocker({ images: [{ RepoTags: ["<none>:<none>"] }, { RepoTags: ["python:3.12-alpine"] }, { RepoTags: ["berth/notes:dev"] }] }),
  );
  assert.equal(image, "berth/notes:dev");
});

test("findProbeImage falls back to a python image when no berth image is present", async () => {
  const image = await findProbeImage(fakeDocker({ images: [{ RepoTags: ["python:3.12-alpine"] }] }));
  assert.equal(image, "python:3.12-alpine");
});

test("findProbeImage takes the berth-agent/ tag a Computer or demo boot builds", async () => {
  const image = await findProbeImage(fakeDocker({ images: [{ RepoTags: ["redis:7"] }, { RepoTags: ["berth-agent/filesystem:1790420977203"] }] }));
  assert.equal(image, "berth-agent/filesystem:1790420977203");
});

test("a fresh install with no local image pulls a python image and still gets a verdict", async () => {
  let probedIn: string | undefined;
  const report = await runDoctor({
    docker: fakeDocker({ images: [] }),
    pull: async () => PROBE_FALLBACK_IMAGE,
    probe: async (_docker, image) => {
      probedIn = image;
      return { status: "enforcing", abi: 4, reason: "write refused with Permission denied", fuse: true };
    },
  });
  assert.equal(probedIn, PROBE_FALLBACK_IMAGE);
  assert.equal(report.enforcementActive, true);
  assert.match(report.checks.find((c) => c.id === "landlock")?.detail ?? "", /pulled because no local Berth image/);
});

test("--no-probe never pulls", async () => {
  let pulled = false;
  await runDoctor({
    docker: fakeDocker({ images: [] }),
    skipProbe: true,
    pull: async () => {
      pulled = true;
      return PROBE_FALLBACK_IMAGE;
    },
  });
  assert.equal(pulled, false);
});

test("findProbeImage returns undefined rather than an unusable image", async () => {
  assert.equal(await findProbeImage(fakeDocker({ images: [{ RepoTags: ["redis:7"] }] })), undefined);
});

// --- probeKernel's stream handling --------------------------------------

/** A Docker stub whose attach stream emits `output`, framed the way Docker frames it. */
function fakeProbeDocker(output: string, opts: { multiplexHeader?: boolean } = {}) {
  const stream = new PassThrough();
  let removed = false;
  const container = {
    attach: async () => {
      setImmediate(() => {
        // Docker's attach stream prefixes each frame with an 8-byte header when
        // the container has no TTY. Those bytes land in the middle of our output
        // and are why the parser looks for the JSON object rather than trusting
        // the whole buffer to be JSON.
        const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, output.length]);
        stream.write(opts.multiplexHeader === false ? Buffer.from(output) : Buffer.concat([header, Buffer.from(output)]));
        stream.end();
      });
      return stream;
    },
    start: async () => {},
    wait: async () => ({ StatusCode: 0 }),
    kill: async () => {},
    remove: async () => {
      removed = true;
    },
    wasRemoved: () => removed,
  };
  return {
    docker: { createContainer: async () => container } as never,
    container,
  };
}

test("probeKernel finds its JSON inside Docker's multiplexed frame headers", async () => {
  const { docker } = fakeProbeDocker('{"status":"enforcing","abi":5,"fuse":true}');
  const result = await probeKernel(docker, "berth/filesystem:dev");
  assert.equal(result.status, "enforcing");
  assert.equal(result.abi, 5);
  assert.equal(result.fuse, true);
});

test("probeKernel removes its container even when the probe output is unusable", async () => {
  const { docker, container } = fakeProbeDocker("Traceback: python3 not found");
  await assert.rejects(() => probeKernel(docker, "berth/filesystem:dev"), /produced no JSON/);
  // A diagnostic that leaks a container per run would be its own bug report.
  assert.equal(container.wasRemoved(), true);
});

test("probeKernel's no-JSON error quotes what it actually got", async () => {
  const { docker } = fakeProbeDocker("exec /usr/bin/python3: no such file or directory");
  await assert.rejects(() => probeKernel(docker, "img"), /no such file or directory/);
});

// --- the banner ---------------------------------------------------------

test("the banner names the consequence, not just the condition", () => {
  const banner = unenforcedBanner("This kernel has no Landlock support.");
  assert.match(banner, /ENFORCEMENT IS NOT ACTIVE/);
  assert.match(banner, /undeclared write or connection will\n {2}succeed/);
  assert.match(banner, /berth doctor/);
  assert.match(banner, /not a security boundary/);
});

// --- "unknown" is not "off" ---------------------------------------------

test("a skipped probe reports UNKNOWN, not NOT ACTIVE — the command must not overclaim either way", async () => {
  const report = await runDoctor({ docker: fakeDocker(), skipProbe: true });

  assert.equal(report.enforcementActive, false);
  assert.equal(report.enforcementDetermined, false);
  assert.match(report.verdict, /^enforcement: UNKNOWN \(/);
  assert.doesNotMatch(report.verdict, /NOT ACTIVE/);
});

test("a determined failure reports NOT ACTIVE and marks itself determined", async () => {
  const report = await runDoctor({
    docker: fakeDocker(),
    probe: probeReturning({ status: "unsupported", reason: "Function not implemented", fuse: true }),
  });

  assert.equal(report.enforcementDetermined, true);
  assert.match(report.verdict, /^enforcement: NOT ACTIVE \(/);
});

test("an active kernel is both active and determined", async () => {
  const report = await runDoctor({ docker: fakeDocker(), probe: probeReturning({ status: "enforcing", fuse: true }) });
  assert.equal(report.enforcementActive, true);
  assert.equal(report.enforcementDetermined, true);
});

// --- the runtime check (BUILD_PLAN M1.4) -----------------------------------

const infoWithRuntimes = {
  KernelVersion: "6.8.0-generic",
  Architecture: "x86_64",
  SecurityOptions: ["name=seccomp,profile=builtin"],
  Runtimes: { runc: {}, "io.containerd.runc.v2": {}, runsc: {} },
  DefaultRuntime: "runc",
};

test("a requested runtime the daemon has: runtime check ok, and the probe runs under it", async () => {
  let probedRuntime: string | undefined;
  const report = await runDoctor({
    docker: fakeDocker({ info: infoWithRuntimes }),
    runtime: "runsc",
    probe: async (_docker, _image, runtime) => {
      probedRuntime = runtime;
      return { status: "enforcing", abi: 5, reason: "write refused", fuse: true };
    },
  });

  assert.equal(probedRuntime, "runsc", "the enforcement probe must run under the runtime the sandbox will boot with — under gVisor the kernel being probed is the sentry");
  const runtime = report.checks.find((c) => c.id === "runtime");
  assert.equal(runtime?.status, "ok");
  assert.match(runtime?.detail ?? "", /"runsc"/);
  const landlock = report.checks.find((c) => c.id === "landlock");
  assert.match(landlock?.title ?? "", /runtime "runsc"/);
});

test("a requested runtime the daemon does not have fails the runtime check and skips the probe rather than guessing", async () => {
  const report = await runDoctor({
    docker: fakeDocker(), // default info: no Runtimes at all
    runtime: "runsc",
    probe: async () => {
      throw new Error("the probe must not run — createContainer would refuse this runtime");
    },
  });

  const runtime = report.checks.find((c) => c.id === "runtime");
  assert.equal(runtime?.status, "fail");
  assert.match(runtime?.remedy ?? "", /gvisor\.dev/);
  // A probe that cannot start has not answered anything: landlock is unknown,
  // and the verdict says UNKNOWN with the runtime failure as a reason.
  assert.equal(report.checks.find((c) => c.id === "landlock")?.status, "unknown");
  assert.equal(report.enforcementActive, false);
  assert.equal(report.enforcementDetermined, false);
  assert.ok(report.reasons.some((r) => r.includes("runsc")), `reasons must name the runtime failure, got: ${JSON.stringify(report.reasons)}`);
});

test("with no runtime requested the check is informational, and points at runsc when the daemon has it", async () => {
  const report = await runDoctor({
    docker: fakeDocker({ info: infoWithRuntimes }),
    probe: probeReturning({ status: "enforcing", abi: 5, reason: "write refused", fuse: true }),
  });

  const runtime = report.checks.find((c) => c.id === "runtime");
  assert.equal(runtime?.status, "ok");
  assert.match(runtime?.detail ?? "", /default "runc"/);
  assert.match(runtime?.remedy ?? "", /BERTH_RUNTIME=runsc/);
  assert.equal(report.enforcementActive, true, "an informational runtime check must not affect the verdict");
});

// --- the enforcement cache is not an attestation input ----------------------
// `$BERTH_HOME/enforcement-cache.json` is operator-writable, and doctorProbe is
// one of the two measurements deriveEnforcementStatus() requires for ACTIVE.
// Reading the cache during attestation would make one edit to one JSON file
// enough to forge half that verdict with no kernel probed, so attestation
// passes `fresh: true` and these pin that behaviour in both directions.

function cacheHarness(cached: string, probeStatus: LandlockProbeResult["status"]) {
  const home = mkdtempSync(join(tmpdir(), "berth-probe-cache-"));
  const kernel = "6.8.0-generic";
  writeFileSync(
    join(home, "enforcement-cache.json"),
    JSON.stringify({ [`${kernel}|x86_64`]: { status: cached, probedAt: "2026-01-01T00:00:00.000Z" } }),
  );
  let probes = 0;
  // Reuses fakeProbeDocker's container so this exercises probeKernel's real
  // attach()/drain path rather than a second, subtly-different stub.
  const docker = {
    info: async () => ({ KernelVersion: kernel, Architecture: "x86_64" }),
    createContainer: async (...args: unknown[]) => {
      probes++;
      const inner = fakeProbeDocker(JSON.stringify({ status: probeStatus, abi: 4, fuse: true }));
      return (inner.docker as unknown as { createContainer: (...a: unknown[]) => Promise<unknown> }).createContainer(...args);
    },
  } as never;
  return { home, docker, probes: () => probes };
}

/** Runs `fn` with BERTH_HOME pointed at `home`, restoring whatever was there. */
async function withBerthHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BERTH_HOME;
  process.env.BERTH_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BERTH_HOME;
    else process.env.BERTH_HOME = prev;
  }
}

test("the boot banner path trusts the cache — that is what it is for", async () => {
  const { home, docker, probes } = cacheHarness("enforcing", "unsupported");
  const result = await withBerthHome(home, () => enforcementStatusForBoot(docker, "img"));
  assert.equal(result.status, "enforcing", "a cache hit should short-circuit the probe here");
  assert.equal(probes(), 0, "no container should be started on a cache hit");
});

test("fresh: true ignores a poisoned cache and measures the kernel instead", async () => {
  // The forgery: the cache claims "enforcing", the kernel says otherwise.
  const { home, docker, probes } = cacheHarness("enforcing", "unsupported");
  const result = await withBerthHome(home, () => enforcementStatusForBoot(docker, "img", undefined, { fresh: true }));
  assert.equal(result.status, "unsupported", "attestation must report what the kernel does, not what the cache claims");
  assert.equal(probes(), 1, "a fresh probe must actually run");
});

test("fresh: true does not invent enforcement either — an enforcing kernel still reads enforcing", async () => {
  const { home, docker } = cacheHarness("unsupported", "enforcing");
  const result = await withBerthHome(home, () => enforcementStatusForBoot(docker, "img", undefined, { fresh: true }));
  assert.equal(result.status, "enforcing");
});
