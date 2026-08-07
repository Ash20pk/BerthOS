import { buildImage } from "@berth/docker-orchestrator";
import type { ComputerAppSpec } from "./resolve-apps.js";

/**
 * One buildImage() call, primary + companions — mirrors @berth/cli's
 * buildProductionImage() exactly, minus its pnpm-workspace requirement (this
 * is a library used by a long-running agent process, and production image
 * staging already works for arbitrary standalone directories).
 *
 * Always `target: "production"`, including for Computer.boot()'s relaxed
 * `enforcement: "warn"` mode. The `dev` target is not an alternative here:
 * base.Dockerfile's dev stage has no `COPY . /app`, because it expects the
 * bind mount `berth dev` provides and a Computer deliberately doesn't have —
 * building it would produce a container with no application source in it.
 * Relaxing enforcement is done at boot instead, by overriding the image's
 * BERTH_REQUIRE_ENFORCEMENT in the container's environment.
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
