import Docker from "dockerode";
import { applyDockerContext, describeDockerHost } from "./docker-host.js";

/**
 * Host and kernel preflight for Berth's enforcement claims.
 *
 * The question this module answers is narrower than it looks, and the narrowness
 * is the point: *is the kernel that will run this app's processes one that can
 * enforce a Landlock policy at all?* That kernel is almost never the one the CLI
 * is running on. On macOS and Windows the app runs inside Docker's Linux VM, so
 * reading the *host's* `/sys/kernel/security/lsm` would answer a question nobody
 * asked — on macOS that file doesn't exist, which says nothing whatsoever about
 * whether Berth can enforce.
 *
 * So every kernel-level check here runs *inside a container*, against the
 * daemon's kernel.
 */

/** A single check's outcome. `unknown` means the check could not be run — never "probably fine". */
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface DoctorCheck {
  /** Stable machine-readable id. Part of the `--json` contract; do not rename. Additions (like `runtime`) are non-breaking — consumers must tolerate ids they don't know. */
  id: "docker" | "landlock" | "seccomp" | "fuse" | "runtime" | "cgroups";
  /** Human-readable one-liner. */
  title: string;
  status: CheckStatus;
  /** What was actually observed, in the words of whatever reported it. */
  detail: string;
  /** What the user can do about it, when there is something. */
  remedy?: string;
}

export interface DoctorReport {
  /** Schema version for the `--json` output. Bumped on any breaking shape change. */
  schemaVersion: 1;
  /** True only when the kernel that runs Berth's apps can enforce a Landlock policy. */
  enforcementActive: boolean;
  /**
   * Whether the question was actually answered. False when the probe could not
   * run, in which case `enforcementActive: false` means "not established", not
   * "established to be off" — a distinction worth keeping in the JSON, because
   * the two deserve different reactions from whatever is reading it.
   */
  enforcementDetermined: boolean;
  /** One-line verdict, the same string the CLI prints. */
  verdict: string;
  /** Why enforcement is not active, when it isn't. Empty when it is. */
  reasons: string[];
  checks: DoctorCheck[];
  /** Facts about the daemon, for a bug report. Absent when the daemon is unreachable. */
  daemon?: {
    /** The kernel Berth's apps actually run under — not the CLI host's kernel. */
    kernelVersion: string;
    operatingSystem: string;
    serverVersion: string;
    arch: string;
    securityOptions: string[];
  };
  /** The image the kernel probe ran in, when it ran. */
  probeImage?: string;
}

/**
 * Kernel capability probe, run inside a container.
 *
 * Deliberately a *behavioural* probe rather than a version or feature-list
 * check, because the two ways Landlock can be missing look identical from the
 * outside and only one of them is detectable by asking:
 *
 *  1. the syscalls aren't there at all — `landlock_create_ruleset` gives ENOSYS;
 *  2. the syscalls are there but `landlock` isn't in the kernel's active LSM
 *     stack — every call succeeds and nothing is ever denied.
 *
 * (2) is the dangerous one: a ruleset is built, `restrict_self()` returns 0, and
 * the sandbox is decorative. So the probe builds a ruleset that grants *nothing*
 * and then tries to open a file for writing. Enforcing kernels refuse it. That
 * is the only answer that can't be faked by a kernel with the ABI present and
 * the LSM absent.
 *
 * Reading `/sys/kernel/security/lsm` would also distinguish them, and is what an
 * earlier version of this reached for — but securityfs is not mounted in an
 * unprivileged container (verified: the path does not exist), so it costs a
 * `--privileged` container to read. A diagnostic command should not need to ask
 * for that, and this probe needs no privilege at all: Landlock is unprivileged
 * by design.
 *
 * This probes the kernel, not Berth's policy. It deliberately does not rebuild
 * what `agent-init` composes from a manifest — that would be a second
 * implementation to drift. It answers only "would a ruleset bind here".
 */
