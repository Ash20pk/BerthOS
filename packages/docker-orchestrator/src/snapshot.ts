import Docker from "dockerode";
import tarFs from "tar-fs";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { BerthManifest } from "@berth/manifest-schema";

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
 * Deliberately NOT captured (see docs/computer-snapshots-reference.md):
 * BERTH_TOKEN_SECRET (regenerated fresh per boot by design — capturing it
 * would be a real security regression, not a missing feature), and any
 * context-bus daemon in-flight subscriber state (process memory, not disk;
 * apps re-subscribe via on_agent_ready on any boot, restored or not).
 */
export async function createSnapshot(options: CreateSnapshotOptions): Promise<{ id: string; dir: string }> {
  const docker = options.docker ?? new Docker();
  const snapshotsDir = options.snapshotsDir ?? DEFAULT_SNAPSHOTS_DIR;
  const contextDataPath = options.contextDataPath ?? DEFAULT_CONTEXT_DATA_PATH;
  const contextIndexDbPath = options.contextIndexDbPath ?? DEFAULT_CONTEXT_INDEX_DB_PATH;

  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(snapshotsDir, options.appName, id);
  await mkdir(dir, { recursive: true });

  const imageTag = `berth-snapshot-${options.appName}:${id}`;
  await options.container.commit({ repo: `berth-snapshot-${options.appName}`, tag: id });

  const imageStream = await docker.getImage(imageTag).get();
  await pipeline(imageStream, createWriteStream(join(dir, "image.tar")));

  const contextArchive = await options.container.getArchive({ path: contextDataPath });
  await pipeline(contextArchive, createWriteStream(join(dir, "context-data.tar")));

  const contextIndexDbArchive = await options.container.getArchive({ path: contextIndexDbPath });
  await pipeline(contextIndexDbArchive, createWriteStream(join(dir, "context-index-db.tar")));

  const metadata: SnapshotMetadata = {
    id,
    appName: options.appName,
    createdAt: new Date().toISOString(),
    imageTag,
    contextDataPath,
    contextIndexDbPath,
  };
  await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
  await writeFile(join(dir, "manifest.json"), JSON.stringify(options.manifest, null, 2));
  await writeFile(join(dir, "env.json"), JSON.stringify(options.env ?? {}, null, 2));

  return { id, dir };
}

export interface RestoredSnapshot {
  metadata: SnapshotMetadata;
  manifest: BerthManifest;
  env: Record<string, string>;
  /** Host directory holding the extracted context-data archive, ready to bind-mount as StartContainerOptions.extraBinds. */
  contextDataHostDir: string;
  /** Host file holding the extracted semantic-fs SQLite index, ready to bind-mount as StartContainerOptions.extraBinds. */
  contextIndexDbHostFile: string;
}

/**
 * Loads the snapshot's image back into the local Docker daemon and extracts
 * its context-data archive into a *fresh* host directory — deliberately not
 * `putArchive`'d into an already-running container, which would race
 * semantic-fs-daemon's own SQLite open at container boot (a real ordering
 * hazard, not a hypothetical one). The caller starts a new container with
 * this directory as an `extraBinds` entry targeting the same
 * BERTH_CONTEXT_DATA path the archive was captured from.
 */
export async function restoreSnapshot(snapshotDir: string, docker: Docker = new Docker()): Promise<RestoredSnapshot> {
  const metadata = JSON.parse(await readFile(join(snapshotDir, "metadata.json"), "utf-8")) as SnapshotMetadata;
  const manifest = JSON.parse(await readFile(join(snapshotDir, "manifest.json"), "utf-8")) as BerthManifest;
  const env = JSON.parse(await readFile(join(snapshotDir, "env.json"), "utf-8")) as Record<string, string>;

  const loadStream = await docker.loadImage(createReadStream(join(snapshotDir, "image.tar")));
  await new Promise<void>((resolve, reject) => {
    loadStream.on("data", () => {});
    loadStream.on("end", resolve);
    loadStream.on("error", reject);
  });

  const extractDir = join(snapshotDir, "restored-context-data");
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

  const extractIndexDbDir = join(snapshotDir, "restored-context-index-db");
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

  return { metadata, manifest, env, contextDataHostDir, contextIndexDbHostFile };
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
