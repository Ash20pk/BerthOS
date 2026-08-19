import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import tarFs from "tar-fs";
import type Docker from "dockerode";
import type { BerthManifest } from "@berth/manifest-schema";
import { restoreSnapshot, createSnapshot, type SnapshotMetadata } from "./snapshot.js";

/**
 * Builds a snapshot directory on disk with the same shape createSnapshot()
 * produces, without touching Docker at all — restoreSnapshot()'s only real
 * Docker dependency is loadImage() (mocked below); the context-data/
 * context-index-db tar handling is pure filesystem work, so it's testable
 * directly.
 */
async function buildFixtureSnapshotDir(): Promise<string> {
  const snapshotDir = await mkdtemp(join(tmpdir(), "berth-snapshot-test-"));

  // Docker's getArchive() wraps the captured path in its own basename inside
  // the tar (e.g. capturing "/var/berth/context-data" produces a top-level
  // "context-data/" entry) — reproduced by hand here so this fixture matches
  // what a real captured archive looks like.
  const contextDataSrc = join(snapshotDir, "_fixture-context-data");
  await mkdir(join(contextDataSrc, "context-data"), { recursive: true });
  await writeFile(join(contextDataSrc, "context-data", "marker.txt"), "context-data-content");
  await pipeline(tarFs.pack(contextDataSrc), createWriteStream(join(snapshotDir, "context-data.tar")));

  const indexDbSrc = join(snapshotDir, "_fixture-index-db");
  await mkdir(indexDbSrc, { recursive: true });
  await writeFile(join(indexDbSrc, "context-index.db"), "sqlite-content");
  await pipeline(tarFs.pack(indexDbSrc), createWriteStream(join(snapshotDir, "context-index-db.tar")));

  await writeFile(join(snapshotDir, "image.tar"), "");
  await writeFile(
    join(snapshotDir, "metadata.json"),
    JSON.stringify({
      id: "fixture-id",
      appName: "fixture-app",
      createdAt: new Date().toISOString(),
      imageTag: "berth-snapshot-fixture-app:fixture-id",
      contextDataPath: "/var/berth/context-data",
      contextIndexDbPath: "/var/berth/context-index.db",
    }),
  );
  await writeFile(join(snapshotDir, "manifest.json"), JSON.stringify({ name: "fixture-app" }));
  await writeFile(join(snapshotDir, "env.json"), JSON.stringify({}));

  return snapshotDir;
}

function fakeDocker(): Docker {
  return {
    loadImage: async () => {
      const stream = new Readable();
      stream.push(null);
      return stream;
    },
  } as unknown as Docker;
}

/**
 * Regression test for the bug: restoreSnapshot() used to extract into a
 * fixed path derived only from `snapshotDir` (e.g.
 * "<snapshotDir>/restored-context-data"), so two `restoreSnapshot()` calls
 * against the *same* snapshot ID — the documented "fork and run in
 * parallel" workflow — gave both forks the exact same host directory and
 * SQLite index file. Two containers bind-mounting the same mutable path is
 * shared, racy state, not two independent forks.
 */
test("restoreSnapshot() gives each call its own extraction directory, not a shared one derived from snapshotDir", async () => {
  const snapshotDir = await buildFixtureSnapshotDir();
  const docker = fakeDocker();

  const forkA = await restoreSnapshot(snapshotDir, docker);
  const forkB = await restoreSnapshot(snapshotDir, docker);

  assert.notEqual(forkA.contextDataHostDir, forkB.contextDataHostDir, "two restores of the same snapshot must not share a context-data directory");
  assert.notEqual(
    forkA.contextIndexDbHostFile,
    forkB.contextIndexDbHostFile,
    "two restores of the same snapshot must not share an index-db file",
  );

  // Both forks still extracted their own, independently-usable copy.
  assert.equal(await readFile(join(forkA.contextDataHostDir, "marker.txt"), "utf-8"), "context-data-content");
  assert.equal(await readFile(join(forkB.contextDataHostDir, "marker.txt"), "utf-8"), "context-data-content");
});

test("restoreSnapshot() returns the metadata/manifest/env captured at snapshot time", async () => {
  const snapshotDir = await buildFixtureSnapshotDir();
  const docker = fakeDocker();

  const restored = await restoreSnapshot(snapshotDir, docker);

  assert.equal(restored.metadata.appName, "fixture-app");
  assert.equal(restored.metadata.imageTag, "berth-snapshot-fixture-app:fixture-id");
  assert.deepEqual(restored.manifest, { name: "fixture-app" });
  assert.deepEqual(restored.env, {});
});

function emptyReadable(): Readable {
  const stream = new Readable();
  stream.push(null);
  return stream;
}

function fakeContainer(): Docker.Container {
  return {
    commit: async () => {},
    getArchive: async () => emptyReadable(),
  } as unknown as Docker.Container;
}

/**
 * Regression test for the bug: createSnapshot() committed a real Docker
 * image (container.commit()) and streamed it out to image.tar, but never
 * removed the committed image from the local daemon's image store —
 * restoreSnapshot() reloads from image.tar independently and never reuses
 * it, so every `berth snapshot create` left a permanent, ever-growing image
 * behind in `docker images`.
 */
