import Docker from "dockerode";

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
  /** Stable machine-readable id. Part of the `--json` contract; do not rename. */
  id: "docker" | "landlock" | "seccomp" | "fuse";
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
print(json.dumps(out))
`;

/** Raw probe result, as parsed from the container's stdout. */
export interface LandlockProbeResult {
  status: "enforcing" | "present_not_enforcing" | "unsupported";
  abi?: number | null;
  reason?: string;
  fuse?: boolean;
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
  return tags.find((t) => t.startsWith("berth/")) ?? tags.find((t) => /^(python|.*\/python):/.test(t));
}

/**
 * Runs the kernel probe inside `image`.
 *
 * The container gets the same `Devices` and `CapAdd` that `startContainer()`
 * uses, so the FUSE answer describes a real Berth sandbox rather than a bare
 * `docker run`.
 */
export async function probeKernel(docker: Docker, image: string): Promise<LandlockProbeResult> {
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
  probe?: (docker: Docker, image: string) => Promise<LandlockProbeResult>;
}

/**
 * Builds the report. Every failure mode is a `DoctorCheck`, not a thrown error:
 * `berth doctor` is the command people run *because* something is broken, so it
 * has to survive a broken daemon and say what it found.
 */
export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const docker = options.docker ?? new Docker();
  const checks: DoctorCheck[] = [];
  let daemon: DoctorReport["daemon"];

  // --- Docker ------------------------------------------------------------
  // First, and gating: every kernel fact below comes from a container, so an
  // unreachable daemon makes the rest unknowable rather than merely unchecked.
  // This is also REMEDIATION 6.5's complaint — nothing in the repo called
  // ping(), so a stopped daemon surfaced as a raw dockerode socket error.
  let dockerReachable = false;
  try {
    await docker.ping();
    const info = (await docker.info()) as {
      KernelVersion?: string;
      OperatingSystem?: string;
      ServerVersion?: string;
      Architecture?: string;
      SecurityOptions?: string[];
    };
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
      detail: `${daemon.operatingSystem} (${daemon.serverVersion}), kernel ${daemon.kernelVersion} on ${daemon.arch}`,
    });
  } catch (err) {
    checks.push({
      id: "docker",
      title: "Docker daemon reachable",
      status: "fail",
      detail: `could not reach the Docker daemon: ${err instanceof Error ? err.message : String(err)}`,
      remedy: "Start Docker (Docker Desktop, Colima, or `systemctl start docker`) and run `berth doctor` again.",
    });
  }

  // --- seccomp -----------------------------------------------------------
  // From the daemon rather than a container: this is the daemon's default
  // profile, which is what a Berth container gets. agent-init installs two
  // filters of its own regardless (1.2, 1.3), and those are what the capability
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

  // --- the kernel probe --------------------------------------------------
  const probeImage = options.image ?? (dockerReachable ? await findProbeImage(docker).catch(() => undefined) : undefined);

  if (options.skipProbe || !dockerReachable || !probeImage) {
    const detail = !dockerReachable
      ? "not run — the Docker daemon is unreachable, and this check runs inside a container"
      : options.skipProbe
        ? "not run — probe skipped"
        : "not run — no local image with python3 to probe in";
    const remedy = !dockerReachable || options.skipProbe
      ? undefined
      : "Build any Berth app (`berth dev <app>` builds one), or pass `--image <image>` to probe a specific one.";
    checks.push({ id: "landlock", title: "Landlock enforcement in the container kernel", status: "unknown", detail, remedy });
    checks.push({ id: "fuse", title: "/dev/fuse available to a sandbox", status: "unknown", detail, remedy });
  } else {
    try {
      const probe = await (options.probe ?? probeKernel)(docker, probeImage);
      checks.push(landlockCheck(probe));
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
    } catch (err) {
      const detail = `probe failed to run in ${probeImage}: ${err instanceof Error ? err.message : String(err)}`;
      checks.push({ id: "landlock", title: "Landlock enforcement in the container kernel", status: "unknown", detail });
      checks.push({ id: "fuse", title: "/dev/fuse available to a sandbox", status: "unknown", detail });
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
function landlockCheck(probe: LandlockProbeResult): DoctorCheck {
  const base = { id: "landlock" as const, title: "Landlock enforcement in the container kernel" };
  switch (probe.status) {
    case "enforcing":
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

/** The `reasons` list, in the order a reader should act on them. */
function collectReasons(checks: DoctorCheck[]): string[] {
  const reasons: string[] = [];
  for (const id of ["docker", "landlock", "fuse", "seccomp"] as const) {
    const check = checks.find((c) => c.id === id);
    if (!check) continue;
    if (check.status === "fail") reasons.push(check.detail);
    else if (check.status === "unknown" && id === "landlock") reasons.push(`landlock ${check.detail}`);
  }
  return reasons.length > 0 ? reasons : ["no enforcement check passed"];
}

// --- the boot-time banner ------------------------------------------------
//
// REMEDIATION 6.5 / LAUNCH_PLAN WS1.2. The gap this closes is specific and was
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
  [kernelAndArch: string]: { status: LandlockProbeResult["status"]; reason?: string; probedAt: string };
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
 * Determines, and caches, whether the daemon's kernel can enforce Landlock.
 *
 * Cached because this is a property of a kernel, not of a boot, and re-probing
 * on every `berth dev` would add a container start to the primary workflow. The
 * key is the kernel version and architecture, so a kernel upgrade re-probes on
 * its own without anyone remembering to clear anything.
 */
export async function enforcementStatusForBoot(
  docker: Docker,
  image: string,
): Promise<{ status: LandlockProbeResult["status"] | "unknown"; reason?: string }> {
  let key: string;
  try {
    const info = (await docker.info()) as { KernelVersion?: string; Architecture?: string };
    key = `${info.KernelVersion ?? "unknown"}|${info.Architecture ?? "unknown"}`;
  } catch {
    return { status: "unknown" };
  }

  const cache = readCache();
  const hit = cache[key];
  if (hit) return { status: hit.status, reason: hit.reason };

  try {
    const probe = await probeKernel(docker, image);
    cache[key] = { status: probe.status, reason: probe.reason, probedAt: new Date().toISOString() };
    writeCache(cache);
    return { status: probe.status, reason: probe.reason };
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
export async function warnIfEnforcementInactive(docker: Docker, image: string): Promise<void> {
  if (bannerPrinted) return;
  if (process.env.BERTH_NO_ENFORCEMENT_BANNER === "1") return;

  try {
    const { status, reason } = await enforcementStatusForBoot(docker, image);
    if (status === "unsupported") {
      bannerPrinted = true;
      console.warn(
        unenforcedBanner(
          `This kernel has no Landlock support${reason ? ` (${reason})` : ""}. On macOS that is Docker Desktop's linuxkit kernel.`,
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
