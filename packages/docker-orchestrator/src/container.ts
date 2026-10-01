import Docker from "dockerode";
import { appCgroupsRefusal, appCgroupsRequired, cgroupDelegationForBoot, warnIfEnforcementInactive } from "./doctor.js";
import {
  CONTAINER_APP_SECRETS_DIR,
  CONTAINER_SECRETS_PATH,
  partitionSecretEnv,
  partitionSecretsPerApp,
  removeContainerSecretsDir,
  writeContainerSecretsFile,
  writePerAppSecretsFiles,
} from "./secrets.js";
import {
  SIDECAR_EXPORT_DIR,
  startSemanticFsSidecar,
  stopSemanticFsSidecar,
  type RunningSidecar,
} from "./semantic-fs-sidecar.js";
import { randomBytes } from "node:crypto";
import { DAEMON_RESERVE, DEFAULT_APP_PIDS, sandboxResources, type BerthManifest } from "@berthos/manifest-schema";

/**
 * CDP (9222) is deliberately absent. Chromium binds its debugging port to
 * the container's loopback interface (apps/browser-native's cdp-controller),
 * so there is nothing for Docker's proxy to forward — an unauthenticated CDP
 * endpoint is arbitrary local-file read (`Page.navigate("file:///etc/passwd")`)
 * and a complete bypass of the egress broker (`Browser.setDownloadBehavior`),
 * which is too much to hand to anything that can open a TCP connection.
 * Attaching a debugger from the host means `docker exec` into the container,
 * or a deliberate `docker run -p` of your own.
 */
const BROWSER_PORTS = { vnc: "5900", novnc: "6080" } as const;
const TERMINAL_PORT = "7681";
/** Container-internal port for @berthos/sdk's HTTP RPC bridge — see StartContainerOptions.httpRpc. Same numeric default DEFAULT_FLEET_RPC_PORT (@berthos/agents' network.ts) uses for a remote fleet deploy's bridge, for consistency, though the two are independent (this is a container-internal Docker port; that's a value baked into a remote instance's env). */
const HTTP_RPC_CONTAINER_PORT = "7300";

export function declaresBrowserCapability(manifest: BerthManifest): boolean {
  return manifest.capabilities.some((cap) => cap.startsWith("browser:"));
}

export function declaresTerminalCapability(manifest: BerthManifest): boolean {
  return manifest.capabilities.some((cap) => cap.startsWith("terminal:"));
}

/**
 * Whether `berth dev` should publish the VNC/CDP ports to the host for this
 * app — the capability grants the app the ability to drive a browser at
 * all (enforced independent of this), `expose.browser` is the separate,
 * host-visibility-only choice of whether a human can watch it over noVNC.
 * Defaults to true (today's behavior) via ExposeSpec's own default.
 */
export function needsBrowserPorts(manifest: BerthManifest): boolean {
  return declaresBrowserCapability(manifest) && manifest.expose.browser;
}

/** Same reasoning as needsBrowserPorts, for the ttyd terminal port. */
export function needsTerminalPort(manifest: BerthManifest): boolean {
  return declaresTerminalCapability(manifest) && manifest.expose.terminal;
}

/** See docs/mesh-reference.md. Gates the NET_ADMIN/tun device grant below — never reaches the resident app's own process (agent-init drops the whole capability bounding set before exec-ing into it). */
function declaresMeshCapability(manifest: BerthManifest): boolean {
  return manifest.capabilities.some((cap) => cap.startsWith("network:peer:"));
}

/**
 * The container-level half of per-app resource limits: the cap around every
 * app's own cgroup, sized as the sum of the apps plus the daemons' reserve
 * (see @berthos/manifest-schema's sandboxResources()). Each app's own limit is
 * applied inside the sandbox by entrypoint.sh, which is also where it would be
 * applied in a Berth-owned microVM's guest; this is only the outer bound, and
 * the whole bound when Docker cannot delegate a cgroup subtree to the sandbox.
 *
 * `hostCpus` clamps the CPU cap, since Docker refuses a NanoCpus above the
 * host's count — which a sum reaches much sooner than the max this replaced.
 */
export function containerResources(manifests: BerthManifest[], hostCpus?: number): { cpu?: number; memoryMb?: number; pids: number; gpu?: number } {
  const sandbox = sandboxResources(manifests);
  if (sandbox.cpu !== undefined && hostCpus !== undefined && hostCpus > 0) sandbox.cpu = Math.min(sandbox.cpu, hostCpus);
  return sandbox;
}

/** The daemon's CPU count, for containerResources()'s clamp. Undefined when the daemon won't say. */
async function hostCpuCount(docker: Docker): Promise<number | undefined> {
  try {
    const info = (await docker.info()) as { NCPU?: number };
    return typeof info.NCPU === "number" ? info.NCPU : undefined;
  } catch {
    return undefined;
  }
}