test("createSnapshot() removes the committed image from the local Docker daemon after exporting it", async () => {
  const snapshotsDir = await mkdtemp(join(tmpdir(), "berth-snapshot-create-test-"));
  const removedImageTags: string[] = [];
  const docker = {
    getImage: (imageTag: string) => ({
      get: async () => emptyReadable(),
      remove: async () => {
        removedImageTags.push(imageTag);
      },
    }),
  } as unknown as Docker;

  const { id, dir } = await createSnapshot({
    container: fakeContainer(),
    appName: "fixture-app",
    manifest: { name: "fixture-app" } as unknown as BerthManifest,
    snapshotsDir,
    docker,
  });

  assert.deepEqual(removedImageTags, [`berth-snapshot-fixture-app:${id}`]);
  // image.tar (the durable artifact) still exists even though the live image was cleaned up.
  await assert.doesNotReject(readFile(join(dir, "image.tar")));
});

test("createSnapshot() still succeeds even if removing the committed image fails", async () => {
  const snapshotsDir = await mkdtemp(join(tmpdir(), "berth-snapshot-create-test-"));
  const docker = {
    getImage: () => ({
      get: async () => emptyReadable(),
      remove: async () => {
        throw new Error("image is in use by a running container");
      },
    }),
  } as unknown as Docker;

  const result = await createSnapshot({
    container: fakeContainer(),
    appName: "fixture-app",
    manifest: { name: "fixture-app" } as unknown as BerthManifest,
    snapshotsDir,
    docker,
  });

  assert.ok(result.id);
});

/**
 * REMEDIATION.md 5.5's snapshot half. env.json used to be the running
 * container's entire environment, written at whatever mode the umask gave it —
 * so a snapshot directory copied to another machine (which is the whole point
 * of a snapshot) carried the RPC bearer token and every provider API key with
 * it, while this module's own doc comment claimed secrets weren't captured.
 */
test("createSnapshot() writes no credential values into env.json, and records which names it withheld", async () => {
  const snapshotsDir = await mkdtemp(join(tmpdir(), "berth-snapshot-secrets-test-"));
  const docker = {
    getImage: () => ({ get: async () => emptyReadable(), remove: async () => {} }),
  } as unknown as Docker;

  const { dir } = await createSnapshot({
    container: fakeContainer(),
    appName: "fixture-app",
    manifest: { name: "fixture-app" } as unknown as BerthManifest,
    env: {
      BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace",
      ANTHROPIC_API_KEY: "sk-ant-must-not-be-in-a-snapshot",
      BERTH_HTTP_RPC_TOKEN: "rpc-token-must-not-be-in-a-snapshot",
    },
    snapshotsDir,
    docker,
  });

  const envJson = await readFile(join(dir, "env.json"), "utf-8");
  assert.ok(!envJson.includes("sk-ant-must-not-be-in-a-snapshot"), `env.json carried a provider key: ${envJson}`);
  assert.ok(!envJson.includes("rpc-token-must-not-be-in-a-snapshot"), `env.json carried the RPC token: ${envJson}`);
  assert.deepEqual(JSON.parse(envJson), { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" });

  const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf-8")) as SnapshotMetadata;
  assert.deepEqual(metadata.redactedEnvNames, ["ANTHROPIC_API_KEY", "BERTH_HTTP_RPC_TOKEN"]);

  assert.equal((await stat(join(dir, "env.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("createSnapshot() records no redactedEnvNames when the captured environment holds no credentials", async () => {
  const snapshotsDir = await mkdtemp(join(tmpdir(), "berth-snapshot-secrets-test-"));
  const docker = {
    getImage: () => ({ get: async () => emptyReadable(), remove: async () => {} }),
  } as unknown as Docker;

  const { dir } = await createSnapshot({
    container: fakeContainer(),
    appName: "fixture-app",
    manifest: { name: "fixture-app" } as unknown as BerthManifest,
    env: { BERTH_WORKSPACE_ROOT: "/workspace" },
    snapshotsDir,
    docker,
  });

  const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf-8")) as SnapshotMetadata;
  assert.equal(metadata.redactedEnvNames, undefined);
});

/** restoreSnapshot() has to hand the withheld names to its caller, or `berth snapshot restore` can't tell an operator why the restored agent has no model access. */
test("restoreSnapshot() surfaces the names the snapshot deliberately didn't capture", async () => {
  const snapshotsDir = await mkdtemp(join(tmpdir(), "berth-snapshot-secrets-test-"));
  const docker = {
    getImage: () => ({ get: async () => emptyReadable(), remove: async () => {} }),
    loadImage: async () => emptyReadable(),
  } as unknown as Docker;

  const { dir } = await createSnapshot({
    container: fakeContainer(),
    appName: "fixture-app",
    manifest: { name: "fixture-app" } as unknown as BerthManifest,
    env: { OPENAI_API_KEY: "sk-openai-test" },
    snapshotsDir,
    docker,
  });

  const restored = await restoreSnapshot(dir, docker);
  assert.deepEqual(restored.redactedEnvNames, ["OPENAI_API_KEY"]);
  assert.deepEqual(restored.env, {});
});