const LANDLOCK_PROBE = String.raw`
import ctypes, os, json, struct, tempfile
libc = ctypes.CDLL(None, use_errno=True)
# 444/446 are landlock_create_ruleset/landlock_restrict_self, and are the same
# numbers on x86_64 and aarch64 — the only architectures these images build for.
NR_CREATE, NR_RESTRICT = 444, 446
PR_SET_NO_NEW_PRIVS = 38
FS_WRITE_FILE = 1 << 1

def sc(*a):
    ctypes.set_errno(0)
    return libc.syscall(*a), ctypes.get_errno()

out = {}
abi, err = sc(NR_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
if abi < 0:
    out["status"], out["abi"], out["reason"] = "unsupported", None, os.strerror(err)
else:
    out["abi"] = abi
    # Only handled_access_fs is set; passing the ABI-1 struct size keeps this
    # working on every ABI, since later ABIs only append fields.
    attr = struct.pack("=Q", FS_WRITE_FILE)
    buf = ctypes.create_string_buffer(attr, len(attr))
    fd, err = sc(NR_CREATE, buf, ctypes.c_size_t(len(attr)), ctypes.c_uint32(0))
    if fd < 0:
        out["status"], out["reason"] = "unsupported", "landlock_create_ruleset: " + os.strerror(err)
    else:
        # Resolved *before* restrict_self, and that ordering is load-bearing:
        # tempfile.gettempdir() finds a writable directory by creating a file in
        # each candidate, so on a kernel that really enforces this ruleset it
        # raises instead of returning a path — the probe then died with a
        # traceback and the report said UNKNOWN on precisely the hosts where the
        # answer was "enforcing". Found the first time this ran on a kernel with
        # landlock in its LSM stack (Colima, Ubuntu 24.04, 6.8.0).
        path = os.path.join(tempfile.gettempdir(), "berth-landlock-probe")
        libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
        r, err = sc(NR_RESTRICT, ctypes.c_int(fd), ctypes.c_uint32(0))
        if r != 0:
            out["status"], out["reason"] = "unsupported", "landlock_restrict_self: " + os.strerror(err)
        else:
            # The ruleset granted nothing, so an enforcing kernel must refuse this.
            try:
                f = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
                os.close(f)
                os.unlink(path)
                out["status"] = "present_not_enforcing"
            except OSError as e:
                out["status"], out["reason"] = "enforcing", "write refused with " + e.strerror

# Checked in the same container, and deliberately with the same Devices/CapAdd
# that startContainer() passes: /dev/fuse is never present in a default
# container, so probing it without them would report a failure that says nothing
# about whether a real sandbox could mount /context.
out["fuse"] = os.path.exists("/dev/fuse")

# Whether this kernel's cgroup hierarchy can be handed to a sandbox safely,
# which is what per-app resource limits need (see cgroupDelegationForBoot).
# Read from the mount's *superblock* options, which are the host's: nsdelegate
# is what makes the kernel refuse a write from inside a cgroup namespace to the
# namespace root's own limits, so without it a writable cgroupfs would let root
# in the sandbox raise the container's memory and pids caps.
cg = {"v2": False, "nsdelegate": False}
try:
    for line in open("/proc/self/mountinfo"):
        fields = line.split()
        if len(fields) > 4 and fields[4] == "/sys/fs/cgroup" and "-" in fields:
            rest = fields[fields.index("-") + 1:]
            cg["v2"] = rest[0] == "cgroup2"
            cg["nsdelegate"] = "nsdelegate" in (rest[2] if len(rest) > 2 else "").split(",")
except OSError:
    pass
out["cgroup"] = cg
print(json.dumps(out))
`;

/**
 * The Landlock ABI Berth's policy needs to be fully enforced. agent-init always
 * handles network rights (AccessNet, ABI 4, Linux 6.7), and write rights
 * including truncate (ABI 3). On an older ABI its best-effort ruleset drops what
 * the kernel can't do and reports PartiallyEnforced, which a production image
 * (BERTH_REQUIRE_ENFORCEMENT=1) refuses to run under. A probe that only checks
 * whether a ruleset denies a write says ACTIVE on those kernels, so the ABI is
 * part of the verdict.
 */
export const MIN_LANDLOCK_ABI = 4;

/** True when a probe that enforces did so below the ABI Berth's policy needs. */
function belowRequiredAbi(abi: number | null | undefined): abi is number {
  return typeof abi === "number" && abi < MIN_LANDLOCK_ABI;
}

/** Raw probe result, as parsed from the container's stdout. */
export interface LandlockProbeResult {
  status: "enforcing" | "present_not_enforcing" | "unsupported";
  abi?: number | null;
  reason?: string;
  fuse?: boolean;
  /** The container's /sys/fs/cgroup mount: cgroup v2, and mounted with nsdelegate. Absent from a probe (or a cached answer) that predates the question. */
  cgroup?: CgroupProbe;
}

/** What per-app cgroups need from the kernel. See cgroupDelegationForBoot(). */
export interface CgroupProbe {
  v2: boolean;
  nsdelegate: boolean;
}

/** How long the probe container gets before we give up on it. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Picks an image to run the probe in. It must contain python3, which every Berth
 * app image does (`base.Dockerfile` installs it).
 *
 * Preferring an image that is already local matters more than it looks: a
 * diagnostic command that silently pulls hundreds of megabytes before answering
 * is one people stop running. When nothing local qualifies, the caller is told
 * rather than having a pull started for them.
 */
