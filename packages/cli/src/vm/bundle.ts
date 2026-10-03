import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vmAppsCache } from "./paths.js";

/**
 * Turns an app directory into what the VM's read-only app share needs
 * (packages/vmm/scripts/build-apps.sh makes the same layout for the e2e):
 *
 *   berth.yml                 copied
 *   dist/index.mjs            the app, with @berthos/sdk, zod and its other dependencies inlined
 *   runtime.mjs               @berthos/sdk's resident-app runtime, bundled
 *   proto/context_bus.proto   what the runtime's context-bus client loads
 *
 * The guest has node but no node_modules, so everything is bundled with
 * esbuild. esbuild and the SDK are resolved from the project first (a `berth
 * init` project has its own node_modules) and from the CLI's own
 * dependencies otherwise, so a project that has never run `npm install` still
 * bundles against the SDK the CLI ships with.
 *
 * A `runtime: python` app is not bundled (bundlePythonApp): its own files
 * are copied into the share as they are, with `.berth-runtime` saying
 * "python", and the image supplies python3, berth_sdk and its dependencies.
 *
 * Bundles are cached by content: the files esbuild actually read, berth.yml,
 * and the list of the app's own source files (so a new file that changes how
 * an import resolves is noticed). An unchanged app doesn't rebundle, which is
 * what makes the hot-reload check cheap.
 */

/** Bumped when the bundle's layout or options change, so old cache entries are not reused. */
export const BUNDLE_FORMAT = 1;

export interface BundledApp {
  name: string;
  /** The share directory to pass to `berth-vmm run --app`. Its base name is the app name (berth-vmm's tag for multi-app). */
  shareDir: string;
  /** sha256 over the share's files. */
  hash: string;
  cached: boolean;
  ms: number;
  /** Where the SDK runtime came from: the project or the CLI, or the image for a Python app. */
  sdkFrom: "project" | "cli" | "image";
  sdkRuntime: string;
}

interface CacheIndex {
  format: number;
  inputs: { path: string; sha256: string }[];
  listing: string;
  hash: string;
  shareDir: string;
  sdkFrom: "project" | "cli" | "image";
  sdkRuntime: string;
}

type Esbuild = typeof import("esbuild");

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliRequire = createRequire(join(CLI_DIR, "package.json"));

function projectRequire(appDir: string) {
  return createRequire(join(appDir, "package.json"));
}

export function loadEsbuild(appDir: string): Esbuild {
  for (const req of [projectRequire(appDir), cliRequire]) {
    try {
      return req("esbuild") as Esbuild;
    } catch {}
  }
  throw new Error("esbuild is not installed in the project or alongside the berth CLI — `npm install esbuild` in the project");
}

export function resolveSdkRuntime(appDir: string): { path: string; from: "project" | "cli" } {
  try {
    return { path: projectRequire(appDir).resolve("@berthos/sdk/runtime"), from: "project" };
  } catch {}
  try {
    return { path: cliRequire.resolve("@berthos/sdk/runtime"), from: "cli" };
  } catch {}
  throw new Error("@berthos/sdk is not installed in the project or alongside the berth CLI");
}

export function findEntry(appDir: string): string {
  for (const rel of ["src/index.ts", "src/index.mts", "src/index.js", "src/index.mjs"]) {
    if (existsSync(join(appDir, rel))) return join(appDir, rel);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { main?: string };
    if (pkg.main && existsSync(join(appDir, pkg.main))) return join(appDir, pkg.main);
  } catch {}
  throw new Error(`no app entry in ${appDir}: expected src/index.ts (or src/index.js, or package.json "main")`);
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".berth", ".git", ".turbo", "coverage", "__pycache__", "venv"]);

/** The app's own source files, by relative path (names only): a file appearing or disappearing changes it. */
export function sourceListing(appDir: string): string {
  return createHash("sha256").update(sourceFiles(appDir).join("\n")).digest("hex");
}

