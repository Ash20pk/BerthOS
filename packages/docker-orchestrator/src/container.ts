import Docker from "dockerode";
import { warnIfEnforcementInactive } from "./doctor.js";
import {
  CONTAINER_APP_SECRETS_DIR,
  CONTAINER_SECRETS_PATH,
  partitionSecretEnv,
  partitionSecretsPerApp,
  removeContainerSecretsDir,
  writeContainerSecretsFile,
  writePerAppSecretsFiles,
} from "./secrets.js";
import { randomBytes } from "node:crypto";
import type { BerthManifest } from "@berth/manifest-schema";

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
/** Container-internal port for @berth/sdk's HTTP RPC bridge — see StartContainerOptions.httpRpc. Same numeric default DEFAULT_FLEET_RPC_PORT (@berth/agents' network.ts) uses for a remote fleet deploy's bridge, for consistency, though the two are independent (this is a container-internal Docker port; that's a value baked into a remote instance's env). */
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
 * A resource limit applies to the whole container, but a multi-app container
 * shares one container across several manifests — takes the max of each
 * field across every app sharing it, so no app's declared need for CPU/
 * memory/GPU is silently capped below what it actually asked for just
 * because a companion app in the same container declared less (or nothing).
 * Undefined stays undefined (no field declared by anyone => no limit set),
 * distinct from `0` (which the schema already rejects as non-positive).
 */