export async function findProbeImage(docker: Docker): Promise<string | undefined> {
  const images = await docker.listImages({});
  const tags = images.flatMap((i) => (i.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>"));
  // A Berth app image is the safest bet: it is the thing that will actually be
  // booted, so probing it answers the question about the image in play, not
  // about some other image that happens to be lying around.
  // Both prefixes Berth tags with: `berth/<app>:dev` from `berth dev`, and
  // `berth-agent/<app>:<ts>` from a Computer/demo boot. Missing the second
  // meant a user who had just run the hero demo still got UNKNOWN.
  return (
    tags.find((t) => t.startsWith("berth/") || t.startsWith("berth-agent/")) ??
    tags.find((t) => /^(python|.*\/python):/.test(t))
  );
}

/**
 * Pulled only when no local image qualifies — which is every fresh install,
 * since the README has people run `berth doctor` before they build anything.
 * Landlock support is a property of the kernel, not the image, so any
 * image with python3 answers the same question. Small, official, pinned by
 * tag; `--image` or `--no-probe` avoid the pull entirely.
 */
export const PROBE_FALLBACK_IMAGE = "python:3.13-alpine";

async function pullProbeImage(docker: Docker): Promise<string | undefined> {
  try {
    const stream = await docker.pull(PROBE_FALLBACK_IMAGE);
    await new Promise<void>((resolve, reject) =>
      docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve())),
    );
    return PROBE_FALLBACK_IMAGE;
  } catch {
    return undefined;
  }
}

/**
 * Runs the kernel probe inside `image`.
 *
 * The container gets the same `Devices` and `CapAdd` that `startContainer()`
 * uses, so the FUSE answer describes a real Berth sandbox rather than a bare
 * `docker run`.
 */