/** The app's own files, relative and sorted: what sourceListing names and a Python share holds. */
export function sourceFiles(appDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile()) out.push(relative(appDir, full));
    }
  };
  walk(appDir, 0);
  return out.sort();
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function hashInputs(paths: string[]): Promise<{ path: string; sha256: string }[] | undefined> {
  try {
    return await Promise.all(paths.map(async (path) => ({ path, sha256: sha256(await readFile(path)) })));
  } catch {
    return undefined;
  }
}

function cacheKey(appDir: string, name: string): string {
  let real = appDir;
  try {
    real = realpathSync(appDir);
  } catch {}
  return `${name}-${sha256(real).slice(0, 16)}`;
}

const builtin = (p: string) => p.startsWith("node:") || builtinModules.includes(p);

/**
 * A bare import esbuild can't resolve from the importing file is retried from
 * the CLI's own directory, where @berthos/sdk and zod are dependencies.
 */
/** Imports left out of a VM bundle on purpose: the SDK catches their failure to load. */
const OPTIONAL_EXTERNALS = ["@xenova/transformers"];

/**
 * Packages an optional layer provides, imported from it by absolute path
 * (docs/design/microvm-layers.md): playwright-core reads its own package files
 * at run time and doesn't survive bundling, so the browser layer carries it.
 */
export const LAYER_IMPORTS: Record<string, string> = {
  "playwright-core": "/usr/lib/berth/node_modules/playwright-core/index.mjs",
};

function layerImports(): import("esbuild").Plugin {
  return {
    name: "berth-layer-imports",
    setup(build) {
      build.onResolve({ filter: /^playwright-core$/ }, (args) => ({ path: LAYER_IMPORTS[args.path]!, external: true }));
    },
  };
}

function cliFallback(): import("esbuild").Plugin {
  return {
    name: "berth-cli-fallback",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData?.berthFallback || builtin(args.path)) return undefined;
        const first = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { berthFallback: true } });
        if (first.errors.length === 0) return first;
        const second = await build.resolve(args.path, { kind: args.kind, resolveDir: CLI_DIR, pluginData: { berthFallback: true } });
        return second.errors.length === 0 ? second : first;
      });
    },
  };
}

export interface BundleOptions {
  /** Cache root. Default ~/.berth/vm/apps. */
  cacheRoot?: string;
  /** Rebundle even when the cache says nothing changed. */
  force?: boolean;
  /** berth.yml's `runtime:` (default node). */
  runtime?: "node" | "python";
}

