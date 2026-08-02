import Docker from "dockerode";
import type { BerthManifest } from "@berth/manifest-schema";

const BROWSER_PORTS = { vnc: "5900", novnc: "6080", cdp: "9222" } as const;
const TERMINAL_PORT = "7681";

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
   */
  bindMount?: { hostPath: string; containerPath: string };
  /** Working directory inside the container — defaults to the bind mount's containerPath, or /app. */
  workingDir?: string;
  /** Named volume used for the on_install marker file, so warm restarts skip reinstalling. */
  installMarkerVolume?: string;
  /**
   * Additional `host:container` bind-mount strings, appended after
   * `bindMount`/`installMarkerVolume`'s own binds. Used by `berth snapshot
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
  docker?: Docker;
}

export interface RunningContainer {
  container: Docker.Container;
  /** Host-mapped ports, populated only for apps declaring a browser:* or terminal:* capability. */
  ports: { vnc?: number; novnc?: number; cdp?: number; terminal?: number };
}

export async function startContainer(options: StartContainerOptions): Promise<RunningContainer> {
  const docker = options.docker ?? new Docker();
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

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  if (wantsBrowserPorts) {
    for (const port of Object.values(BROWSER_PORTS)) {
      exposedPorts[`${port}/tcp`] = {};
      portBindings[`${port}/tcp`] = [{ HostPort: "" }]; // "" = let Docker assign a free host port
    }
  }
  if (wantsTerminalPort) {
    exposedPorts[`${TERMINAL_PORT}/tcp`] = {};
    portBindings[`${TERMINAL_PORT}/tcp`] = [{ HostPort: "" }];
  }

  const workingDir = options.workingDir ?? options.bindMount?.containerPath ?? "/app";

  const binds: string[] = [];
  if (options.bindMount) binds.push(`${options.bindMount.hostPath}:${options.bindMount.containerPath}`);
  if (options.installMarkerVolume) binds.push(`${options.installMarkerVolume}:${workingDir}/.berth`);
  if (options.extraBinds) binds.push(...options.extraBinds);

  // Only set when there's more than one app — entrypoint.sh's single-app
  // branch (today's exact behavior) runs whenever this is absent, so a
  // one-app `apps` array is equivalent to omitting `apps` entirely.
  const env = { ...options.env };
  if (options.apps && options.apps.length > 1) {
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

  const container = await docker.createContainer({
    name: options.name,
    Image: options.image,
    WorkingDir: workingDir,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
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
  if (wantsBrowserPorts || wantsTerminalPort) {
    ports = await waitForPortMappings(container, { browser: wantsBrowserPorts, terminal: wantsTerminalPort });
  }

  return { container, ports };
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
  needs: { browser: boolean; terminal: boolean },
  attempts = 20,
  delayMs = 100,
): Promise<RunningContainer["ports"]> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const inspect = await container.inspect();
    const mapped = inspect.NetworkSettings.Ports;
    const ports: RunningContainer["ports"] = {
      vnc: hostPort(mapped[`${BROWSER_PORTS.vnc}/tcp`]),
      novnc: hostPort(mapped[`${BROWSER_PORTS.novnc}/tcp`]),
      cdp: hostPort(mapped[`${BROWSER_PORTS.cdp}/tcp`]),
      terminal: hostPort(mapped[`${TERMINAL_PORT}/tcp`]),
    };
    const browserReady = !needs.browser || (ports.vnc && ports.novnc && ports.cdp);
    const terminalReady = !needs.terminal || ports.terminal;
    if (browserReady && terminalReady) return ports;
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

export async function stopContainer(container: Docker.Container): Promise<void> {
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
