import { readFile, writeFile, mkdir, unlink, readdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A record of one `berth os up <name>` instance — written by the CLI, read by
 * `Computer.connect()` (@berth/agents) so a separate process can reattach to
 * an already-running container instead of paying build+boot cost again. Lives
 * under `~/.berth/os/`, the same "small local record keyed by name" shape as
 * `~/.berth/fleets/<fleet>.json` (@berth/cli's fleet-state.ts) and
 * `~/.berth/snapshots/` — global rather than project-local because an agent
 * script connecting to a named OS may run from any directory, not just the
 * one `berth os up` was invoked from.
 */
export interface OsAppRecord {
  name: string;
  /** Absolute host path to the app's directory (must contain berth.yml). */
  appDir: string;
}

export interface OsStateFile {
  name: string;
  containerName: string;
  /** The image tag `berth os up` built — removed on `berth os down`, same cleanup `Computer.stop()` does for a booted (non-connected) Computer. */
  image: string;
  apps: OsAppRecord[];
  network?: string;
  startedAt: string;
  /**
   * Set only when started with `berth os up --http-rpc` — the host-reachable
   * URL and bearer token for @berth/sdk's HTTP RPC bridge (see
   * container.ts's `httpRpc` option), the one way a process with no Docker
   * API access (e.g. a Python client — see packages/agents-python's
   * `Computer.connect()`) can call this OS's exports. `app` names which
   * loaded app is actually bound to the bridge (BERTH_HTTP_RPC_APP) — only
   * that one app's exports are reachable this way; omitted for a single-app
   * OS, where there's no sibling to disambiguate.
   */
  httpRpc?: { url: string; token: string; app?: string };
}

const DEFAULT_OS_DIR = join(homedir(), ".berth", "os");

function stateFilePath(name: string, osDir: string): string {
  return join(osDir, `${name}.json`);
}

/** `osDir` defaults to ~/.berth/os — overridable so tests don't touch the real one. */
export async function readOsState(name: string, osDir = DEFAULT_OS_DIR): Promise<OsStateFile | undefined> {
  try {
    const raw = await readFile(stateFilePath(name, osDir), "utf-8");
    return JSON.parse(raw) as OsStateFile;
  } catch {
    return undefined;
  }
}

/**
 * 0600 in a 0700 directory, not the umask's default 0644 — `httpRpc.token` is
 * a bearer token that grants full RPC access to the named OS's exports
 * (REMEDIATION.md 5.5), and this file is the only place it is persisted.
 * `chmod` after `writeFile` rather than trusting the `mode` option, which is
 * masked by the umask on creation and ignored entirely for a file that
 * already exists — and this file already exists on every `berth os up` after
 * the first.
 */
export async function writeOsState(state: OsStateFile, osDir = DEFAULT_OS_DIR): Promise<void> {
  await mkdir(osDir, { recursive: true, mode: 0o700 });
  await chmod(osDir, 0o700);
  const path = stateFilePath(state.name, osDir);
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeOsState(name: string, osDir = DEFAULT_OS_DIR): Promise<void> {
  await unlink(stateFilePath(name, osDir)).catch(() => {});
}

/** Every name with a recorded state file — used by `berth os status` (no args) to list all instances. */
export async function listOsNames(osDir = DEFAULT_OS_DIR): Promise<string[]> {
  try {
    const files = await readdir(osDir);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