export async function bundleApp(appDir: string, name: string, options: BundleOptions = {}): Promise<BundledApp> {
  if (options.runtime === "python") return bundlePythonApp(appDir, name, options);
  const t0 = Date.now();
  const root = join(options.cacheRoot ?? vmAppsCache(), cacheKey(appDir, name));
  const indexPath = join(root, "index.json");
  const listing = sourceListing(appDir);

  if (!options.force) {
    const index = await readFile(indexPath, "utf8").then((t) => JSON.parse(t) as CacheIndex, () => undefined);
    if (index && index.format === BUNDLE_FORMAT && index.listing === listing && existsSync(join(index.shareDir, "berth.yml"))) {
      const now = await hashInputs(index.inputs.map((i) => i.path));
      if (now && now.every((h, i) => h.sha256 === index.inputs[i]!.sha256)) {
        return { name, shareDir: index.shareDir, hash: index.hash, cached: true, ms: Date.now() - t0, sdkFrom: index.sdkFrom, sdkRuntime: index.sdkRuntime };
      }
    }
  }

  const esbuild = loadEsbuild(appDir);
  const sdk = resolveSdkRuntime(appDir);
  const proto = join(dirname(sdk.path), "..", "proto", "context_bus.proto");
  if (!existsSync(proto)) throw new Error(`the SDK at ${dirname(dirname(sdk.path))} has no proto/context_bus.proto`);
  const manifest = join(appDir, "berth.yml");
  const entry = findEntry(appDir);

  await mkdir(root, { recursive: true });
  const work = join(root, `.work-${process.pid}-${Date.now()}`);
  try {
    const result = await esbuild.build({
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outdir: work,
      outExtension: { ".js": ".mjs" },
      entryPoints: { runtime: sdk.path, "dist/index": entry },
      absWorkingDir: appDir,
      // Bundled ESM still meets CommonJS packages that call require().
      banner: { js: 'import { createRequire as __berthCreateRequire } from "node:module"; const require = __berthCreateRequire(import.meta.url);' },
      plugins: [layerImports(), cliFallback()],
      // The SDK imports it lazily for semantic-fs embeddings. In the guest it
      // loads the rootfs's kit instead (BERTH_EMBEDDINGS_DIR), and inlined
      // here it is megabytes of an app's share that never run.
      external: OPTIONAL_EXTERNALS,
      metafile: true,
      logLevel: "silent",
    }).catch((err: { errors?: { text: string; location?: { file?: string; line?: number } | null }[] }) => {
      const first = err.errors?.[0];
      const where = first?.location?.file ? ` (${first.location.file}:${first.location.line})` : "";
      const native = err.errors?.some((e) => /\.node\b/.test(e.text) && /loader/.test(e.text));
      throw new Error(
        native
          ? `can't bundle ${name} for the VM: it depends on a native addon (.node), built for this host, not for the guest's Linux — use --runtime docker`
          : `can't bundle ${name} for the VM: ${first?.text ?? String(err)}${where}`,
      );
    });
    for (const [file, output] of Object.entries(result.metafile.outputs)) {
      const bare = output.imports.filter((i) => i.external && !builtin(i.path) && !OPTIONAL_EXTERNALS.includes(i.path) && !Object.values(LAYER_IMPORTS).includes(i.path));
      if (bare.length > 0) throw new Error(`can't bundle ${name} for the VM: ${file} still imports ${bare.map((i) => i.path).join(", ")}`);
    }
    await mkdir(join(work, "proto"), { recursive: true });
    await copyFile(proto, join(work, "proto", "context_bus.proto"));
    await copyFile(manifest, join(work, "berth.yml"));

    // Content address of the share: the four files, by name and bytes.
    const files = ["berth.yml", "runtime.mjs", "dist/index.mjs", "proto/context_bus.proto"];
    const h = createHash("sha256");
    for (const f of files) h.update(`${f}\0`).update(sha256(await readFile(join(work, f)))).update("\n");
    const hash = h.digest("hex");
    const shareParent = join(root, hash.slice(0, 16));
    const shareDir = join(shareParent, name);
    if (!existsSync(join(shareDir, "berth.yml"))) {
      await rm(shareParent, { recursive: true, force: true });
      await mkdir(shareParent, { recursive: true });
      await rename(work, shareDir);
    }

    const inputPaths = [...new Set([manifest, ...Object.keys(result.metafile.inputs).map((p) => resolve(appDir, p)), proto])].filter((p) => !p.includes("\0"));
    const inputs = (await hashInputs(inputPaths)) ?? [];
    const index: CacheIndex = { format: BUNDLE_FORMAT, inputs, listing, hash, shareDir, sdkFrom: sdk.from, sdkRuntime: sdk.path };
    await writeFile(`${indexPath}.tmp`, JSON.stringify(index));
    await rename(`${indexPath}.tmp`, indexPath);
    await prune(root, [hash.slice(0, 16)]);
    return { name, shareDir, hash, cached: false, ms: Date.now() - t0, sdkFrom: sdk.from, sdkRuntime: sdk.path };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The share's marker berth-init reads to pick the runtime (packages/vmm/init/src/plan.rs RUNTIME_FILE). */
export const RUNTIME_FILE = ".berth-runtime";
/** A Python share is the app's own files; past these it is not a source tree. */
export const PYTHON_SHARE_MAX_FILES = 2000;
export const PYTHON_SHARE_MAX_BYTES = 32 << 20;

/**
 * A `runtime: python` app's share: its own files as they are (sourceFiles:
 * no __pycache__, venv, node_modules or dot directories), plus RUNTIME_FILE.
 * berth-init starts it as `python3 -m berth_sdk.runtime`, which loads
 * src/app.py, with the image's berth_sdk on PYTHONPATH, as a container does.
 * Only the standard library and berth_sdk's own dependencies (pyyaml,
 * pydantic, protobuf) are there: nothing is pip-installed.
 */
export async function bundlePythonApp(appDir: string, name: string, options: BundleOptions = {}): Promise<BundledApp> {
  const t0 = Date.now();
  const root = join(options.cacheRoot ?? vmAppsCache(), cacheKey(appDir, name));
  const indexPath = join(root, "index.json");
  const files = sourceFiles(appDir);
  const listing = createHash("sha256").update(files.join("\n")).digest("hex");
  const sdk = { from: "image" as const, path: "/opt/berth/sdk-python" };
  if (!files.includes("src/app.py")) throw new Error(`no app entry in ${appDir}: a runtime: python app needs src/app.py`);
  if (!files.includes("berth.yml")) throw new Error(`no berth.yml in ${appDir}`);
  if (files.length > PYTHON_SHARE_MAX_FILES) throw new Error(`${name} has ${files.length} files, more than the ${PYTHON_SHARE_MAX_FILES} a Python app's VM share takes; is a virtualenv or data directory in the app directory?`);

  if (!options.force) {
    const index = await readFile(indexPath, "utf8").then((t) => JSON.parse(t) as CacheIndex, () => undefined);
    if (index && index.format === BUNDLE_FORMAT && index.listing === listing && existsSync(join(index.shareDir, RUNTIME_FILE))) {
      const now = await hashInputs(index.inputs.map((i) => i.path));
      if (now && now.every((h, i) => h.sha256 === index.inputs[i]!.sha256)) {
        return { name, shareDir: index.shareDir, hash: index.hash, cached: true, ms: Date.now() - t0, sdkFrom: sdk.from, sdkRuntime: sdk.path };
      }
    }
  }

  await mkdir(root, { recursive: true });
  const work = join(root, `.work-${process.pid}-${Date.now()}`);
  try {
    const h = createHash("sha256");
    const inputs: { path: string; sha256: string }[] = [];
    let bytes = 0;
    for (const f of files) {
      const data = await readFile(join(appDir, f));
      bytes += data.length;
      if (bytes > PYTHON_SHARE_MAX_BYTES) throw new Error(`${name}'s files are more than ${PYTHON_SHARE_MAX_BYTES >> 20} MiB, more than a Python app's VM share takes`);
      const digest = sha256(data);
      inputs.push({ path: join(appDir, f), sha256: digest });
      h.update(`${f}\0`).update(digest).update("\n");
      await mkdir(dirname(join(work, f)), { recursive: true });
      await writeFile(join(work, f), data);
    }
    await writeFile(join(work, RUNTIME_FILE), "python\n");
    h.update(`${RUNTIME_FILE}\0python\n`);
    const hash = h.digest("hex");
    const shareParent = join(root, hash.slice(0, 16));
    const shareDir = join(shareParent, name);
    if (!existsSync(join(shareDir, RUNTIME_FILE))) {
      await rm(shareParent, { recursive: true, force: true });
      await mkdir(shareParent, { recursive: true });
      await rename(work, shareDir);
    }
    const index: CacheIndex = { format: BUNDLE_FORMAT, inputs, listing, hash, shareDir, sdkFrom: sdk.from, sdkRuntime: sdk.path };
    await writeFile(`${indexPath}.tmp`, JSON.stringify(index));
    await rename(`${indexPath}.tmp`, indexPath);
    await prune(root, [hash.slice(0, 16)]);
    return { name, shareDir, hash, cached: false, ms: Date.now() - t0, sdkFrom: sdk.from, sdkRuntime: sdk.path };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Keeps the newest few bundles of one app (a running VM may still be using the previous one). */
async function prune(root: string, keep: string[], max = 3): Promise<void> {
  const dirs = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && /^[0-9a-f]{16}$/.test(d.name));
  const sorted = (
    await Promise.all(dirs.map(async (d) => ({ name: d.name, mtime: await stat(join(root, d.name)).then((st) => st.mtimeMs, () => 0) })))
  ).sort((a, b) => b.mtime - a.mtime);
  const drop = sorted.filter((d) => !keep.includes(d.name)).slice(Math.max(0, max - keep.length));
  for (const d of drop) await rm(join(root, d.name), { recursive: true, force: true });
}