export async function probeKernel(docker: Docker, image: string, runtime?: string): Promise<LandlockProbeResult> {
  const container = await docker.createContainer({
    Image: image,
    Entrypoint: ["python3"],
    Cmd: ["-c", LANDLOCK_PROBE],
    // Nothing here is privileged. Landlock is unprivileged by design, and these
    // two exist only so the FUSE answer matches a real boot.
    HostConfig: {
      AutoRemove: false,
      Devices: [{ PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" }],
      CapAdd: ["SYS_ADMIN"],
      // When a hardened runtime is selected (BERTH_RUNTIME / M1.4), the kernel
      // being probed is that runtime's — under gVisor the sentry, not the
      // host's Linux. Probing the default runtime and booting under another
      // would answer a question about a kernel the sandbox never runs on.
      ...(runtime ? { Runtime: runtime } : {}),
    },
  });

  try {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    // Resolved on stream end, not on container exit. `wait()` can — and in
    // practice does — resolve before the last of the attached output has been
    // delivered, which reads as a probe that printed nothing. Found by a test
    // whose fake daemon exposed the ordering that a real one only hits
    // intermittently, which is the worse way to find it.
    const drained = new Promise<void>((resolve) => {
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.on("error", () => resolve());
    });

    await container.start();
    const timer = setTimeout(() => void container.kill().catch(() => {}), PROBE_TIMEOUT_MS);
    try {
      await container.wait();
      await drained;
    } finally {
      clearTimeout(timer);
    }

    // Docker multiplexes attach output with an 8-byte header per frame. Rather
    // than demultiplex it properly for one line of JSON, find the JSON object —
    // the probe prints exactly one, and a header byte can't open one.
    const raw = Buffer.concat(chunks).toString("utf-8");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`probe produced no JSON. Output was: ${raw.trim().slice(0, 400) || "(empty)"}`);
    }
    return JSON.parse(raw.slice(start, end + 1)) as LandlockProbeResult;
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

export interface RunDoctorOptions {
  docker?: Docker;
  /** Image to run the kernel probe in. Defaults to a local Berth app image. */
  image?: string;
  /**
   * Skip the container probe. The report then reports `landlock` and `fuse` as
   * `unknown` — never as passing, because a check that didn't run has not passed.
   */
  skipProbe?: boolean;
  /**
   * Overrides the container probe. Exists for tests: the `enforcing` branch
   * cannot be reached on a macOS developer machine at all, and a verdict table
   * that is only ever exercised in its failing half is exactly the kind of
   * thing that looks verified while being untested.
   */
  probe?: (docker: Docker, image: string, runtime?: string) => Promise<LandlockProbeResult>;
  /**
   * Runtime the sandbox would boot with (`HostConfig.Runtime`) — the probe
   * runs under it, and the `runtime` check verifies the daemon has it.
   * Defaults to `BERTH_RUNTIME`, same resolution `startContainer()` uses.
   */
  runtime?: string;
  /** Pull PROBE_FALLBACK_IMAGE when no local image qualifies. Default true. */
  pullProbeImage?: boolean;
  /** Test seam for that pull; resolves to the image pulled, or undefined. */
  pull?: (docker: Docker) => Promise<string | undefined>;
}

/**
 * Builds the report. Every failure mode is a `DoctorCheck`, not a thrown error:
 * `berth doctor` is the command people run *because* something is broken, so it
 * has to survive a broken daemon and say what it found.
 */
export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  // Which daemon, and why — the first thing to know when the answer is
  // surprising. Only meaningful when we chose it; a caller-supplied client
  // (--fix's re-check against Colima) says its own endpoint.
  const endpoint = options.docker ? undefined : applyDockerContext();
  const docker = options.docker ?? new Docker();
  const checks: DoctorCheck[] = [];
  const via = endpoint ? ` — via ${describeDockerHost(endpoint)}` : "";
  let daemon: DoctorReport["daemon"];
  let daemonRuntimes: { names: string[]; default?: string } | undefined;
  const envRuntime = process.env.BERTH_RUNTIME;
  const runtime = options.runtime ?? (envRuntime === "" ? undefined : envRuntime);

  // --- Docker ------------------------------------------------------------
  // First, and gating: every kernel fact below comes from a container, so an
  // unreachable daemon makes the rest unknowable rather than merely unchecked.
  // It used to be worse — nothing in the repo called
  // ping(), so a stopped daemon surfaced as a raw dockerode socket error.
  let dockerReachable = false;
  try {
    // The `docker` CLI refuses a selected context it can't find, rather than
    // quietly dialing the default socket — which on a Mac is Docker Desktop,
    // the very daemon a user who selected Colima was moving away from.
    if (endpoint?.problem) throw new Error("the selected Docker context can't be used");
    await docker.ping();
    const info = (await docker.info()) as {
      KernelVersion?: string;
      OperatingSystem?: string;
      ServerVersion?: string;
      Architecture?: string;
      SecurityOptions?: string[];
      Runtimes?: Record<string, unknown>;
      DefaultRuntime?: string;
    };
    daemonRuntimes = { names: Object.keys(info.Runtimes ?? {}), default: info.DefaultRuntime };
    dockerReachable = true;
    daemon = {
      kernelVersion: info.KernelVersion ?? "unknown",
      operatingSystem: info.OperatingSystem ?? "unknown",
      serverVersion: info.ServerVersion ?? "unknown",
      arch: info.Architecture ?? "unknown",
      securityOptions: info.SecurityOptions ?? [],
    };
    checks.push({
      id: "docker",
      title: "Docker daemon reachable",
      status: "ok",
      detail: `${daemon.operatingSystem} (${daemon.serverVersion}), kernel ${daemon.kernelVersion} on ${daemon.arch}${via}`,
    });
  } catch (err) {
    checks.push({
      id: "docker",
      title: "Docker daemon reachable",
      status: "fail",
      detail: `could not reach the Docker daemon: ${err instanceof Error ? err.message : String(err)}${via}`,
      remedy: endpoint?.problem
        ? `${endpoint.problem}. Start it (e.g. \`colima start\`), or pick another with \`docker context use <name>\`, then run \`berth doctor\` again.`
        : "Start Docker (Docker Desktop, Colima, or `systemctl start docker`) and run `berth doctor` again.",
    });
  }

  // --- seccomp -----------------------------------------------------------
  // From the daemon rather than a container: this is the daemon's default
  // profile, which is what a Berth container gets. agent-init installs two
  // filters of its own regardless, and those are what the capability
  // drop actually depends on — hence `warn`, not `fail`, when the default is off.
  if (daemon) {
    const seccomp = daemon.securityOptions.find((o) => o.startsWith("name=seccomp"));
    const unconfined = seccomp?.includes("profile=unconfined") ?? false;
    checks.push({
      id: "seccomp",
      title: "Docker's default seccomp profile",
      status: !seccomp ? "warn" : unconfined ? "warn" : "ok",
      detail: !seccomp
        ? "the daemon reports no seccomp support"
        : unconfined
          ? "the daemon's default profile is `unconfined`"
          : seccomp.replace("name=seccomp,", ""),
      remedy: seccomp && !unconfined
        ? undefined
        : "Berth's own seccomp filters (the namespace and datagram-socket denials agent-init installs) do not depend on this, so it is not fatal — but the defence-in-depth Docker would normally add is absent.",
    });
  }

  // --- runtime -------------------------------------------------------------
  // The hardened-runtime check. Informational when nothing
  // was requested; a hard failure when BERTH_RUNTIME names a runtime the
  // daemon doesn't have, because every boot would then fail at createContainer.
  if (daemonRuntimes) {
    const available = daemonRuntimes.names.length > 0 ? daemonRuntimes.names.sort().join(", ") : "(daemon reported none)";
    const gvisor = daemonRuntimes.names.includes("runsc");
    if (runtime && !daemonRuntimes.names.includes(runtime)) {
      checks.push({
        id: "runtime",
        title: "Container runtime for sandboxes",
        status: "fail",
        detail: `BERTH_RUNTIME=${runtime}, but the daemon has no runtime by that name — available: ${available}`,
        remedy:
          runtime === "runsc"
            ? "Install gVisor and register it with the daemon (https://gvisor.dev/docs/user_guide/install/ — `runsc install` writes the daemon config), then restart Docker."
            : `Register "${runtime}" in the daemon's runtimes config, or unset BERTH_RUNTIME.`,
      });
    } else {
      checks.push({
        id: "runtime",
        title: "Container runtime for sandboxes",
        status: "ok",
        detail: runtime
          ? `sandboxes boot with Runtime "${runtime}" (BERTH_RUNTIME); daemon default is "${daemonRuntimes.default ?? "unknown"}"`
          : `daemon default "${daemonRuntimes.default ?? "unknown"}"; available: ${available}`,
        remedy:
          !runtime && gvisor
            ? "gVisor (runsc) is registered — set BERTH_RUNTIME=runsc to boot sandboxes under it as defense-in-depth against container escape. It is not a substitute for the in-kernel enforcement; run `berth doctor` again with it set, since the probed kernel becomes gVisor's sentry."
            : undefined,
      });
    }
  }

  // --- the kernel probe --------------------------------------------------
  let probeImage = options.image ?? (dockerReachable ? await findProbeImage(docker).catch(() => undefined) : undefined);
  let pulledProbeImage = false;
  if (!probeImage && dockerReachable && !options.skipProbe && options.pullProbeImage !== false) {
    probeImage = await (options.pull ?? pullProbeImage)(docker);
    pulledProbeImage = probeImage !== undefined;
  }

  const runtimeMissing = checks.find((c) => c.id === "runtime")?.status === "fail";
  if (options.skipProbe || !dockerReachable || !probeImage || runtimeMissing) {
    const detail = !dockerReachable
      ? "not run — the Docker daemon is unreachable, and this check runs inside a container"
      : runtimeMissing
        ? `not run — the requested runtime "${runtime}" is not registered with the daemon, so the probe container cannot start under it`
        : options.skipProbe
          ? "not run — probe skipped"
          : `not run — no local image with python3 to probe in, and pulling ${PROBE_FALLBACK_IMAGE} failed (offline?)`;
    const remedy = !dockerReachable || options.skipProbe || runtimeMissing
      ? undefined
      : `Pull ${PROBE_FALLBACK_IMAGE}, build any Berth app (\`berth dev <app>\` builds one), or pass \`--image <image>\` to probe a specific one.`;
    checks.push({ id: "landlock", title: "Landlock enforcement in the container kernel", status: "unknown", detail, remedy });
    checks.push({ id: "fuse", title: "/dev/fuse available to a sandbox", status: "unknown", detail, remedy });
    checks.push({ id: "cgroups", title: CGROUPS_TITLE, status: "unknown", detail, remedy });
  } else {
    try {
      const probe = await (options.probe ?? probeKernel)(docker, probeImage, runtime);
      const landlock = landlockCheck(probe, runtime);
      if (pulledProbeImage) landlock.detail += ` (probed in ${probeImage}, pulled because no local Berth image was found)`;
      checks.push(landlock);
      checks.push({
        id: "fuse",
        title: "/dev/fuse available to a sandbox",
        status: probe.fuse ? "ok" : "warn",
        detail: probe.fuse
          ? "present when requested as a device"
          : "not present even with /dev/fuse requested and CAP_SYS_ADMIN added",
        remedy: probe.fuse
          ? undefined
          : "Semantic FS mounts /context over FUSE, so it will not come up. On a Linux host, `modprobe fuse`; in a VM, ensure the FUSE module is in the guest kernel.",
      });
      checks.push(cgroupsCheck(probe.cgroup, runtime));
    } catch (err) {
      const detail = `probe failed to run in ${probeImage}: ${err instanceof Error ? err.message : String(err)}`;
      checks.push({ id: "landlock", title: "Landlock enforcement in the container kernel", status: "unknown", detail });
      checks.push({ id: "fuse", title: "/dev/fuse available to a sandbox", status: "unknown", detail });
      checks.push({ id: "cgroups", title: CGROUPS_TITLE, status: "unknown", detail });
    }
  }

  const landlock = checks.find((c) => c.id === "landlock");
  const enforcementActive = landlock?.status === "ok";
  const enforcementDetermined = landlock?.status === "ok" || landlock?.status === "fail";
  const reasons = enforcementActive ? [] : collectReasons(checks);

  // Three verdicts, not two. Saying "NOT ACTIVE" when the probe never ran would
  // be asserting a fact that wasn't checked — the same overclaim this command
  // exists to prevent, made by the command itself.
  const verdict = enforcementActive
    ? "enforcement: ACTIVE"
    : enforcementDetermined
      ? `enforcement: NOT ACTIVE (${reasons.join("; ")})`
      : `enforcement: UNKNOWN (${reasons.join("; ")})`;

  return {
    schemaVersion: 1,
    enforcementActive,
    enforcementDetermined,
    verdict,
    reasons,
    checks,
    daemon,
    probeImage: probeImage && !options.skipProbe ? probeImage : undefined,
  };
}

/**
 * Turns a probe result into a check. The three statuses are deliberately not
 * collapsed: "the syscall isn't there" and "the syscall is there and does
 * nothing" need different remedies, and the second is the one that has fooled
 * people, because every call in the sandbox path succeeds.
 */
function landlockCheck(probe: LandlockProbeResult, runtime?: string): DoctorCheck {
  // Under a hardened runtime the "container kernel" is that runtime's — for
  // gVisor the sentry — so the title says which kernel actually answered.
  const base = {
    id: "landlock" as const,
    title: `Landlock enforcement in the container kernel${runtime ? ` (runtime "${runtime}")` : ""}`,
  };
  switch (probe.status) {
    case "enforcing":
      if (belowRequiredAbi(probe.abi)) {
        return {
          ...base,
          status: "fail",
          detail: `Landlock enforces here, but at ABI ${probe.abi}; Berth's policy needs ABI ${MIN_LANDLOCK_ABI} (Linux 6.7+), so it is only partly applied: network rules are not, and a production image refuses to start`,
          remedy:
            "Run Berth on a Linux 6.7+ kernel. `berth dev` still runs here with the rules this kernel supports, but outbound network is not restricted by Landlock. On macOS, `berth doctor --fix` sets up a VM with a new enough kernel.",
        };
      }
      return {
        ...base,
        status: "ok",
        detail: `a ruleset granting nothing denied a write (ABI ${probe.abi ?? "?"}) — ${probe.reason ?? "enforced"}`,
      };
    case "present_not_enforcing":
      return {
        ...base,
        status: "fail",
        detail: `the Landlock syscalls exist (ABI ${probe.abi ?? "?"}) but a ruleset granting nothing did NOT deny a write — landlock is not in this kernel's active LSM stack`,
        remedy:
          "This is the dangerous shape: every call Berth makes succeeds and nothing is enforced. Add landlock to the kernel's LSM stack (`lsm=...,landlock` on the kernel command line) or use a host whose kernel has it enabled.",
      };
    case "unsupported":
      return {
        ...base,
        status: "fail",
        detail: `the Landlock syscalls are not available in this kernel${probe.reason ? ` (${probe.reason})` : ""}`,
        remedy:
          "Berth's filesystem and network capabilities cannot be enforced here. On macOS, Docker Desktop's linuxkit kernel has no Landlock — see docs/mac-enforcement.md for a Lima/Colima recipe with a kernel that does.",
      };
  }
}

const CGROUPS_TITLE = "Per-app resource limits (cgroup v2 delegation)";

/**
 * Whether a sandbox's apps can each get their own cgroup. `warn`, never
 * `fail`: without it the container-level caps still hold, and what is lost is
 * the division between apps, not the sandbox's bound. It is also not part of
 * the enforcement verdict, which is about Landlock.
 */
function cgroupsCheck(cgroup: CgroupProbe | undefined, runtime?: string): DoctorCheck {
  const verdict = cgroupDelegationVerdict(cgroup, runtime);
  return {
    id: "cgroups",
    title: CGROUPS_TITLE,
    status: verdict.delegate ? "ok" : cgroup ? "warn" : "unknown",
    detail: verdict.delegate
      ? "cgroup v2 with nsdelegate: each app gets its own cgroup and limits, and the daemons a reserved one"
      : `per-app cgroups are off: ${verdict.reason}. Each app still has the sandbox's container-level caps, but not a limit of its own`,
    remedy: verdict.delegate || !cgroup
      ? undefined
      : "Run Berth on a host whose cgroup2 hierarchy is mounted with nsdelegate (systemd hosts, Colima and Lima all do), with Docker 28 or later. See docs/resource-limits.md.",
  };
}

/** The `reasons` list, in the order a reader should act on them. */
function collectReasons(checks: DoctorCheck[]): string[] {
  const reasons: string[] = [];
  for (const id of ["docker", "runtime", "landlock", "fuse", "seccomp"] as const) {
    const check = checks.find((c) => c.id === id);
    if (!check) continue;
    if (check.status === "fail") reasons.push(check.detail);
    else if (check.status === "unknown" && id === "landlock") reasons.push(`landlock ${check.detail}`);
  }
  return reasons.length > 0 ? reasons : ["no enforcement check passed"];
}

// --- the boot-time banner ------------------------------------------------
//
// The gap this closes is specific and was
// worse than a missing warning: on a kernel without Landlock, and when
// enforcement is not *required* (which is every `berth dev`, the primary
// workflow), agent-init printed
//
//     [agent-init] restricted "filesystem" — write access allowed only under: …
//
// That sentence is false on such a host. Nothing was restricted. A developer had
// to know to distrust it, which is exactly the kind of thing nobody knows.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface CacheFile {
  /** Keyed by the daemon's kernel + arch: the answer changes only when that does. */
  [kernelAndArch: string]: {
    status: LandlockProbeResult["status"];
    abi?: number | null;
    reason?: string;
    cgroup?: CgroupProbe;
    probedAt: string;
  };
}