/** One variable from an image's own `ENV`, e.g. a production image's BERTH_REQUIRE_APP_CGROUPS=1. Undefined when unset or the image can't be inspected. */
async function imageEnvValue(docker: Docker, image: string, name: string): Promise<string | undefined> {
  try {
    const info = (await docker.getImage(image).inspect()) as { Config?: { Env?: string[] } };
    const entry = info.Config?.Env?.find((e) => e.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  } catch {
    return undefined;
  }
}

/** The security option that makes a container's own cgroup namespace writable to root in it. Docker 28+. */
const WRITABLE_CGROUPS_OPT = "writable-cgroups=true";

export interface StartContainerOptions {
  image: string;
  name: string;
  manifest: BerthManifest;
  /**
   * Bind-mounts a host directory for dev hot reload, and sets the
   * container's working directory to match. For a standalone app this is
   * just `{ hostPath: appDir, containerPath: "/app" }`. For an app that's a
   * pnpm workspace member, it must be the whole workspace root (not just the
   * app's own directory) — pnpm's `node_modules` uses relative symlinks
   * (e.g. `@berthos/sdk -> ../../../../packages/sdk`) that point outside the
   * app's own directory tree, and those symlinks dangle unless the sibling
   * package directories are present at the same relative path inside the
   * container. Omit for test/prod, where a real (non-symlinked) image was
   * already built via `npm ci`.
   *
   * `readOnly` mounts it `:ro`, which `berth dev` uses to stop an app with
   * `filesystem:write:/workspace` writing the developer's own repository —
   * `.git/hooks/pre-commit`, any `package.json`'s scripts, or its own
   * `berth.yml`. Writable paths are then mounted back
   * over it; see the CLI's resolveDevBindMount(). It defaults to off, so the
   * milestone tests that mount the repo root read-write on purpose keep
   * working unchanged.
   */
  bindMount?: { hostPath: string; containerPath: string; readOnly?: boolean };
  /** Working directory inside the container — defaults to the bind mount's containerPath, or /app. */
  workingDir?: string;
  /**
   * Named volume mounted over the app's `.berth/` directory. It used to hold
   * the on_install marker that made warm restarts skip reinstalling; since
   * that moved to a build layer there is no marker, and
   * what the volume does now is keep the generated capability policy out of
   * the developer's own working tree, which `berth dev` bind-mounts.
   */
  appStateVolume?: string;
  /**
   * Additional `host:container` bind-mount strings, appended after
   * `bindMount`/`appStateVolume`'s own binds. Used by `berth snapshot
   * restore` to pre-populate a fresh container's semantic-fs backing
   * directory (BERTH_CONTEXT_DATA) from a restored snapshot's on-disk
   * archive, *before* semantic-fs-daemon opens its SQLite index at boot —
   * injecting it into an already-running container via `putArchive` instead
   * would race that boot-time open. Omitted, this changes nothing.
   */
  extraBinds?: string[];
  env?: Record<string, string>;
  /**
   * Companion apps sharing this container — each gets its own real,
   * independent Landlock ruleset (entrypoint.sh runs one `agent-init` per
   * app as sibling backgrounded processes, not one exec'd process for the
   * whole container). `manifest` above stays the *primary* app's manifest,
   * used for `needsBrowserPorts`/`WorkingDir` exactly as today; browser-port
   * logic still assumes at most one app across the whole set needs them
   * (enforced by the CLI's assertAtMostOneBrowserApp before this is called).
   * Omitted (or a single-element array) preserves single-app behavior
   * exactly.
   */
  apps?: { name: string; workingDir: string; manifest: BerthManifest }[];
  /**
   * Joins this container to a Docker user-defined bridge network (created if
   * it doesn't already exist), rather than the default bridge. Containers on
   * a user-defined network resolve each other by container `name` via
   * Docker's embedded DNS — this is what lets one Berth computer reach
   * another by name for agent-to-agent networking (see @berthos/agents's
   * Crew.networked()). The default bridge network provides no such DNS.
   */
  network?: string;
  /** berth-mesh-coordinator URL for network:peer:* apps — passed through as BERTH_MESH_COORDINATOR_URL. Omitted, mesh-daemon falls back to its own default (see docs/mesh-reference.md). */
  meshCoordinatorUrl?: string;
  /**
   * Starts @berthos/sdk's HTTP RPC bridge (`startHttpRpcServer`, gated by
   * BERTH_HTTP_RPC_PORT/TOKEN/APP env vars already read by runtime.ts's
   * main()) inside the container, and maps its port to the host — the same
   * bridge fleet-computer.ts's HttpBridgeComputer uses for a remote deploy,
   * reachable here over a host-mapped port instead of an adapter's URL. This
   * is what lets a process with no Docker API access (a Python client) call
   * a resident app's exports without docker exec/attach. `authToken` is
   * generated by the caller (same shape as HttpBridgeComputer.deploy()'s own
   * `randomBytes(32).toString("hex")`) — this function never invents one
   * itself, so a caller that persists it (e.g. `berth os up`'s state file)
   * controls its own lifecycle. `appName` gates which app in a multi-app
   * container binds the listener (BERTH_HTTP_RPC_APP) — only that one app's
   * exports are reachable via the bridge; omit for a single-app container.
   */
  httpRpc?: { authToken: string; appName?: string };
  /**
   * Host interface every published port binds to. Defaults to `127.0.0.1`,
   * or to `BERTH_PUBLISH_HOST` when that's set — the escape hatch for the
   * genuine "I want to reach this sandbox's terminal from my phone" case,
   * which has to be typed out rather than being what you get by accident.
   * `0.0.0.0` publishes to every interface the host has; `startContainer`
   * logs a warning naming the consequence when it does. An empty value is
   * treated as unset, so `BERTH_PUBLISH_HOST=` in a stray `.env` can't
   * silently widen the binding back to Docker's default.
   */
  publishHost?: string;
  /**
   * Container runtime for the sandbox — Docker's `HostConfig.Runtime`, e.g.
   * `runsc` for gVisor. Defaults to the daemon's default
   * runtime, or to `BERTH_RUNTIME` when that's set (empty means unset, same
   * rule as `BERTH_PUBLISH_HOST`). This is defense-in-depth for the one tier
   * the threat model otherwise answers with "Docker is trusted" — a
   * container-escape 0-day — and is NOT a substitute for the in-container
   * enforcement (M1.1/M1.2): gVisor's sentry is a different kernel, so what
   * Landlock/seccomp enforce there is *its* implementation of them, which the
   * boot-time enforcement probe measures per runtime rather than assuming.
   * The semantic-fs sidecar deliberately does not get this runtime: it must
   * perform a FUSE mount that propagates through the host's mount table
   * (rshared), which a gVisor-sandboxed mount namespace cannot do.
   */
  runtime?: string;
  /**
   * Extra HostConfig.SecurityOpt entries, appended verbatim after the ones
   * this module computes. The one in-repo consumer is
   * attestation-milestone.mjs's control boot, which pins a seccomp profile
   * that ENOSYSes the landlock syscalls so an enforcing host can produce a
   * genuinely NOT_ENFORCED boot — but the shape is general operator config
   * (a custom seccomp/AppArmor profile), same trust tier as BERTH_RUNTIME.
   */
  extraSecurityOpt?: string[];
  /**
   * Where the per-container secrets file is written on the host — defaults to
   * ~/.berth/run/<container name>/secrets.env. Overridable so tests don't
   * touch the real one, the same way snapshotsDir and osDir are.
   */
  secretsRunDir?: string;
  docker?: Docker;
}

export interface RunningContainer {
  container: Docker.Container;
  /** Host-mapped ports, populated only for apps declaring a browser:* or terminal:* capability, or when `httpRpc` was requested. Note there is no `cdp` — see BROWSER_PORTS. */
  ports: { vnc?: number; novnc?: number; terminal?: number; httpRpc?: number };
  /**
   * Per-boot secrets generated for the published human-facing ports, so the
   * caller can print them next to the URL. Generated here rather than inside
   * the container because the host is the only side that can show them to a
   * human — the container can only log them, and a secret in a log stream a
   * resident app can also read isn't much of one. Undefined for a port that
   * wasn't published at all.
   */
  credentials: {
    /** `user:password` for ttyd's `--credential`, i.e. HTTP basic auth on the terminal. */
    terminal?: string;
    /** VNC password, for both the raw 5900 port and the noVNC page on 6080. */
    vnc?: string;
  };
}

/**
 * VNC's classic authentication truncates to 8 bytes (a DES key), so a longer
 * one would be silently cut down and give a false sense of its strength.
 * 8 bytes of base64url is ~48 bits, which is fine for a credential that only
 * lives as long as one container and is only reachable over loopback by
 * default. ttyd has no such limit, so it gets a full 32 bytes.
 */
const VNC_PASSWORD_BYTES = 6; // 6 bytes -> 8 base64 chars
function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function resolvePublishHost(explicit: string | undefined): string {
  const value = explicit ?? process.env.BERTH_PUBLISH_HOST;
  if (value === undefined || value === "") return "127.0.0.1";
  return value;
}

/** Same empty-means-unset rule as resolvePublishHost, so a stray `BERTH_RUNTIME=` in a .env can't select a runtime named "". */
function resolveRuntime(explicit: string | undefined): string | undefined {
  const value = explicit ?? process.env.BERTH_RUNTIME;
  return value === undefined || value === "" ? undefined : value;
}

export async function startContainer(options: StartContainerOptions): Promise<RunningContainer> {
  const docker = options.docker ?? new Docker();
  const runtime = resolveRuntime(options.runtime);

  // Before anything else, because a banner printed after a screenful of app
  // logs is a banner nobody reads. Cached per kernel (and per runtime — under
  // gVisor the kernel being probed is the sentry, not the host's), so this
  // costs one probe container on the first boot after a kernel change and
  // nothing after that. Best-effort by construction: it never throws and
  // never blocks a boot.
  await warnIfEnforcementInactive(docker, options.image, runtime);

  // Whether this sandbox's apps can each get a cgroup of their own, decided
  // here, before the sidecar or any secrets file exists, so that a strict
  // boot (BERTH_REQUIRE_APP_CGROUPS, which production images set) that
  // cannot have them is refused with nothing to clean up. The caller's env
  // wins over the image's, as it does in the container.
  const delegation = await cgroupDelegationForBoot(docker, options.image, runtime);
  const cgroupsRequired = appCgroupsRequired(
    options.env?.BERTH_REQUIRE_APP_CGROUPS ?? (await imageEnvValue(docker, options.image, "BERTH_REQUIRE_APP_CGROUPS")),
  );
  const cgroupsRefused = appCgroupsRefusal(cgroupsRequired, delegation);
  if (cgroupsRefused) throw new Error(cgroupsRefused);
  if (!delegation.delegate) {
    console.warn(
      `[berth] per-app cgroups are off for ${options.name}: ${delegation.reason}. Each app is bounded only by the sandbox's container-level caps. ` +
        "Set BERTH_REQUIRE_APP_CGROUPS=1 to refuse such a boot instead; see docs/resource-limits.md.",
    );
  }
  const wantsBrowserPorts =
    options.apps && options.apps.length > 0
      ? options.apps.some((a) => needsBrowserPorts(a.manifest))
      : needsBrowserPorts(options.manifest);
  const wantsTerminalPort =
    options.apps && options.apps.length > 0
      ? options.apps.some((a) => needsTerminalPort(a.manifest))
      : needsTerminalPort(options.manifest);
  const needsMesh =
    options.apps && options.apps.length > 0
      ? options.apps.some((a) => declaresMeshCapability(a.manifest))
      : declaresMeshCapability(options.manifest);
  const wantsHttpRpc = !!options.httpRpc;

  const publishHost = resolvePublishHost(options.publishHost);

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  // HostIp is what decides whether the LAN can reach these. Docker's own
  // default for an omitted HostIp is 0.0.0.0 — every interface the host has —
  // which for a writable terminal and a VNC session is an open door on any
  // routable network. "" as the HostPort still means "assign a free one".
  const publish = (port: string) => {
    exposedPorts[`${port}/tcp`] = {};
    portBindings[`${port}/tcp`] = [{ HostIp: publishHost, HostPort: "" }];
  };
  if (wantsBrowserPorts) for (const port of Object.values(BROWSER_PORTS)) publish(port);
  if (wantsTerminalPort) publish(TERMINAL_PORT);
  if (wantsHttpRpc) publish(HTTP_RPC_CONTAINER_PORT);

  const workingDir = options.workingDir ?? options.bindMount?.containerPath ?? "/app";

  const binds: string[] = [];
  if (options.bindMount) {
    binds.push(
      `${options.bindMount.hostPath}:${options.bindMount.containerPath}${options.bindMount.readOnly ? ":ro" : ""}`,
    );
  }
  if (options.appStateVolume) binds.push(`${options.appStateVolume}:${workingDir}/.berth`);
  if (options.extraBinds) binds.push(...options.extraBinds);

  // Set whenever the caller passes a non-empty `apps` array — including a
  // single-element one. No existing caller does that today (every call site
  // uses the `apps.length > 1 ? [...] : undefined` pattern, so a one-app
  // array was never actually reachable before); `berth os up` is the first
  // caller that deliberately passes exactly one app here, specifically to
  // get entrypoint.sh's multi-app branch (and thus a per-app RPC socket a
  // separate host process can reconnect to via invokeAppExport) even for a
  // lone app — see @berthos/agents' Computer.connect().
  const env = { ...options.env };
  if (options.apps && options.apps.length > 0) {
    env.BERTH_APPS = JSON.stringify(options.apps.map((a) => ({ name: a.name, workingDir: a.workingDir })));
  }
  // Unconditional (harmless when no app declares network:peer:* — mesh-daemon
  // just never starts, per entrypoint.sh's grep gate). A stable, container-
  // scoped identity is what lets mesh-coordinator give this container the
  // same mesh IP across a `berth dev` restart, rather than the container's
  // own randomly-assigned Docker hostname. See docs/mesh-reference.md.
  env.BERTH_MESH_PEER_NAME = options.name;
  // Tells entrypoint.sh that this container path is the host's source tree,
  // bind-mounted, rather than a directory in the image. Only then may a Python
  // app import the checkout's own packages/sdk-python instead of the image's
  // /opt/berth/sdk-python. Without the flag the entrypoint cannot tell a real
  // checkout from a production /workspace an app wrote a berth_sdk/ into.
  // Set last, over options.env, so a caller's env cannot point it elsewhere.
  if (options.bindMount) {
    env.BERTH_DEV_SOURCE_MOUNT = options.bindMount.containerPath;
  } else {
    delete env.BERTH_DEV_SOURCE_MOUNT;
  }
  if (options.meshCoordinatorUrl) {
    env.BERTH_MESH_COORDINATOR_URL = options.meshCoordinatorUrl;
  }
  if (options.httpRpc) {
    env.BERTH_HTTP_RPC_PORT = HTTP_RPC_CONTAINER_PORT;
    env.BERTH_HTTP_RPC_TOKEN = options.httpRpc.authToken;
    if (options.httpRpc.appName) env.BERTH_HTTP_RPC_APP = options.httpRpc.appName;
  }

  // Generated per boot, only for the ports actually being published. Both are
  // consumed by processes started inside the container (entrypoint.sh's
  // x11vnc, apps/terminal's ttyd) — see the note on RunningContainer.credentials
  // for why the host generates them rather than the container.
  const credentials: RunningContainer["credentials"] = {};
  if (wantsTerminalPort) {
    credentials.terminal = `berth:${randomSecret(24)}`;
    env.BERTH_TERMINAL_CREDENTIAL = credentials.terminal;
  }
  if (wantsBrowserPorts) {
    credentials.vnc = randomSecret(VNC_PASSWORD_BYTES);
    env.BERTH_VNC_PASSWORD = credentials.vnc;
  }

  if (publishHost !== "127.0.0.1" && publishHost !== "localhost" && (wantsBrowserPorts || wantsTerminalPort || wantsHttpRpc)) {
    console.warn(
      `[berth] WARNING: publishing this sandbox's ports on ${publishHost}, not loopback — the terminal, VNC, and RPC bridge will be reachable from any host that can route to this machine. They are credential-gated, but that is the only thing standing in the way.`,
    );
  }

  if (options.network) {
    await ensureNetwork(docker, options.network);
  }

  // /context's FUSE mount comes from a per-sandbox sidecar container, so the
  // sandbox itself gets no SYS_ADMIN, no /dev/fuse, and no AppArmor
  // exception — `mount(2)` inside it fails EPERM for every process, root
  // daemons included. If the sidecar's mount cannot propagate on this host,
  // the boot goes on without /context rather than quietly taking the pre-M1.1
  // in-sandbox mount; BERTH_DISABLE_FS_SIDECAR=1 asks for that posture
  // explicitly, with the
  // capability and a loud warning, so `docker inspect` always tells the
  // truth about which posture this container has. /dev/net/tun + NET_ADMIN are added only when an app
  // actually declares network:peer:* (see docs/mesh-reference.md).
  const devices: { PathOnHost: string; PathInContainer: string; CgroupPermissions: string }[] = [];
  const capAdd: string[] = [];
  const securityOpt: string[] = [];
  let sidecar: RunningSidecar | undefined;
  // Three postures, not two. BERTH_DISABLE_FS_SIDECAR=1 does NOT mean "no
  // semantic FS" — it means "mount it inside the sandbox instead", which puts
  // CAP_SYS_ADMIN back on this container. There was no way to say "this boot
  // does not need /context at all", so every boot paid for a second container
  // and a transient SYS_ADMIN window even when nothing would ever read
  // /context. BERTH_NO_SEMANTIC_FS=1 is that third option: no sidecar, no
  // in-sandbox mount, no /dev/fuse, no SYS_ADMIN anywhere, and no boot wait
  // for a socket nothing will use.
  //
  // Opt-in, and it stays opt-in: an app that does reach /context (or an agent
  // using checkpointing, sessions, or trace, which are Semantic-FS-backed)
  // gets @berthos/sdk's loud "semantic-fs daemon not reachable" error rather
  // than silently wrong results — see runtime.ts's createUnavailableSemanticFs.
  // Defaulting this on would mean deciding for the caller which of those they
  // use, and the failure is remote from the cause, so the caller declares it.
  let semanticFsDisabled = process.env.BERTH_NO_SEMANTIC_FS === "1";
  if (semanticFsDisabled) {
    // The entrypoint needs to know too, or it starts the in-container daemon
    // and then polls /proc/mounts for 5s waiting on a mount nobody will make.
    env.BERTH_NO_SEMANTIC_FS = "1";
    console.warn(
      "[berth] semantic FS is off (BERTH_NO_SEMANTIC_FS=1): no /context mount, no sidecar, and no CAP_SYS_ADMIN anywhere in this boot. Anything that reads /context — including agent checkpointing, sessions, and trace — will fail loudly.",
    );
  }
  if (!semanticFsDisabled && process.env.BERTH_DISABLE_FS_SIDECAR !== "1") {
    // `berth snapshot restore` pre-populates the daemon's backing paths via
    // extraBinds targeting /var/berth/* — the daemon lives in the sidecar
    // now, so those binds are re-aimed at its export dir. The sandbox keeps
    // its own copies too (they land on top of the read-only /var/berth
    // view), so snapshot *creation* from a restored sandbox still reads the
    // same bytes.
    const sidecarVarBinds = (options.extraBinds ?? [])
      .filter((bind) => bind.split(":")[1]?.startsWith("/var/berth/"))
      .map((bind) => {
        const [host, target, ...rest] = bind.split(":");
        const mapped = `${SIDECAR_EXPORT_DIR}/var/${target!.slice("/var/berth/".length)}`;
        return [host, mapped, ...rest].join(":");
      });
    // The same 10000+index assignment entrypoint.sh makes — declared to the
    // sidecar's daemon so it can attribute FUSE writes by uid across the
    // pid-namespace boundary.
    const appUidMap = (options.apps ?? [{ name: options.manifest.name }])
      .map((app, index) => `${app.name}=${10000 + index}`)
      .join(",");
    try {
      sidecar = await startSemanticFsSidecar({
        sandboxName: options.name,
        image: options.image,
        docker,
        runDir: options.secretsRunDir,
        extraBinds: sidecarVarBinds,
        appUidMap,
      });
    } catch (err) {
      // Degrade to less, never to more. This used to fall through to the
      // in-sandbox mount, so a host problem the caller never saw handed
      // CAP_SYS_ADMIN to the app container — the one capability the
      // sandbox's no-mount(2) claim rests on. It is always the case on
      // Docker Desktop for Mac, whose file sharing isn't a shared mount.
      // Now the boot takes the BERTH_NO_SEMANTIC_FS=1 posture instead: no
      // /context, no capability, and @berthos/sdk's /context calls throw
      // (createUnavailableSemanticFs) rather than return empty results.
      semanticFsDisabled = true;
      env.BERTH_NO_SEMANTIC_FS = "1";
      console.warn(
        `[berth] WARNING: semantic-fs sidecar failed, so this boot has no /context (and no CAP_SYS_ADMIN): ` +
          `/context reads, writes and queries will throw. ${(err as Error).message}\n` +
          `  To mount /context inside the sandbox instead, accepting CAP_SYS_ADMIN on it: BERTH_DISABLE_FS_SIDECAR=1\n` +
          `  To silence this on a host that never needs /context: BERTH_NO_SEMANTIC_FS=1`,
      );
    }
  }
  if (sidecar) {
    binds.push(...sidecar.sandboxBinds);
  } else if (semanticFsDisabled) {
    // Nothing to add: the whole point of this posture is that no mount is
    // attempted, so neither the device nor the capability is needed. Falling
    // through to the branch below would hand SYS_ADMIN to a boot that
    // explicitly said it does not want a FUSE mount at all.
  } else {
    // Only reachable by asking: BERTH_DISABLE_FS_SIDECAR=1. A failed sidecar
    // no longer lands here (it turns semantic FS off above).
    console.warn(
      "[berth] WARNING: BERTH_DISABLE_FS_SIDECAR=1 — mounting /context inside the sandbox, which puts CAP_SYS_ADMIN, /dev/fuse and apparmor:unconfined on this container (pre-M1.1 posture).",
    );
    devices.push({ PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" });
    capAdd.push("SYS_ADMIN");
    // The default docker-default AppArmor profile denies the FUSE mount(2)
    // syscall outright even with CAP_SYS_ADMIN + /dev/fuse (moby/moby#50013)
    // — only needed on the legacy path, where the mount happens in here.
    securityOpt.push("apparmor:unconfined");
  }
  if (options.extraSecurityOpt) securityOpt.push(...options.extraSecurityOpt);
  if (needsMesh) {
    devices.push({ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" });
    capAdd.push("NET_ADMIN");
  }

  // Per-app resource limits. Every sandbox now has a task cap (an app that
  // declares no `pids` still gets DEFAULT_APP_PIDS), while CPU and memory
  // are capped at the container only when every app declares them — see
  // containerResources(). Inside, entrypoint.sh gives each app its own
  // cgroup when this container is handed a writable cgroup namespace, which
  // happens only where the host makes that safe (cgroupDelegationForBoot).
  const manifests = options.apps?.map((a) => a.manifest) ?? [options.manifest];
  const needsCpuClamp = manifests.every((m) => m.resources.cpu !== undefined);
  const resources = containerResources(manifests, needsCpuClamp ? await hostCpuCount(docker) : undefined);
  const deviceRequests: Docker.DeviceRequest[] | undefined = resources.gpu
    ? [{ Driver: "nvidia", Count: resources.gpu, Capabilities: [["gpu"]] }]
    : undefined;
  if (delegation.delegate) securityOpt.push(WRITABLE_CGROUPS_OPT);
  // What entrypoint.sh reserves for the daemons inside the sandbox, and the
  // default it applies to an app whose policy it cannot read — the same
  // numbers the caps above were computed from, so the two cannot disagree.
  env.BERTH_DAEMON_MEMORY_RESERVE_MB = String(DAEMON_RESERVE.memoryMb);
  env.BERTH_DEFAULT_APP_PIDS = String(DEFAULT_APP_PIDS);
  env.BERTH_APP_CGROUPS = delegation.delegate ? "delegated" : `off: ${delegation.reason}`;

  // The 5.5 split. Everything a name marks as a credential — the RPC bearer
  // token and the terminal/VNC passwords generated above, plus whatever the
  // caller passed (a provider API key reaching a networked agent's own
  // container is the motivating case; see @berthos/agents' bootNetworkedAgent)
  // — leaves `Env` entirely and travels through a 0600 host file mounted
  // read-only at CONTAINER_SECRETS_PATH, which entrypoint.sh sources before
  // any daemon or app starts. Same process environment for the app either
  // way; the difference is that `docker inspect`, every `docker commit` of
  // this container, and every snapshot built from one now contain the names'
  // absence rather than their values.
  //
  // No secrets, no mount: a container whose environment holds nothing
  // sensitive is byte-for-byte what it was before this existed.
  // Declared names first: a name any app lists under `secrets:` is a secret
  // regardless of what it is called, so the split below cannot miss one whose
  // name does not look like a credential (see partitionSecretEnv).
  const appDeclarations = (options.apps ?? [{ name: options.manifest.name, manifest: options.manifest }]).map(
    (a) => ({ name: a.name, secrets: a.manifest.secrets ?? [] }),
  );
  const { plain, secret } = partitionSecretEnv(env, appDeclarations.flatMap((d) => d.secrets));

  // The M1.3 split on top of the 5.5 one: a secret name declared by any
  // app's `secrets:` list leaves the shared file and travels in that app's
  // own file instead, delivered by entrypoint.sh as 0600 owned by that
  // app's uid and sourced only in that app's subshell. Manifests with no
  // `secrets:` partition everything into `shared`, so a container that
  // declares nothing is byte-for-byte what it was before this existed.
  const { shared, perApp, missing } = partitionSecretsPerApp(secret, appDeclarations);
  for (const { app, name } of missing) {
    // Names only, never values — and loudly, because the app declared it
    // needs this and will otherwise fail somewhere unrelated later.
    console.warn(`[berth] app "${app}" declares secret ${name} in berth.yml, but no value was provided for this boot`);
  }
  if (Object.keys(shared).length > 0) {
    const secretsHostPath = await writeContainerSecretsFile(options.name, shared, options.secretsRunDir);
    binds.push(`${secretsHostPath}:${CONTAINER_SECRETS_PATH}:ro`);
    plain.BERTH_SECRETS_FILE = CONTAINER_SECRETS_PATH;
  }
  const perAppSecretsHostDir = await writePerAppSecretsFiles(options.name, perApp, options.secretsRunDir);
  if (perAppSecretsHostDir) {
    binds.push(`${perAppSecretsHostDir}:${CONTAINER_APP_SECRETS_DIR}:ro`);
    plain.BERTH_APP_SECRETS_DIR = CONTAINER_APP_SECRETS_DIR;
  }
  if (sidecar) Object.assign(plain, sidecar.sandboxEnv);

  const createOptions: Docker.ContainerCreateOptions = {
    name: options.name,
    Image: options.image,
    WorkingDir: workingDir,
    Env: Object.entries(plain).map(([k, v]) => `${k}=${v}`),
    ExposedPorts: exposedPorts,
    // The SDK runtime's RPC server listens on stdin to stay alive — without
    // an open stdin, Docker delivers immediate EOF to a non-interactive
    // container and the process exits as soon as its event loop empties.
    OpenStdin: true,
    StdinOnce: false,
    Tty: false,
    HostConfig: {
      Binds: binds,
      PortBindings: portBindings,
      AutoRemove: false,
      // Docker Desktop (Mac/Windows) resolves host.docker.internal inside
      // every container automatically; native Linux Docker (e.g. GitHub
      // Actions' ubuntu-latest runners) does not, unless told to via this
      // special host-gateway value (Docker 20.10+) — several milestone
      // tests reach a host-side mock server through that name
      // (github-assistant-milestone.mjs, the bench harnesses), which
      // otherwise silently fails to resolve in CI while working locally on
      // a Mac, masking the difference until the request itself times out.
      // A no-op wherever host.docker.internal already resolves.
      ExtraHosts: ["host.docker.internal:host-gateway"],
      // Empty on the sidecar path: /context's FUSE mount
      // is performed by the per-sandbox sidecar, so this container needs no
      // device node and no capability for it. Non-empty only on the legacy
      // fallback (host without rshared propagation, or
      // BERTH_DISABLE_FS_SIDECAR=1) and for the mesh's NET_ADMIN/tun.
      ...(devices.length > 0 ? { Devices: devices } : {}),
      ...(capAdd.length > 0 ? { CapAdd: capAdd } : {}),
      ...(resources.cpu !== undefined ? { NanoCpus: Math.round(resources.cpu * 1e9) } : {}),
      ...(resources.memoryMb !== undefined ? { Memory: resources.memoryMb * 1024 * 1024 } : {}),
      PidsLimit: resources.pids,
      ...(deviceRequests ? { DeviceRequests: deviceRequests } : {}),
      ...(securityOpt.length > 0 ? { SecurityOpt: securityOpt } : {}),
      // The hardened-runtime opt-in. Only the sandbox gets
      // it — the sidecar's FUSE mount needs real host mount propagation, so
      // startSemanticFsSidecar stays on the daemon's default runtime.
      ...(runtime ? { Runtime: runtime } : {}),
    },
    ...(options.network
      ? { NetworkingConfig: { EndpointsConfig: { [options.network]: {} } } }
      : {}),
  };
  let container: Docker.Container;
  try {
    container = await docker.createContainer(createOptions);
  } catch (err) {
    // A daemon older than Docker 28 doesn't know the option and refuses the
    // whole create. The probe can't tell us that in advance, so this is where
    // it's learned: boot again without it, with the container-level caps
    // only, and say so — in the log here and in the sandbox's own boot log.
    if (!delegation.delegate || !/writable-cgroups/i.test((err as Error).message ?? "")) throw err;
    const refused = appCgroupsRefusal(cgroupsRequired, {
      delegate: false,
      reason: `this Docker daemon does not support --security-opt ${WRITABLE_CGROUPS_OPT} (Docker 28+)`,
    });
    if (refused) {
      // Nothing was created, but the sidecar and the secrets files were.
      if (sidecar) await stopSemanticFsSidecar(options.name, docker).catch(() => {});
      await removeContainerSecretsDir(options.name, options.secretsRunDir).catch(() => {});
      throw new Error(refused);
    }
    console.warn(
      `[berth] this Docker daemon does not support --security-opt ${WRITABLE_CGROUPS_OPT} (Docker 28+), so apps in this sandbox get no cgroup of their own — only the sandbox's container-level caps apply.`,
    );
    const host = createOptions.HostConfig!;
    host.SecurityOpt = (host.SecurityOpt ?? []).filter((o: string) => o !== WRITABLE_CGROUPS_OPT);
    if (host.SecurityOpt.length === 0) delete host.SecurityOpt;
    createOptions.Env = (createOptions.Env ?? []).map((e) =>
      e.startsWith("BERTH_APP_CGROUPS=") ? "BERTH_APP_CGROUPS=off: this Docker daemon does not support writable-cgroups" : e,
    );
    container = await docker.createContainer(createOptions);
  }

  await container.start();

  let ports: RunningContainer["ports"] = {};
  if (wantsBrowserPorts || wantsTerminalPort || wantsHttpRpc) {
    ports = await waitForPortMappings(container, { browser: wantsBrowserPorts, terminal: wantsTerminalPort, httpRpc: wantsHttpRpc });
  }

  return { container, ports, credentials };
}

function hostPort(binding: Array<{ HostPort: string }> | undefined): number | undefined {
  const value = binding?.[0]?.HostPort;
  return value ? Number(value) : undefined;
}

/**
 * Docker's NetworkSettings.Ports isn't always populated in the very first
 * inspect() right after start() resolves — a brief async window before the
 * port-publishing proxy is wired up. Poll briefly rather than trusting a
 * single inspect call, so `berth dev` doesn't print an empty port summary
 * for an app that legitimately does have browser:* or terminal:* ports mapped.
 */
async function waitForPortMappings(
  container: Docker.Container,
  needs: { browser: boolean; terminal: boolean; httpRpc: boolean },
  attempts = 20,
  delayMs = 100,
): Promise<RunningContainer["ports"]> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const inspect = await container.inspect();
    const mapped = inspect.NetworkSettings.Ports;
    const ports: RunningContainer["ports"] = {
      vnc: hostPort(mapped[`${BROWSER_PORTS.vnc}/tcp`]),
      novnc: hostPort(mapped[`${BROWSER_PORTS.novnc}/tcp`]),
      terminal: hostPort(mapped[`${TERMINAL_PORT}/tcp`]),
      httpRpc: hostPort(mapped[`${HTTP_RPC_CONTAINER_PORT}/tcp`]),
    };
    const browserReady = !needs.browser || (ports.vnc && ports.novnc);
    const terminalReady = !needs.terminal || ports.terminal;
    const httpRpcReady = !needs.httpRpc || ports.httpRpc;
    if (browserReady && terminalReady && httpRpcReady) return ports;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return {};
}

/**
 * Idempotent: Docker has no "create if missing" network call, so this lists
 * by name filter first and only creates on a miss. Safe to call once per
 * container start — concurrent callers racing to create the same network
 * would get a 409 from Docker, which is treated the same as "already exists".
 */
async function ensureNetwork(docker: Docker, name: string): Promise<void> {
  const existing = await docker.listNetworks({ filters: JSON.stringify({ name: [name] }) });
  if (existing.some((n) => n.Name === name)) return;
  try {
    await docker.createNetwork({ Name: name, Driver: "bridge" });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 409) throw err;
  }
}

/** How many trailing log lines describeContainerFailure() reports — enough to carry entrypoint.sh's boot narration plus agent-init's refusal, without pasting a whole app's startup output into an exception message. */
const FAILURE_LOG_LINES = 40;

export interface ContainerFailure {
  /** The container's exit code, or undefined if Docker didn't report one. */
  exitCode?: number;
  /** Last FAILURE_LOG_LINES lines of combined stdout/stderr, already de-multiplexed and trimmed. */
  logTail: string;
}

/**
 * Why a container isn't (or is no longer) running, in a form worth putting
 * in an exception message. Returns undefined while the container is still
 * running — the caller's problem is then something other than a dead
 * container, and there's nothing useful to add.
 *
 * The motivating case: entrypoint.sh hands off to agent-init, which exits 1
 * with a `capability_enforcement_refused` event on any kernel that doesn't
 * enforce Landlock. Without this, the container is simply gone and the
 * caller's first RPC call fails 30s later with a bare timeout, leaving the
 * real reason only in `docker logs` of a container nobody mentioned.
 *
 * Best-effort throughout: a container Docker has already reaped, or logs it
 * won't hand over, still produce a usable (if emptier) result rather than
 * masking the caller's original error with a second one.
 */
export async function describeContainerFailure(container: Docker.Container): Promise<ContainerFailure | undefined> {
  let exitCode: number | undefined;
  try {
    const info = await container.inspect();
    if (info.State.Running) return undefined;
    exitCode = info.State.ExitCode;
  } catch {
    // Gone entirely (already removed, or the daemon went away) — still worth
    // reporting whatever logs are reachable, so fall through rather than
    // returning undefined, which the caller reads as "container is fine".
  }

  let logTail = "";
  try {
    const raw = await container.logs({ stdout: true, stderr: true, tail: FAILURE_LOG_LINES });
    logTail = demultiplexLogs(raw as unknown as Buffer).trim();
  } catch {
    // Leave logTail empty; the exit code alone is still an improvement.
  }

  return { exitCode, logTail };
}

/**
 * Renders a ContainerFailure as a suffix to append to an error message.
 * Empty string when there's genuinely nothing to say, so callers can
 * concatenate unconditionally.
 */
export function formatContainerFailure(failure: ContainerFailure | undefined): string {
  if (!failure) return "";
  const parts: string[] = [];
  if (failure.exitCode !== undefined) parts.push(`container exited with code ${failure.exitCode}`);
  if (failure.logTail) parts.push(`last ${FAILURE_LOG_LINES} log lines:\n${failure.logTail}`);
  return parts.length > 0 ? ` — ${parts.join("; ")}` : "";
}

/**
 * A non-TTY container's log stream is Docker's multiplexed framing: an
 * 8-byte header per frame (stream type, three reserved bytes, then a big-
 * endian payload length) followed by the payload. Left as-is, those headers
 * render as control-character garbage interleaved with the text. A TTY
 * container's stream has no framing at all, so a buffer that doesn't parse
 * as frames is returned verbatim.
 */
function demultiplexLogs(buffer: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) return buffer.toString("utf8");
    const length = buffer.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    if (end > buffer.length) break;
    chunks.push(buffer.subarray(offset + 8, end).toString("utf8"));
    offset = end;
  }
  return offset === 0 ? buffer.toString("utf8") : chunks.join("");
}

/**
 * `secretsRunDir` must match the one `startContainer()` was given, since that
 * is the only thing that says where this container's secrets file was written
 * — the default is right for every caller that didn't override it, and the
 * override exists for tests.
 */
export async function stopContainer(
  container: Docker.Container,
  options: { secretsRunDir?: string; docker?: Docker } = {},
): Promise<void> {
  // inspect() is the only way back to the container's *name*, which both the
  // secrets directory and the sidecar are keyed by, and a removed container
  // can no longer be inspected — so read it once, first.
  let name: string | undefined;
  try {
    // Docker reports names with a leading slash ("/berth-dev-app").
    name = (await container.inspect()).Name?.replace(/^\//, "");
  } catch {
    // Already gone, or the daemon went away.
  }
  // The semantic-fs sidecar lives and dies with its sandbox. Best-effort.
  if (name) await stopSemanticFsSidecar(name, options.docker ?? new Docker()).catch(() => {});
  try {
    await container.stop();
  } catch (err) {
    // Already stopped is fine; anything else surfaces to the caller.
    if (!(err as { statusCode?: number }).statusCode || (err as { statusCode?: number }).statusCode !== 304) {
      throw err;
    }
  }
  await container.remove({ force: true });
  // Last, not first. The sidecar's host directory (<runDir>/<name>/fs) sits
  // inside this one, and its FUSE mount propagates back to the host (rshared),
  // so removing the directory while the sidecar ran failed on the live mount —
  // silently, since this is best-effort — and left the credentials file
  // behind on every Linux host. Colima's file sharing doesn't carry the mount
  // to the macOS side, which is why it only showed in CI. Best-effort still:
  // the file is 0600 in a 0700 directory and the next boot of this name
  // overwrites it, so failing to unlink must not fail a successful teardown.
  if (name) await removeContainerSecretsDir(name, options.secretsRunDir);
}

/**
 * Phase 1's hot-reload mechanism restarts the whole container rather than
 * exec-ing a fresh process inside a live one. On_install hooks are skipped on
 * restart via the marker file (see @berthos/sdk's run-lifecycle.ts), so this stays fast —
 * a finer-grained "restart just the app process" is a later optimization,
 * not required for the Phase 1 workflow to feel responsive.
 *
 * Deliberately leaves the secrets directory alone, unlike stopContainer(): a
 * restart re-runs entrypoint.sh, which sources the secrets file again, so
 * removing it here would leave the app's second life without the credentials
 * its first one had.
 */
export async function restartContainer(container: Docker.Container): Promise<void> {
  await container.restart();
}

export async function* streamLogs(container: Docker.Container): AsyncGenerator<string> {
  const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 100 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    yield chunk.toString("utf-8");
  }
}
