import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type Docker from "dockerode";
import {
  BUILD_CACHE_LABEL,
  buildCacheRef,
  buildImage,
  makeDeployReproducible,
  retainLatestBuild,
  stageProductionSource,
  withLockfileRestored,
} from "./image.js";

// A tree shaped like `pnpm deploy --legacy` output, with each thing that made
// two builds of the same app differ, or dangle inside the image.
function deployedTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-deploy-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".pnpm", "dep@1", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "tool"), `#!/bin/sh\nexport NODE_PATH="${dir}/node_modules/.pnpm/node_modules"\nexec node "$basedir/../dep/cli.js"\n`);
  writeFileSync(join(dir, "node_modules", ".modules.yaml"), `prunedAt: ${new Date().toISOString()}\nvirtualStoreDir: ${dir}/node_modules/.pnpm\n`);
  symlinkSync("../../../../../Users/someone/checkout/apps/notes", join(dir, "node_modules", "escaping"));
  symlinkSync(".pnpm/dep@1/node_modules/dep", join(dir, "node_modules", "dep"));
  return dir;
}

test("the deploy path in .bin shims becomes the app's path in the image", async () => {
  const dir = deployedTree();
  try {
    await makeDeployReproducible(dir, "/app/apps/notes");
    const shim = readFileSync(join(dir, "node_modules", ".bin", "tool"), "utf-8");
    assert.ok(!shim.includes(dir), shim);
    assert.match(shim, /NODE_PATH="\/app\/apps\/notes\/node_modules\/\.pnpm\/node_modules"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pnpm's bookkeeping and links out of the tree are removed; links inside stay", async () => {
  const dir = deployedTree();
  try {
    await makeDeployReproducible(dir, "/app");
    assert.equal(existsSync(join(dir, "node_modules", ".modules.yaml")), false);
    assert.throws(() => lstatSync(join(dir, "node_modules", "escaping")), /ENOENT/);
    assert.ok(lstatSync(join(dir, "node_modules", "dep")).isSymbolicLink());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two deploys of the same app end up byte-identical", async () => {
  const a = deployedTree();
  const b = deployedTree();
  try {
    await makeDeployReproducible(a, "/app");
    await makeDeployReproducible(b, "/app");
    const shim = (d: string) => readFileSync(join(d, "node_modules", ".bin", "tool"), "utf-8");
    assert.equal(shim(a), shim(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a link that escapes through another link inside the tree is removed too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-deploy-"));
  const outside = mkdtempSync(join(tmpdir(), "berth-outside-"));
  try {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    // `hop` is inside the tree and points out of it; `via-hop` only looks
    // like it stays inside until `hop` is resolved.
    symlinkSync(outside, join(dir, "node_modules", "hop"));
    symlinkSync("hop", join(dir, "node_modules", "via-hop"));
    await makeDeployReproducible(dir, "/app");
    assert.throws(() => lstatSync(join(dir, "node_modules", "hop")), /ENOENT/);
    assert.throws(() => lstatSync(join(dir, "node_modules", "via-hop")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

/** Every path in a tree, with its content hash or link target — what a `COPY` layer's cache key is made of. */
function treeDigest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(path)}`);
      else if (entry.isDirectory()) walk(path);
      else out.push(`${rel} ${lstatSync(path).mode.toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root);
  return out.sort();
}

function hasPnpm(): boolean {
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A `berth init`-shaped project: not a workspace member, so staging takes the
// plain `pnpm install --prod` branch. The dependency is local (and has a bin,
// so there are shims to get wrong) so the test needs no registry.
function standaloneApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-standalone-"));
  mkdirSync(join(dir, "vendor", "probe-tool"), { recursive: true });
  writeFileSync(
    join(dir, "vendor", "probe-tool", "package.json"),
    JSON.stringify({ name: "probe-tool", version: "1.0.0", bin: { "probe-tool": "cli.js" } }),
  );
  writeFileSync(join(dir, "vendor", "probe-tool", "cli.js"), "#!/usr/bin/env node\nconsole.log('probe');\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "standalone-probe", version: "0.1.0", type: "module", dependencies: { "probe-tool": "file:./vendor/probe-tool" } }),
  );
  writeFileSync(join(dir, "index.js"), "export {};\n");
  // Every app has one, and staging reads it (e.g. for the app's runtime).
  writeFileSync(join(dir, "berth.yml"), "name: standalone-probe\nversion: 0.1.0\n");
  return dir;
}

test("two stagings of the same standalone app are identical", { skip: !hasPnpm() && "pnpm is not installed" }, async () => {
  const app = standaloneApp();
  const a = mkdtempSync(join(tmpdir(), "berth-build-"));
  const b = mkdtempSync(join(tmpdir(), "berth-build-"));
  try {
    await stageProductionSource(app, join(a, "app"), "/app");
    await stageProductionSource(app, join(b, "app"), "/app");
    // The install actually happened, with a shim, so the comparison below
    // is between two real installs rather than two empty trees.
    assert.ok(existsSync(join(a, "app", "node_modules", ".bin", "probe-tool")));
    assert.deepEqual(treeDigest(join(a, "app")), treeDigest(join(b, "app")));
    for (const line of treeDigest(join(a, "app"))) assert.ok(!line.includes(a), line);
  } finally {
    for (const dir of [app, a, b]) rmSync(dir, { recursive: true, force: true });
  }
});

function workspaceWithLockfile(): { root: string; lockfile: string } {
  const root = mkdtempSync(join(tmpdir(), "berth-ws-"));
  const lockfile = join(root, "pnpm-lock.yaml");
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n# original\n");
  return { root, lockfile };
}

test("a deploy's lockfile rewrite is put back", async () => {
  const { root, lockfile } = workspaceWithLockfile();
  try {
    await withLockfileRestored(root, async () => writeFileSync(lockfile, "rewritten by deploy\n"));
    assert.equal(readFileSync(lockfile, "utf-8"), "lockfileVersion: '9.0'\n# original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lockfile the deploy didn't change isn't written at all", async () => {
  const { root, lockfile } = workspaceWithLockfile();
  try {
    const inode = lstatSync(lockfile).ino;
    await withLockfileRestored(root, async () => {});
    assert.equal(lstatSync(lockfile).ino, inode);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping deploys don't take each other's rewrite for the original", async () => {
  const { root, lockfile } = workspaceWithLockfile();
  try {
    // Unserialized, the second snapshot is the first deploy's rewrite, and
    // the second restore puts *that* back last.
    const first = withLockfileRestored(root, async () => {
      writeFileSync(lockfile, "first deploy\n");
      await new Promise((r) => setTimeout(r, 20));
    });
    const second = withLockfileRestored(root, async () => {
      writeFileSync(lockfile, "second deploy\n");
      await new Promise((r) => setTimeout(r, 60));
    });
    await Promise.all([first, second]);
    assert.equal(readFileSync(lockfile, "utf-8"), "lockfileVersion: '9.0'\n# original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ctrl-C in the middle of a deploy still puts the lockfile back", async () => {
  const { root, lockfile } = workspaceWithLockfile();
  try {
    const imageModule = pathToFileURL(join(import.meta.dirname, "image.js")).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { withLockfileRestored } = await import(${JSON.stringify(imageModule)});
         const { writeFileSync } = await import("node:fs");
         await withLockfileRestored(${JSON.stringify(root)}, async () => {
           writeFileSync(${JSON.stringify(lockfile)}, "half-way through a deploy\\n");
           console.log("deploying");
           await new Promise(() => setInterval(() => {}, 1000));
         });`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    child.kill("SIGINT");
    // Still dies of the signal, as it would have without the handler.
    assert.equal(await exited, "SIGINT");
    assert.equal(readFileSync(lockfile, "utf-8"), "lockfileVersion: '9.0'\n# original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the build-cache reference is per repository and target, not per tag", () => {
  assert.equal(buildCacheRef("berth-agent/notes:1790000000000", "production"), "berth-build-cache:production-berth-agent_notes");
  assert.equal(buildCacheRef("berth-agent/notes:1790000000001", "production"), buildCacheRef("berth-agent/notes:1", "production"));
  assert.equal(buildCacheRef("berth/notes:dev", "dev"), "berth-build-cache:dev-berth_notes");
  assert.equal(buildCacheRef("localhost:5000/berth/notes", "production"), "berth-build-cache:production-localhost_5000_berth_notes");
});

interface FakeImage {
  Id: string;
  ParentId?: string;
  RepoTags: string[];
  Labels?: Record<string, string>;
  /** Unix seconds, as the daemon reports it; an hour ago unless a test says otherwise. */
  Created?: number;
}

/**
 * Just enough of dockerode's image API for retainLatestBuild(), with the
 * removals it made. buildImage() gets a daemon whose build stream never
 * ends on its own, like a first build still compiling; `builds` records the
 * options each build request carried.
 */
function fakeDocker(images: FakeImage[], inUse: string[] = [], { tagFails = false } = {}) {
  const removed: string[] = [];
  const builds: { abortSignal?: AbortSignal; labels?: Record<string, string> }[] = [];
  let stream: PassThrough | undefined;
  const find = (ref: string) => images.find((i) => i.Id === ref || i.RepoTags.includes(ref));
  const docker = {
    buildImage: async (_context: unknown, options: { abortSignal?: AbortSignal; labels?: Record<string, string> }) => {
      builds.push(options);
      stream = new PassThrough();
      return stream;
    },
    modem: {
      followProgress: (s: PassThrough, onFinished: (err: Error | null) => void) => {
        s.on("error", (err) => onFinished(err));
        s.on("end", () => onFinished(null));
        s.resume();
      },
    },
    getImage: (ref: string) => ({
      inspect: async () => {
        const image = find(ref);
        if (!image) throw new Error(`no such image: ${ref}`);
        return { Id: image.Id, RepoTags: [...image.RepoTags], Config: { Labels: image.Labels ?? null } };
      },
      tag: async ({ repo, tag }: { repo: string; tag: string }) => {
        if (tagFails) throw new Error("(HTTP code 500) server error - tag refused");
        const name = `${repo}:${tag}`;
        for (const image of images) image.RepoTags = image.RepoTags.filter((t) => t !== name);
        find(ref)!.RepoTags.push(name);
      },
      remove: async (options: { noprune?: boolean }) => {
        assert.equal(options?.noprune, true, "every removal is noprune: the walk is done by hand");
        const image = find(ref)!;
        if (image.RepoTags.length > 0 || inUse.includes(image.Id)) throw new Error("conflict");
        if (images.some((i) => i.ParentId === image.Id)) throw new Error("conflict: image has dependent child images");
        images.splice(images.indexOf(image), 1);
        removed.push(image.Id);
      },
    }),
    listImages: async (options?: { all?: boolean; filters?: { dangling?: string[]; label?: string[] } }) =>
      images
        .filter((i) => options?.all || !images.some((c) => c.ParentId === i.Id))
        .filter((i) => !options?.filters?.dangling || i.RepoTags.length === 0)
        // Docker's own label filter: `key` for presence, `key=value` for an exact value.
        .filter(
          (i) =>
            !options?.filters?.label ||
            options.filters.label.every((l) => {
              const [key, ...value] = l.split("=");
              return value.length === 0 ? i.Labels?.[key!] !== undefined : i.Labels?.[key!] === value.join("=");
            }),
        )
        .map((i) => ({
          Id: i.Id,
          ParentId: i.ParentId ?? "",
          RepoTags: i.RepoTags.length ? [...i.RepoTags] : ["<none>:<none>"],
          Labels: i.Labels ?? {},
          Created: i.Created ?? Math.floor(Date.now() / 1000) - 3600,
        })),
  };
  return { docker: docker as unknown as Docker, removed, images, builds, stream: () => stream };
}

const labelled = (ref: string) => ({ [BUILD_CACHE_LABEL]: ref });

/** base -> shared -> {old copy -> old final, new copy -> new final}: the shape a source change leaves. */
function twoBuilds(ref: string, newTag: string, oldTags: string[]): FakeImage[] {
  return [
    { Id: "sha256:base", RepoTags: [] },
    { Id: "sha256:shared", ParentId: "sha256:base", RepoTags: [] },
    { Id: "sha256:old-copy", ParentId: "sha256:shared", RepoTags: [] },
    { Id: "sha256:old", ParentId: "sha256:old-copy", RepoTags: oldTags, Labels: labelled(ref) },
    { Id: "sha256:new-copy", ParentId: "sha256:shared", RepoTags: [] },
    { Id: "sha256:new", ParentId: "sha256:new-copy", RepoTags: [newTag], Labels: labelled(ref) },
  ];
}

test("a rebuilt app's previous image and its own layers go; the shared cache stays", async () => {
  const ref = buildCacheRef("berth-agent/notes:2", "production");
  // The previous boot's build: its own tag already removed by stop(), so
  // only the cache reference holds it.
  const fake = fakeDocker(twoBuilds(ref, "berth-agent/notes:2", [ref]));
  await retainLatestBuild(fake.docker, "berth-agent/notes:2", ref, [undefined, "sha256:old"]);
  assert.deepEqual(fake.removed, ["sha256:old", "sha256:old-copy"]);
  assert.deepEqual(fake.images.map((i) => i.Id), ["sha256:base", "sha256:shared", "sha256:new-copy", "sha256:new"]);
  assert.deepEqual(fake.images.find((i) => i.Id === "sha256:new")!.RepoTags.sort(), ["berth-agent/notes:2", ref].sort());
});

test("an unchanged rebuild removes nothing", async () => {
  const ref = buildCacheRef("berth/notes:dev", "dev");
  const fake = fakeDocker([
    { Id: "sha256:base", RepoTags: [] },
    { Id: "sha256:same", ParentId: "sha256:base", RepoTags: ["berth/notes:dev", ref], Labels: labelled(ref) },
  ]);
  await retainLatestBuild(fake.docker, "berth/notes:dev", ref, ["sha256:same", "sha256:same"]);
  assert.deepEqual(fake.removed, []);
});

test("a previous image someone else still tags, or a container still uses, is left alone", async () => {
  const ref = buildCacheRef("berth/notes:1.0.1", "production");
  const tagged = fakeDocker(twoBuilds(ref, "berth/notes:1.0.1", ["berth/notes:1.0.0", ref]));
  await retainLatestBuild(tagged.docker, "berth/notes:1.0.1", ref, [undefined, "sha256:old"]);
  assert.deepEqual(tagged.removed, []);
  assert.deepEqual(tagged.images.find((i) => i.Id === "sha256:old")!.RepoTags, ["berth/notes:1.0.0"]);

  const running = fakeDocker(twoBuilds(ref, "berth/notes:1.0.1", [ref]), ["sha256:old"]);
  await retainLatestBuild(running.docker, "berth/notes:1.0.1", ref, [undefined, "sha256:old"]);
  assert.deepEqual(running.removed, []);
});

test("only berth-labelled dangling images are cleaned up", async () => {
  const ref = buildCacheRef("berth/notes:dev", "dev");
  const fake = fakeDocker([
    { Id: "sha256:base", RepoTags: [] },
    { Id: "sha256:orphan", ParentId: "sha256:base", RepoTags: [], Labels: labelled(ref) },
    { Id: "sha256:someone-elses", ParentId: "sha256:base", RepoTags: [] },
    { Id: "sha256:new", ParentId: "sha256:base", RepoTags: ["berth/notes:dev"], Labels: labelled(ref) },
  ]);
  await retainLatestBuild(fake.docker, "berth/notes:dev", ref, [undefined, undefined]);
  assert.deepEqual(fake.removed, ["sha256:orphan"]);
});

test("the sweep leaves other apps' images and images built FROM a berth image alone", async () => {
  const ref = buildCacheRef("berth/notes:dev", "dev");
  const other = buildCacheRef("berth/filesystem:dev", "dev");
  const fake = fakeDocker([
    { Id: "sha256:base", RepoTags: [] },
    { Id: "sha256:orphan", ParentId: "sha256:base", RepoTags: [], Labels: labelled(ref) },
    // Another app's dangling build: that app's own next build reclaims it.
    { Id: "sha256:other-orphan", ParentId: "sha256:base", RepoTags: [], Labels: labelled(other) },
    // `FROM berth/notes:dev` in someone's own Dockerfile, since re-tagged:
    // dangling, and carrying the inherited label with this very value.
    { Id: "sha256:berth-parent", ParentId: "sha256:base", RepoTags: ["berth/notes:0.9.0"], Labels: labelled(ref) },
    { Id: "sha256:users-layer", ParentId: "sha256:berth-parent", RepoTags: [] },
    { Id: "sha256:users-image", ParentId: "sha256:users-layer", RepoTags: [], Labels: labelled(ref) },
    { Id: "sha256:new", ParentId: "sha256:base", RepoTags: ["berth/notes:dev"], Labels: labelled(ref) },
  ]);
  await retainLatestBuild(fake.docker, "berth/notes:dev", ref, [undefined, undefined]);
  assert.deepEqual(fake.removed, ["sha256:orphan"]);
});

test("the sweep skips a dangling image too new to be an orphan", async () => {
  // A concurrent build of the same app, its final image not tagged yet.
  const ref = buildCacheRef("berth/notes:dev", "dev");
  const fake = fakeDocker([
    { Id: "sha256:base", RepoTags: [] },
    { Id: "sha256:in-flight", ParentId: "sha256:base", RepoTags: [], Labels: labelled(ref), Created: Math.floor(Date.now() / 1000) - 5 },
    { Id: "sha256:new", ParentId: "sha256:base", RepoTags: ["berth/notes:dev"], Labels: labelled(ref) },
  ]);
  await retainLatestBuild(fake.docker, "berth/notes:dev", ref, [undefined, undefined]);
  assert.deepEqual(fake.removed, []);
});

test("a failing docker tag is a warning, not a failed build, and retires nothing", async () => {
  const ref = buildCacheRef("berth-agent/notes:2", "production");
  const fake = fakeDocker(twoBuilds(ref, "berth-agent/notes:2", [ref]), [], { tagFails: true });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    await retainLatestBuild(fake.docker, "berth-agent/notes:2", ref, [undefined, "sha256:old"]);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /berth-agent\/notes:2.*tag refused/);
  // The cache reference didn't move, so the build it points at stays.
  assert.deepEqual(fake.removed, []);
});

function probeAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-image-"));
  writeFileSync(join(dir, "berth.yml"), "name: probe\nversion: 0.0.1\n");
  return dir;
}

test("a build is cancelled when its signal aborts, including the request to the daemon", async () => {
  const fake = fakeDocker([]);
  const controller = new AbortController();
  const building = buildImage({ appDir: probeAppDir(), appName: "probe", tag: "berth/probe:dev", target: "dev", docker: fake.docker, signal: controller.signal });
  for (let i = 0; i < 200 && !fake.stream(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fake.stream(), "the build reached the daemon");
  assert.equal(fake.builds[0]!.abortSignal, controller.signal, "the daemon request carries the signal");
  assert.deepEqual(fake.builds[0]!.labels, labelled(buildCacheRef("berth/probe:dev", "dev")), "and still the build-cache label");

  controller.abort();
  await assert.rejects(building, /build of berth\/probe:dev was cancelled/);
  assert.equal(fake.stream()!.destroyed, true);
});

test("a build whose signal has already aborted doesn't start", async () => {
  const fake = fakeDocker([]);
  await assert.rejects(
    buildImage({ appDir: probeAppDir(), appName: "probe", tag: "berth/probe:dev", target: "dev", docker: fake.docker, signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
  assert.equal(fake.builds.length, 0);
});
