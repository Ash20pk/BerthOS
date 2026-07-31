import Docker from "dockerode";
import type { BerthManifest } from "@berth/manifest-schema";

const BROWSER_PORTS = { vnc: "5900", novnc: "6080", cdp: "9222" } as const;

function declaresBrowserCapability(manifest: BerthManifest): boolean {
  return manifest.capabilities.some((cap) => cap.startsWith("browser:"));
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
  env?: Record<string, string>;
  docker?: Docker;
}

export interface RunningContainer {
  container: Docker.Container;
  /** Host-mapped ports, populated only for apps declaring a browser:* capability. */
  ports: { vnc?: number; novnc?: number; cdp?: number };
}

export async function startContainer(options: StartContainerOptions): Promise<RunningContainer> {
  const docker = options.docker ?? new Docker();
  const needsBrowserPorts = declaresBrowserCapability(options.manifest);

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  if (needsBrowserPorts) {
    for (const port of Object.values(BROWSER_PORTS)) {
      exposedPorts[`${port}/tcp`] = {};
      portBindings[`${port}/tcp`] = [{ HostPort: "" }]; // "" = let Docker assign a free host port
    }
  }

  const workingDir = options.workingDir ?? options.bindMount?.containerPath ?? "/app";

  const binds: string[] = [];
  if (options.bindMount) binds.push(`${options.bindMount.hostPath}:${options.bindMount.containerPath}`);
  if (options.installMarkerVolume) binds.push(`${options.installMarkerVolume}:${workingDir}/.berth`);

  const container = await docker.createContainer({
    name: options.name,
    Image: options.image,
    WorkingDir: workingDir,
    Env: Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`),
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
      // Every sandbox mounts the Phase 4 semantic filesystem at /context via
      // FUSE (see docker/entrypoint.sh), which needs the /dev/fuse device
      // node plus CAP_SYS_ADMIN to call mount(2) — unconditional, the same
      // way context-bus-daemon always starts, since /context isn't gated
      // behind any manifest capability the way browser:* ports are.
      Devices: [{ PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" }],
      CapAdd: ["SYS_ADMIN"],
    },
  });

  await container.start();

  let ports: RunningContainer["ports"] = {};
  if (needsBrowserPorts) {
    ports = await waitForPortMappings(container);
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
 * for an app that legitimately does have browser:* ports mapped.
 */
async function waitForPortMappings(
  container: Docker.Container,
  attempts = 20,
  delayMs = 100,
): Promise<RunningContainer["ports"]> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const inspect = await container.inspect();
    const mapped = inspect.NetworkSettings.Ports;
    const ports = {
      vnc: hostPort(mapped[`${BROWSER_PORTS.vnc}/tcp`]),
      novnc: hostPort(mapped[`${BROWSER_PORTS.novnc}/tcp`]),
      cdp: hostPort(mapped[`${BROWSER_PORTS.cdp}/tcp`]),
    };
    if (ports.vnc && ports.novnc && ports.cdp) return ports;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return {};
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