function cachePath(): string {
  return join(process.env.BERTH_HOME ?? join(homedir(), ".berth"), "enforcement-cache.json");
}

function readCache(): CacheFile {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf-8")) as CacheFile;
  } catch {
    return {};
  }
}

function writeCache(cache: CacheFile): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A cache that can't be written costs a probe per boot, which is a
    // performance problem and not a correctness one. Never fatal.
  }
}

/** Printed at most once per process — a banner repeated per app in a multi-app boot is a banner people learn to skip. */
let bannerPrinted = false;

/** Exported for tests, which would otherwise see the first test's banner suppress every later one. */
export function resetBannerState(): void {
  bannerPrinted = false;
}

export function unenforcedBanner(detail: string): string {
  const line = "─".repeat(72);
  return [
    line,
    "  ENFORCEMENT IS NOT ACTIVE ON THIS HOST",
    "",
    `  ${detail}`,
    "",
    "  Capabilities in berth.yml are still compiled and still recorded, but the",
    "  kernel is not refusing anything: an undeclared write or connection will",
    "  succeed. This host is not a security boundary. Run `berth doctor` for the",
    "  details, and see docs/mac-enforcement.md for a host where it is real.",
    line,
  ].join("\n");
}

/**
 * The banner for a kernel that enforces Landlock, but below the ABI Berth's
 * policy needs. Separate from unenforcedBanner() because "nothing is refused"
 * would be false here: undeclared writes are refused, undeclared connections
 * are not.
 */
