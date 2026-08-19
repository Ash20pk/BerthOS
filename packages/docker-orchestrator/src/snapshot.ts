import Docker from "dockerode";
import tarFs from "tar-fs";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, writeFile, readFile, readdir, chmod } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { BerthManifest } from "@berth/manifest-schema";
import { stripSecretEnv } from "./secrets.js";

const DEFAULT_SNAPSHOTS_DIR = join(homedir(), ".berth", "snapshots");

/**
 * BERTH_CONTEXT_DATA's default (see base.Dockerfile's ENV block) — the real
 * backing directory semantic-fs-daemon's FUSE mount at /context reads from
 * and writes its SQLite metadata index into. This is real Phase-4 state, not
 * a placeholder: it's what makes a restored snapshot's /context content and
 * tags survive, not just the app's own /workspace files.
 */
const DEFAULT_CONTEXT_DATA_PATH = "/var/berth/context-data";

/**
 * BERTH_CONTEXT_INDEX_DB's default (see base.Dockerfile's ENV block) — a
 * *sibling* path to BERTH_CONTEXT_DATA, not nested inside it, so capturing
 * BERTH_CONTEXT_DATA alone never actually includes semantic-fs's SQLite
 * index despite this module's original assumption that it would. Archived
 * separately below so a restored snapshot's semantic-fs index isn't left to
 * whatever container.commit()'s image layer happened to contain.
 */
const DEFAULT_CONTEXT_INDEX_DB_PATH = "/var/berth/context-index.db";

export interface SnapshotMetadata {
  id: string;
  appName: string;
  createdAt: string;
  imageTag: string;
  /** BERTH_CONTEXT_DATA at capture time — restoreSnapshot() needs this to know the archive's nested top-level directory name (Docker's getArchive wraps the requested path in its own basename). */
  contextDataPath: string;
  /** BERTH_CONTEXT_INDEX_DB at capture time — same reasoning as contextDataPath. */
  contextIndexDbPath: string;
  /**
   * Names of environment variables that were deliberately *not* captured into
   * env.json because their values are credentials (see secrets.ts's
   * `isSecretEnvName`). Recorded rather than dropped silently: a restore on
   * another machine has to be able to say which credentials it is missing,
   * and "the snapshot contains no secrets" is only a useful guarantee if the
   * thing it cost you is visible. Absent on snapshots taken before 5.5.
   */
  redactedEnvNames?: string[];
}

/**
 * Greppable JSON audit line on stderr — same convention as agent-init's and
 * mesh-daemon's own structured events (see docs/capability-tokens-
 * reference.md). Before this, a snapshot create/restore failure was only
 * ever visible as an uncaught exception with a stack trace; there was no
 * way to alert on "snapshot outcomes" as a class of event without parsing
 * one.
 */
