import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the local-vm runtime keeps things, all under ~/.berth:
 *
 *   vm/kernel/sha256/<sha>/Image       the pinned kernel  } berth-vmm's own default
 *   vm/rootfs/rootfs-<sha>.erofs       the pinned rootfs  } artifacts layout
 *   vm/bin/berth-vmm                   berth-vmm, when `berth vm install --vmm` copied it
 *   vm/apps/<key>/<hash>/<app>/        bundled app shares (bundle.ts)
 *   vm/state/<app>.img                 per-app state disks (/workspace)
 *   run/vm/<name>/                     one running sandbox: sockets, pid, logs
 *
 * BERTH_HOME moves the lot (tests use it).
 */
export function berthHome(): string {
  return process.env.BERTH_HOME ?? join(homedir(), ".berth");
}

export function vmHome(): string {
  return join(berthHome(), "vm");
}

export function vmRunRoot(): string {
  return join(berthHome(), "run", "vm");
}

export function vmRunDir(name: string): string {
  return join(vmRunRoot(), name);
}

export function vmStateDisk(app: string): string {
  return join(vmHome(), "state", `${app}.img`);
}

export function vmAppsCache(): string {
  return join(vmHome(), "apps");
}

/** The sandbox name `berth dev --runtime vm` uses, and `berth mcp`/`berth rpc` look for. Same as the Docker path's container name. */
export function devSandboxName(app: string): string {
  return `berth-dev-${app}`;
}

/** sockaddr_un.sun_path on macOS is 104 bytes, NUL included (berth-vmm checks the same). */
export const MAX_SOCKET_PATH = 103;