export function partialEnforcementBanner(detail: string): string {
  const line = "─".repeat(72);
  return [
    line,
    "  ENFORCEMENT IS ONLY PARTLY ACTIVE ON THIS HOST",
    "",
    `  ${detail}`,
    "",
    "  An undeclared write is refused, but an undeclared outbound connection is",
    "  not. Treat this host as unrestricted on the network. Run `berth doctor`",
    "  for the details.",
    line,
  ].join("\n");
}

/**
 * Determines, and caches, whether the daemon's kernel can enforce Landlock.
 *
 * Cached because this is a property of a kernel, not of a boot, and re-probing
 * on every `berth dev` would add a container start to the primary workflow. The
 * key is the kernel version and architecture, so a kernel upgrade re-probes on
 * its own without anyone remembering to clear anything.
 *
 * `opts.fresh` bypasses the cache *read* (a fresh result is still written back).
 * Attestation passes it, and must: the cache lives at
 * `$BERTH_HOME/enforcement-cache.json`, which the operator can write, so a
 * cached verdict is an operator-supplied input rather than a measurement. It is
 * the right trade for a boot banner — the cost of a stale answer there is a
 * missing warning — and the wrong one for an attestation record, where
 * `doctorProbe` is one of the two measurements `deriveEnforcementStatus()`
 * requires to say ACTIVE. Reading the cache there would let one edit to one
 * JSON file forge half of that verdict without any kernel being probed.
 */