function logSnapshotEvent(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

export interface CreateSnapshotOptions {
  /** The container to snapshot — must still be running (or at least not yet removed); commit()/getArchive() both need a live container reference. */
  container: Docker.Container;
  appName: string;
  manifest: BerthManifest;
  env?: Record<string, string>;
  contextDataPath?: string;
  contextIndexDbPath?: string;
  snapshotsDir?: string;
  docker?: Docker;
}

/**
 * Real, not simulated: `container.commit()` produces an actual new Docker
 * image layer (filesystem + installed packages), saved to disk as a real
 * image tarball (`docker save` equivalent) — not a script that re-runs
 * on_install. `container.getArchive()` on BERTH_CONTEXT_DATA captures
 * semantic-fs's real backing files, and a second `getArchive()` on
 * BERTH_CONTEXT_INDEX_DB captures its real SQLite metadata index — a
 * sibling path, not nested under BERTH_CONTEXT_DATA, so it needs its own
 * archive rather than riding along with the context-data one.
 *
 * Deliberately NOT captured (see docs/computer-snapshots-reference.md): any
 * context-bus daemon in-flight subscriber state (process memory, not disk;
 * apps re-subscribe via on_agent_ready on any boot, restored or not), and —
 * as of REMEDIATION.md 5.5, which is what made this paragraph true rather
 * than merely intended — every secret-named environment variable. env.json
 * used to be the whole container environment written at whatever mode the
 * umask gave it, including the RPC bearer token and any provider API key; it
 * is now the non-secret entries only, at 0600, with the withheld names listed
 * in metadata.redactedEnvNames so a restore can say what it is missing.
 * BERTH_TOKEN_SECRET used to be named here too; it no longer exists
 * (REMEDIATION.md 1.10 removed capability tokens).
 */
export async function createSnapshot(options: CreateSnapshotOptions): Promise<{ id: string; dir: string }> {
  const docker = options.docker ?? new Docker();
  const snapshotsDir = options.snapshotsDir ?? DEFAULT_SNAPSHOTS_DIR;
  const contextDataPath = options.contextDataPath ?? DEFAULT_CONTEXT_DATA_PATH;
  const contextIndexDbPath = options.contextIndexDbPath ?? DEFAULT_CONTEXT_INDEX_DB_PATH;

  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(snapshotsDir, options.appName, id);

  try {
    // 0700, not the umask's default 0755. A snapshot directory holds a
    // committed image layer of the app's whole filesystem plus its semantic-fs
    // context-data — conversation history, checkpoints, retrieved documents
    // (5.4 is still open, so all of it is plaintext). None of that is other
    // local users' business, whatever env.json does or doesn't contain.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);

    const imageTag = `berth-snapshot-${options.appName}:${id}`;
    await options.container.commit({ repo: `berth-snapshot-${options.appName}`, tag: id });

    const imageStream = await docker.getImage(imageTag).get();
    await pipeline(imageStream, createWriteStream(join(dir, "image.tar")));

    // image.tar (just written above) is the durable artifact — restoreSnapshot()
    // reloads from it independently via docker.loadImage() and never reuses
    // this committed image directly, so leaving it in the local daemon's
    // image store is a pure leak: every `berth snapshot create` would
    // otherwise grow `docker images` forever, invisible to and not reclaimed
    // by deleting ~/.berth/snapshots/. Best-effort — a cleanup failure (e.g.
    // still referenced by a running container) shouldn't fail an otherwise-
    // successful snapshot.
    await docker
      .getImage(imageTag)
      .remove()
      .catch((err: unknown) => {
        logSnapshotEvent("snapshot_image_cleanup_failed", { appName: options.appName, snapshotId: id, imageTag, error: String(err) });
      });

    const contextArchive = await options.container.getArchive({ path: contextDataPath });
    await pipeline(contextArchive, createWriteStream(join(dir, "context-data.tar")));

    const contextIndexDbArchive = await options.container.getArchive({ path: contextIndexDbPath });
    await pipeline(contextIndexDbArchive, createWriteStream(join(dir, "context-index-db.tar")));

    // The second half of 5.5, and the one that matters for a snapshot leaving
    // the machine that made it. `berth snapshot create` builds `env` by
    // reading the running container's `Config.Env` back out of `docker
    // inspect`, so container.ts's split already keeps credentials out of it —
    // this strips them again anyway, because `env` is a public option on this
    // function and a caller that assembles it by hand (or a container started
    // by something other than startContainer) would otherwise write API keys
    // into a file that gets copied to another machine. The names are kept so
    // a restore can say what it needs; the values are not.
    const { env: capturedEnv, strippedNames } = stripSecretEnv(options.env ?? {});
    const metadata: SnapshotMetadata = {
      id,
      appName: options.appName,
      createdAt: new Date().toISOString(),
      imageTag,
      contextDataPath,
      contextIndexDbPath,
      ...(strippedNames.length > 0 ? { redactedEnvNames: strippedNames } : {}),
    };
    await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
    await writeFile(join(dir, "manifest.json"), JSON.stringify(options.manifest, null, 2));
    await writeFile(join(dir, "env.json"), JSON.stringify(capturedEnv, null, 2), { mode: 0o600 });
    await chmod(join(dir, "env.json"), 0o600);

    if (strippedNames.length > 0) {
      logSnapshotEvent("snapshot_env_redacted", { appName: options.appName, snapshotId: id, redactedEnvNames: strippedNames });
    }

    logSnapshotEvent("snapshot_created", { appName: options.appName, snapshotId: id, imageTag });
    return { id, dir };
  } catch (err) {
    logSnapshotEvent("snapshot_create_failed", { appName: options.appName, snapshotId: id, error: String(err) });
    throw err;
  }
}

export interface RestoredSnapshot {
  metadata: SnapshotMetadata;
  manifest: BerthManifest;
  env: Record<string, string>;
  /** Host directory holding the extracted context-data archive, ready to bind-mount as StartContainerOptions.extraBinds. */
  contextDataHostDir: string;
  /** Host file holding the extracted semantic-fs SQLite index, ready to bind-mount as StartContainerOptions.extraBinds. */
  contextIndexDbHostFile: string;
  /**
   * Credentials the snapshot deliberately didn't carry (metadata's
   * `redactedEnvNames`), so the caller can tell the operator which ones the
   * restored sandbox will boot without. Empty for a snapshot that captured no
   * secret-named variables, and for one taken before 5.5.
   */
  redactedEnvNames: string[];
}

/**
 * Loads the snapshot's image back into the local Docker daemon and extracts
 * its context-data archive into a *fresh* host directory — deliberately not
 * `putArchive`'d into an already-running container, which would race
 * semantic-fs-daemon's own SQLite open at container boot (a real ordering
 * hazard, not a hypothetical one). The caller starts a new container with
 * this directory as an `extraBinds` entry targeting the same
 * BERTH_CONTEXT_DATA path the archive was captured from.
 *
 * Extraction happens into a directory unique to *this call*, not just to
 * `snapshotDir` — "fork and run in parallel" (two `restoreSnapshot()` calls
 * against the same snapshot ID, each starting its own container) is a
 * documented, supported workflow, and a fixed path derived only from
 * `snapshotDir` would give both forks the exact same host directory and
 * SQLite index file, opened by two independent, uncoordinated semantic-fs-
 * daemon instances — shared, racy state, not two isolated forks.
 */
export async function restoreSnapshot(snapshotDir: string, docker: Docker = new Docker()): Promise<RestoredSnapshot> {
  try {
    const metadata = JSON.parse(await readFile(join(snapshotDir, "metadata.json"), "utf-8")) as SnapshotMetadata;
    const manifest = JSON.parse(await readFile(join(snapshotDir, "manifest.json"), "utf-8")) as BerthManifest;
    const env = JSON.parse(await readFile(join(snapshotDir, "env.json"), "utf-8")) as Record<string, string>;

    const loadStream = await docker.loadImage(createReadStream(join(snapshotDir, "image.tar")));
    await new Promise<void>((resolve, reject) => {
      loadStream.on("data", () => {});
      loadStream.on("end", resolve);
      loadStream.on("error", reject);
    });

    const restoreId = randomUUID();

    const extractDir = join(snapshotDir, "restored", restoreId, "context-data");
    await mkdir(extractDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      createReadStream(join(snapshotDir, "context-data.tar"))
        .pipe(tarFs.extract(extractDir))
        .on("finish", resolve)
        .on("error", reject);
    });
    // Docker's getArchive() wraps the captured path in its own basename inside
    // the tar (e.g. capturing "/var/berth/context-data" produces a top-level
    // "context-data/" entry) — this is the directory an extraBinds entry
    // should actually target, not extractDir itself.
    const contextDataHostDir = join(extractDir, basename(metadata.contextDataPath));

    const extractIndexDbDir = join(snapshotDir, "restored", restoreId, "context-index-db");
    await mkdir(extractIndexDbDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      createReadStream(join(snapshotDir, "context-index-db.tar"))
        .pipe(tarFs.extract(extractIndexDbDir))
        .on("finish", resolve)
        .on("error", reject);
    });
    // Same basename-wrapping behavior as above, but for a single file rather
    // than a directory — this is the file an extraBinds entry should target.
    const contextIndexDbHostFile = join(extractIndexDbDir, basename(metadata.contextIndexDbPath));

    logSnapshotEvent("snapshot_restored", { appName: metadata.appName, snapshotId: metadata.id, imageTag: metadata.imageTag, restoreId });
    return { metadata, manifest, env, contextDataHostDir, contextIndexDbHostFile, redactedEnvNames: metadata.redactedEnvNames ?? [] };
  } catch (err) {
    logSnapshotEvent("snapshot_restore_failed", { snapshotDir, error: String(err) });
    throw err;
  }
}

export async function listSnapshots(appName: string, snapshotsDir: string = DEFAULT_SNAPSHOTS_DIR): Promise<SnapshotMetadata[]> {
  const appDir = join(snapshotsDir, appName);
  let entries: string[];
  try {
    entries = await readdir(appDir);
  } catch {
    return [];
  }

  const results: SnapshotMetadata[] = [];
  for (const entry of entries) {
    try {
      const metadata = JSON.parse(await readFile(join(appDir, entry, "metadata.json"), "utf-8")) as SnapshotMetadata;
      results.push(metadata);
    } catch {
      // not a valid snapshot dir (e.g. leftover restored-context-data from a sibling restore) — skip
    }
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function snapshotDirFor(appName: string, id: string, snapshotsDir: string = DEFAULT_SNAPSHOTS_DIR): string {
  return join(snapshotsDir, appName, id);
}
