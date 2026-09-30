/**
 * What `resources:` in berth.yml means for one app's cgroup, and what the
 * sandbox around every app's cgroup needs on top of that.
 *
 * Lives here rather than in either consumer because two of them must agree on
 * it: the policy compilers (@berthos/sdk's generate-capability-policy.ts and
 * its Python mirror, which write one app's limits into its capability policy
 * for entrypoint.sh to apply) and docker-orchestrator (which sizes the
 * container those cgroups sit in). A container cap computed from one set of
 * defaults around per-app cgroups written from another would leave the daemon
 * reserve to whichever happened to be larger.
 *
 * The values are the cgroup v2 interface files themselves, as the strings
 * written to them. That is deliberate: the same files exist in a Berth-owned
 * microVM's guest kernel, so the in-sandbox half never has to be translated
 * again, and a policy file can be read by a person who knows cgroups without
 * knowing Berth.
 */

/** The CFS period every `cpu.max` uses, in microseconds — the kernel's own default. */
export const CPU_PERIOD_US = 100_000;

/** The kernel refuses a `cpu.max` quota below 1ms. A declared `cpu` that small is rounded up to it rather than failing the boot. */
const MIN_CPU_QUOTA_US = 1_000;

/**
 * `pids.max` for an app that declares no `pids`. It counts threads, not just
 * processes, which is why it isn't smaller: one Node runtime is a dozen tasks
 * before the app does anything, and Chromium under Playwright is several
 * hundred across its browser, GPU, network and renderer processes. A fork bomb
 * still stops at 1024 tasks — in its own cgroup, not the container's.
 */
export const DEFAULT_APP_PIDS = 1024;

/** `cpu.weight` every app gets: the kernel default, i.e. an equal share when apps contend. */
export const DEFAULT_APP_CPU_WEIGHT = 100;

/**
 * `memory.high` as a fraction of `memory.max`. Past `memory.high` the kernel
 * throttles and reclaims the app instead of killing it, so an app that
 * overshoots gradually slows down first, and only one that keeps allocating
 * reaches `memory.max` and the OOM killer.
 */
const MEMORY_HIGH_NUMERATOR = 9;
const MEMORY_HIGH_DENOMINATOR = 10;

/**
 * What the berth daemons and brokers (context-bus, semantic-fs, the egress and
 * GitHub brokers, mesh, and every `docker exec` RPC relay) keep regardless of
 * what the apps do. Added to the container's cap on top of the apps' sum, and
 * subtracted again inside the sandbox from what the apps' parent cgroup may
 * use, so an app can exhaust its own budget and every app's together without
 * reaching the daemons'.
 *
 * `cpu` is only used when every app declares one (otherwise nothing caps the
 * container's CPU, and the daemons' cgroup weight is what protects them).
 */
export const DAEMON_RESERVE = { cpu: 0.5, memoryMb: 256, pids: 1024 } as const;

/** The daemons' `cpu.weight`, against the apps' parent cgroup at the default 100: ten to one when both want the CPU. */
export const DAEMON_CPU_WEIGHT = 1000;

/** The subset of `resources:` that shapes a cgroup. `gpu` is a device request, not a cgroup limit. */
export interface CgroupResources {
  cpu?: number;
  memory_mb?: number;
  pids?: number;
}

/**
 * The cgroup interface files for one app, in the order entrypoint.sh writes
 * them, as `file -> value`. Undeclared keys produce no file except the two
 * every app gets (`cpu.weight`, `pids.max`) — no `memory.max` means the app is
 * bounded by the apps' shared budget, not by nothing.
 *
 * The arithmetic is integer-exact and rounds half up, so the Python compiler's
 * mirror (berth_sdk.manifest.app_cgroup_limits) can match it byte for byte;
 * tests/test_policy_parity.py holds the two to that.
 */
export function appCgroupLimits(resources: CgroupResources): Record<string, string> {
  const limits: Record<string, string> = {
    "cpu.weight": String(DEFAULT_APP_CPU_WEIGHT),
  };
  if (resources.cpu !== undefined) {
    const quota = Math.max(MIN_CPU_QUOTA_US, Math.floor(resources.cpu * CPU_PERIOD_US + 0.5));
    limits["cpu.max"] = `${quota} ${CPU_PERIOD_US}`;
  }
  if (resources.memory_mb !== undefined) {
    const bytes = resources.memory_mb * 1024 * 1024;
    limits["memory.high"] = String(Math.floor((bytes * MEMORY_HIGH_NUMERATOR) / MEMORY_HIGH_DENOMINATOR));
    limits["memory.max"] = String(bytes);
    // A limit an app can page its way past isn't one.
    limits["memory.swap.max"] = "0";
  }
  limits["pids.max"] = String(resources.pids ?? DEFAULT_APP_PIDS);
  return limits;
}

/** The container-level limits for a sandbox holding these apps. */
export interface SandboxResources {
  /** Cores. Set only when every app declares `cpu`. */
  cpu?: number;
  /** MiB. Set only when every app declares `memory_mb`. */
  memoryMb?: number;
  /** Always set: every app has a task limit, declared or default. */
  pids: number;
  /** GPU count — the largest any app asks for; see below. */
  gpu?: number;
}

/**
 * The sum of the apps' limits plus the daemon reserve. It used to be the max
 * across apps, applied to the whole container, which let one app's
 * declaration cap its neighbours and let an undeclared app use all of a
 * declared one's budget.
 *
 * A key is summed only when every app declares it. One undeclared app has no
 * number to add, and inventing one would cap an app that asked for nothing at
 * a size nobody chose; the container is then bounded by the host for that
 * resource, and inside it the apps' parent cgroup still leaves the daemons
 * their reserve. `pids` always has a number, so it is always summed.
 *
 * `gpu` stays the max. A GPU is a device handed to the container, shared by
 * every process in it, and no cgroup controller divides it between apps;
 * summing counts would ask the host for GPUs no app would get to itself.
 */
export function sandboxResources(apps: readonly { resources: CgroupResources & { gpu?: number } }[]): SandboxResources {
  const all = (key: "cpu" | "memory_mb") => apps.length > 0 && apps.every((a) => a.resources[key] !== undefined);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const result: SandboxResources = {
    pids: sum(apps.map((a) => a.resources.pids ?? DEFAULT_APP_PIDS)) + DAEMON_RESERVE.pids,
  };
  if (all("cpu")) result.cpu = sum(apps.map((a) => a.resources.cpu!)) + DAEMON_RESERVE.cpu;
  if (all("memory_mb")) result.memoryMb = sum(apps.map((a) => a.resources.memory_mb!)) + DAEMON_RESERVE.memoryMb;
  for (const app of apps) {
    if (app.resources.gpu !== undefined) result.gpu = Math.max(result.gpu ?? 0, app.resources.gpu);
  }
  return result;
}