export async function enforcementStatusForBoot(
  docker: Docker,
  image: string,
  runtime?: string,
  opts: { fresh?: boolean; needsCgroup?: boolean } = {},
): Promise<{ status: LandlockProbeResult["status"] | "unknown"; abi?: number | null; reason?: string; cgroup?: CgroupProbe }> {
  let key: string;
  try {
    const info = (await docker.info()) as { KernelVersion?: string; Architecture?: string };
    // The runtime is part of the key because it is part of the answer: under
    // gVisor the kernel doing (or not doing) the enforcing is the sentry, and
    // a verdict cached for runc must not silence the banner under runsc.
    key = `${info.KernelVersion ?? "unknown"}|${info.Architecture ?? "unknown"}${runtime ? `|${runtime}` : ""}`;
  } catch {
    return { status: "unknown" };
  }

  const cache = readCache();
  // A cached answer from before the probe asked about cgroups is still a
  // good Landlock answer, but not a complete one: re-probe once, and the
  // entry written back has both.
  if (!opts.fresh) {
    const hit = cache[key];
    if (hit && (hit.cgroup || !opts.needsCgroup)) return { status: hit.status, abi: hit.abi, reason: hit.reason, cgroup: hit.cgroup };
  }

  try {
    const probe = await probeKernel(docker, image, runtime);
    cache[key] = { status: probe.status, abi: probe.abi, reason: probe.reason, cgroup: probe.cgroup, probedAt: new Date().toISOString() };
    writeCache(cache);
    return { status: probe.status, abi: probe.abi, reason: probe.reason, cgroup: probe.cgroup };
  } catch {
    // Deliberately not cached: a probe that failed to run tells us nothing about
    // the kernel, and caching it would suppress the banner until the kernel
    // changed.
    return { status: "unknown" };
  }
}

/**
 * Prints the banner when — and only when — enforcement was positively determined
 * to be off.
 *
 * `unknown` stays silent on purpose. A preflight that cries wolf whenever it
 * couldn't reach something is one people configure away, and then the real
 * banner goes unread too. `berth doctor` is where `unknown` is reported as
 * `unknown`, because someone running it is asking the question directly.
 */
