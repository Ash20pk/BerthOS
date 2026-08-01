import { buildImage } from "@berth/docker-orchestrator";
import type { ComputerAppSpec } from "./resolve-apps.js";

/**
 * One buildImage() call, primary + companions — mirrors @berth/cli's
 * buildProductionImage() exactly, minus its pnpm-workspace requirement (this
 * is a library used by a long-running agent process, and production image
 * staging already works for arbitrary standalone directories). Always builds
 * `target: "production"` — an agent's computer isn't a `berth dev` hot-reload
 * loop, so there's no reason to rely on a bind-mounted dev image.
 */
export async function buildComputerImage(apps: ComputerAppSpec[]): Promise<string> {
  const [primary, ...companions] = apps;
  if (!primary) {
    throw new Error("buildComputerImage() needs at least one app");
  }

  const tag = `berth-agent/${primary.name}:${Date.now()}`;
  await buildImage({
    appDir: primary.appDir,
    tag,
    target: "production",
    ...(companions.length > 0
      ? { appName: primary.name, companions: companions.map((c) => ({ name: c.name, appDir: c.appDir })) }
      : {}),
  });
  return tag;
}
