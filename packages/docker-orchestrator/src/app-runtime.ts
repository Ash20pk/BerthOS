import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest } from "@berthos/manifest-schema";

/**
 * The build-context directory holding each app's resolved `runtime:`, which
 * base.Dockerfile copies to /etc/berth/runtime.
 *
 * entrypoint.sh used to decide the runtime by grepping `^runtime:` out of
 * berth.yml while image.ts asked the zod loader, so the two could disagree —
 * `runtime: "python"  # note` quoted or commented one way, a YAML anchor, a
 * flow mapping — and an app would be built as one language and started as
 * the other. Now the loader decides once, at build time, and the entrypoint
 * only reads the answer. The file is in the image, root-owned, where no app
 * can rewrite it.
 */
export const APP_RUNTIME_CONTEXT_DIR = "berth-runtime";

/**
 * The entry a single-app container reads: its app's name isn't known to the
 * entrypoint until the policy has been compiled, and which compiler to run is
 * the question. `_` can't appear in an app name (`^[a-z0-9-]+$`), so this
 * can't collide with one.
 */
export const PRIMARY_RUNTIME_ENTRY = "_primary";

/**
 * Writes `<stagingDir>/berth-runtime/<name>` (containing `node` or `python`)
 * for every app the image holds, plus `_primary` for the first. Always writes
 * the directory, even for one Node app: the Dockerfile's COPY needs it to
 * exist for both targets.
 */
export async function stageAppRuntimes(stagingDir: string, apps: { name: string; appDir: string }[]): Promise<void> {
  const dir = join(stagingDir, APP_RUNTIME_CONTEXT_DIR);
  await mkdir(dir, { recursive: true });
  for (const [index, app] of apps.entries()) {
    const { runtime } = await loadManifest(join(app.appDir, "berth.yml"));
    await writeFile(join(dir, app.name), `${runtime}\n`);
    if (index === 0) await writeFile(join(dir, PRIMARY_RUNTIME_ENTRY), `${runtime}\n`);
  }
}