export async function warnIfEnforcementInactive(docker: Docker, image: string, runtime?: string): Promise<void> {
  if (bannerPrinted) return;
  if (process.env.BERTH_NO_ENFORCEMENT_BANNER === "1") return;

  try {
    const { status, abi, reason } = await enforcementStatusForBoot(docker, image, runtime);
    if (status === "enforcing" && belowRequiredAbi(abi)) {
      bannerPrinted = true;
      console.warn(
        partialEnforcementBanner(
          `This kernel's Landlock is ABI ${abi}; Berth's policy needs ABI ${MIN_LANDLOCK_ABI} (Linux 6.7+), and a production image will refuse to start here.`,
        ),
      );
    } else if (status === "unsupported") {
      bannerPrinted = true;
      console.warn(
        unenforcedBanner(
          runtime
            ? `The "${runtime}" runtime's kernel has no Landlock support${reason ? ` (${reason})` : ""} — under gVisor that kernel is the sentry, whatever the host kernel has. Unset BERTH_RUNTIME to get the host kernel's enforcement back.`
            : `This kernel has no Landlock support${reason ? ` (${reason})` : ""}. On macOS that is Docker Desktop's linuxkit kernel.`,
        ),
      );
    } else if (status === "present_not_enforcing") {
      bannerPrinted = true;
      console.warn(
        unenforcedBanner(
          "The Landlock syscalls exist here but a ruleset granting nothing did not deny a write — landlock is not in this kernel's active LSM stack. Every call Berth makes will succeed and none of them will enforce.",
        ),
      );
    }
  } catch {
    // Never let a diagnostic stop a boot.
  }
}

// --- per-app cgroups ----------------------------------------------------------

/**
 * Whether startContainer() should hand this sandbox a writable cgroup
 * subtree (`--security-opt writable-cgroups=true`), so entrypoint.sh can give
 * each app its own cgroup and the daemons a reserved one.
 *
 * Docker mounts /sys/fs/cgroup read-only in an unprivileged container, and
 * the only other ways to a writable one are CAP_SYS_ADMIN (to remount it) or
 * `--privileged`, both of which the sandbox exists not to have. Docker 28's
 * writable-cgroups option makes the container's own cgroup namespace
 * writable to root in it and nothing else — the container never sees an
 * ancestor, and the capability set is unchanged. That is only a safe grant
 * with nsdelegate on the host's cgroup2 mount, which is what makes the
 * kernel refuse (EPERM) a write from inside the namespace to the namespace
 * root's own limit files, the ones Docker's `--memory`/`--pids-limit` live
 * in. Without it, root in the sandbox could raise the very caps that bound
 * the sandbox. So: delegate only when the probe saw both, and otherwise boot
 * with the container-level caps alone.
 */
export function cgroupDelegationVerdict(cgroup: CgroupProbe | undefined, runtime?: string): { delegate: boolean; reason: string } {
  if (process.env.BERTH_DISABLE_APP_CGROUPS === "1") return { delegate: false, reason: "BERTH_DISABLE_APP_CGROUPS=1" };
  if (!cgroup) return { delegate: false, reason: "the kernel probe did not run, so cgroup delegation could not be checked" };
  if (!cgroup.v2) return { delegate: false, reason: `the container's /sys/fs/cgroup is not cgroup v2${runtime ? ` under the "${runtime}" runtime` : ""}` };
  if (!cgroup.nsdelegate) {
    return {
      delegate: false,
      reason: "the host's cgroup2 mount has no nsdelegate, so a writable cgroup namespace would let root in the sandbox raise the sandbox's own limits",
    };
  }
  return { delegate: true, reason: "cgroup v2 with nsdelegate" };
}

/** The verdict for a boot, from the same cached probe the enforcement banner uses. Never throws. */
export async function cgroupDelegationForBoot(docker: Docker, image: string, runtime?: string): Promise<{ delegate: boolean; reason: string }> {
  if (process.env.BERTH_DISABLE_APP_CGROUPS === "1") return cgroupDelegationVerdict(undefined);
  try {
    const { cgroup } = await enforcementStatusForBoot(docker, image, runtime, { needsCgroup: true });
    return cgroupDelegationVerdict(cgroup, runtime);
  } catch {
    return cgroupDelegationVerdict(undefined, runtime);
  }
}

/**
 * BERTH_REQUIRE_APP_CGROUPS: refuse to boot a sandbox whose apps would not
 * each get their own cgroup, rather than running them bounded only by the
 * container's caps. The cgroup counterpart of BERTH_REQUIRE_ENFORCEMENT, and
 * spelled the same way (`1` or `true`). Production images set it (see
 * base.Dockerfile), and so does Computer.boot(); dev images leave it unset,
 * and a dev boot without delegation warns instead.
 */
export function appCgroupsRequired(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * The strict-mode decision for a boot: the refusal to raise, or undefined when
 * the boot may go ahead. `delegation` is cgroupDelegationVerdict()'s answer,
 * or, when the daemon turned the option down at create time, that reason.
 * Only the host half of the check: entrypoint.sh makes the same refusal
 * inside the sandbox, which also covers a limit the kernel would not take.
 */
export function appCgroupsRefusal(required: boolean, delegation: { delegate: boolean; reason: string }): string | undefined {
  if (!required || delegation.delegate) return undefined;
  return (
    `BERTH_REQUIRE_APP_CGROUPS is set but per-app cgroups are unavailable: ${delegation.reason}. ` +
    "Refusing to boot apps bounded only by the sandbox's container-level caps. " +
    "Per-app cgroups need cgroup v2 mounted with nsdelegate and Docker 28 or later (`berth doctor` checks); " +
    "set BERTH_REQUIRE_APP_CGROUPS=0 to boot without them."
  );
}