export function maxResources(manifests: BerthManifest[]): { cpu?: number; memoryMb?: number; gpu?: number } {
  const result: { cpu?: number; memoryMb?: number; gpu?: number } = {};
  for (const manifest of manifests) {
    const r = manifest.resources;
    if (r.cpu !== undefined) result.cpu = Math.max(result.cpu ?? 0, r.cpu);
    if (r.memory_mb !== undefined) result.memoryMb = Math.max(result.memoryMb ?? 0, r.memory_mb);
    if (r.gpu !== undefined) result.gpu = Math.max(result.gpu ?? 0, r.gpu);
  }
  return result;
}

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
   * (e.g. `@berth/sdk -> ../../../../packages/sdk`) that point outside the
   * app's own directory tree, and those symlinks dangle unless the sibling
   * package directories are present at the same relative path inside the
   * container. Omit for test/prod, where a real (non-symlinked) image was
   * already built via `npm ci`.
   *
   * `readOnly` mounts it `:ro`, which `berth dev` uses to stop an app with
   * `filesystem:write:/workspace` writing the developer's own repository —
   * `.git/hooks/pre-commit`, any `package.json`'s scripts, or its own
   * `berth.yml` (REMEDIATION.md 1.6). Writable paths are then mounted back
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
   * that moved to a build layer (REMEDIATION.md 1.5) there is no marker, and
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
   * another by name for agent-to-agent networking (see @berth/agents's
   * Crew.networked()). The default bridge network provides no such DNS.
   */
  network?: string;
  /** berth-mesh-coordinator URL for network:peer:* apps — passed through as BERTH_MESH_COORDINATOR_URL. Omitted, mesh-daemon falls back to its own default (see docs/mesh-reference.md). */
  meshCoordinatorUrl?: string;
  /**
   * Starts @berth/sdk's HTTP RPC bridge (`startHttpRpcServer`, gated by
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

export async function startContainer(options: StartContainerOptions): Promise<RunningContainer> {
  const docker = options.docker ?? new Docker();

  // Before anything else, because a banner printed after a screenful of app
  // logs is a banner nobody reads. Cached per kernel, so this costs one probe
  // container on the first boot after a kernel change and nothing after that.
  // Best-effort by construction: it never throws and never blocks a boot.
  await warnIfEnforcementInactive(docker, options.image);
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
  // lone app — see @berth/agents' Computer.connect().
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

  // Every sandbox mounts /context via FUSE unconditionally (see the Devices/
  // CapAdd comment below), so /dev/fuse + SYS_ADMIN are always present.
  // /dev/net/tun + NET_ADMIN are added only when an app actually declares
  // network:peer:* — a container-wide grant that would otherwise reach the
  // resident app's own process too, if not for agent-init dropping the whole
  // capability bounding set before exec-ing into it (see
  // packages/agent-init/src/main.rs and docs/mesh-reference.md).
  const devices: { PathOnHost: string; PathInContainer: string; CgroupPermissions: string }[] = [
    { PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" },
  ];
  const capAdd = ["SYS_ADMIN"];
  if (needsMesh) {
    devices.push({ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" });
    capAdd.push("NET_ADMIN");
  }

  // Unset (the default) leaves every sandbox exactly as unbounded as it's
  // always been — this only ever narrows behavior for an app that opts in
  // via berth.yml's `resources:`, never for one that doesn't.
  const resources = maxResources(options.apps?.map((a) => a.manifest) ?? [options.manifest]);
  const deviceRequests: Docker.DeviceRequest[] | undefined = resources.gpu
    ? [{ Driver: "nvidia", Count: resources.gpu, Capabilities: [["gpu"]] }]
    : undefined;

  // The 5.5 split. Everything a name marks as a credential — the RPC bearer
  // token and the terminal/VNC passwords generated above, plus whatever the
  // caller passed (a provider API key reaching a networked agent's own
  // container is the motivating case; see @berth/agents' bootNetworkedAgent)
  // — leaves `Env` entirely and travels through a 0600 host file mounted
  // read-only at CONTAINER_SECRETS_PATH, which entrypoint.sh sources before
  // any daemon or app starts. Same process environment for the app either
  // way; the difference is that `docker inspect`, every `docker commit` of
  // this container, and every snapshot built from one now contain the names'
  // absence rather than their values.
  //
  // No secrets, no mount: a container whose environment holds nothing
  // sensitive is byte-for-byte what it was before this existed.
  const { plain, secret } = partitionSecretEnv(env);

  // The M1.3 split on top of the 5.5 one: a secret name declared by any
  // app's `secrets:` list leaves the shared file and travels in that app's
  // own file instead, delivered by entrypoint.sh as 0600 owned by that
  // app's uid and sourced only in that app's subshell. Manifests with no
  // `secrets:` partition everything into `shared`, so a container that
  // declares nothing is byte-for-byte what it was before this existed.
  const appDeclarations = (options.apps ?? [{ name: options.manifest.name, manifest: options.manifest }]).map(
    (a) => ({ name: a.name, secrets: a.manifest.secrets ?? [] }),
  );
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

  const container = await docker.createContainer({
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
      // tests reach a host-side mock/grants server through that name
      // (grants-server-milestone.mjs, github-assistant-milestone.mjs), which
      // otherwise silently fails to resolve in CI while working locally on
      // a Mac, masking the difference until the request itself times out.
      // A no-op wherever host.docker.internal already resolves.
      ExtraHosts: ["host.docker.internal:host-gateway"],
      // Every sandbox mounts the Phase 4 semantic filesystem at /context via
      // FUSE (see docker/entrypoint.sh), which needs the /dev/fuse device
      // node plus CAP_SYS_ADMIN to call mount(2) — unconditional, the same
      // way context-bus-daemon always starts, since /context isn't gated
      // behind any manifest capability the way browser:* ports are.
      Devices: devices,
      CapAdd: capAdd,
      ...(resources.cpu !== undefined ? { NanoCpus: Math.round(resources.cpu * 1e9) } : {}),
      ...(resources.memoryMb !== undefined ? { Memory: resources.memoryMb * 1024 * 1024 } : {}),
      ...(deviceRequests ? { DeviceRequests: deviceRequests } : {}),
      // The default docker-default AppArmor profile denies the FUSE
      // mount(2) syscall outright even with CAP_SYS_ADMIN + /dev/fuse
      // (moby/moby#50013) — a no-op on hosts with no AppArmor LSM active
      // (e.g. Docker Desktop's LinuxKit VM), but on real-kernel Linux
      // (GitHub Actions' ubuntu-latest) it silently kills semantic-fs-daemon's
      // mount, which then falls back to a stub that always returns empty
      // query results — passing locally while failing in CI.
      SecurityOpt: ["apparmor:unconfined"],
    },
    ...(options.network
      ? { NetworkingConfig: { EndpointsConfig: { [options.network]: {} } } }
      : {}),
  });

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
export async function stopContainer(container: Docker.Container, options: { secretsRunDir?: string } = {}): Promise<void> {
  // Before stopping, because inspect() is the only way back to the container
  // *name* the secrets file was written under, and a removed container can no
  // longer be inspected. Best-effort throughout: the file is 0600 in a 0700
  // directory and is overwritten by the next boot of the same name, so
  // failing to unlink it must not turn a successful teardown into an error.
  await removeSecretsForContainer(container, options.secretsRunDir);
  try {
    await container.stop();
  } catch (err) {
    // Already stopped is fine; anything else surfaces to the caller.
    if (!(err as { statusCode?: number }).statusCode || (err as { statusCode?: number }).statusCode !== 304) {
      throw err;
    }
  }
  await container.remove({ force: true });
}

/**
 * Deliberately not called from `restartContainer()`: a restart re-runs
 * entrypoint.sh, which sources the secrets file again, so removing it there
 * would leave the app's second life without the credentials its first one
 * had.
 */
async function removeSecretsForContainer(container: Docker.Container, secretsRunDir?: string): Promise<void> {
  try {
    const info = await container.inspect();
    // Docker reports names with a leading slash ("/berth-dev-app").
    const name = info.Name?.replace(/^\//, "");
    if (name) await removeContainerSecretsDir(name, secretsRunDir);
  } catch {
    // Already gone, or the daemon went away — nothing to clean up that the
    // next boot of this name won't overwrite anyway.
  }
}

/**
 * Phase 1's hot-reload mechanism restarts the whole container rather than
 * exec-ing a fresh process inside a live one. On_install hooks are skipped on
 * restart via the marker file (see @berth/sdk's run-lifecycle.ts), so this stays fast —
 * a finer-grained "restart just the app process" is a later optimization,
 * not required for the Phase 1 workflow to feel responsive.
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
