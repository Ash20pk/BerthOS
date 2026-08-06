import { Command, Args, Flags } from "@oclif/core";
import { loadManifestOrExit } from "../../util/manifest.js";
import { buildProductionImage, productionImageTag } from "../../util/build.js";
import { resolveFleet } from "../../util/fleet.js";
import { readFleetState, appendFleetInstances, removeFleetInstances } from "../../util/fleet-state.js";

/**
 * Manual, on-demand scaling — the operator (or a script/cron they control)
 * decides when and how far, and this reconciles the recorded instance count
 * for one app on one fleet up or down to match. This is NOT automatic
 * load-based autoscaling (what Cloudflare Containers/Modal do) — that's a
 * genuinely larger feature (a metrics pipeline, scale-trigger thresholds, a
 * running daemon deciding on its own) explicitly out of scope here; see
 * gaps.md gap #31 for the full boundary.
 */
export default class FleetScale extends Command {
  static override description =
    "Scale a fleet's instances of this app up or down to a target count. Manual/on-demand — not automatic load-based autoscaling (see gaps.md gap #31)";
  static override args = {
    fleet: Args.string({ required: true, description: "fleet name (e2b, daytona, or a ~/.berthrc alias)" }),
  };
  static override flags = {
    count: Flags.integer({ required: true, description: "target instance count for this app on this fleet" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FleetScale);
    if (flags.count < 0) this.error(`--count must be at least 0, got ${flags.count}`);

    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);

    const state = await readFleetState(args.fleet);
    const current = state.instances.filter((instance) => instance.appName === manifest.name);

    if (current.length === flags.count) {
      this.log(`"${manifest.name}" on fleet "${args.fleet}" is already at ${flags.count} instance${flags.count === 1 ? "" : "s"}.`);
      return;
    }

    const { adapter } = await resolveFleet(args.fleet);

    if (current.length > flags.count) {
      if (!adapter.connect) {
        this.error(`${adapter.name} adapter doesn't support reconnecting to an existing instance by id — can't scale down`);
      }
      // Tears down the most recently started instances first — the ones a
      // prior scale-up call added, left alone if this call is undoing that
      // exact change. Arbitrary among instances with no other ordering
      // signal, but not random: consistent and predictable run to run.
      const toRemove = current.slice(flags.count);
      this.log(`Scaling "${manifest.name}" on fleet "${args.fleet}" down from ${current.length} to ${flags.count} — stopping ${toRemove.length}...`);
      for (const instance of toRemove) {
        const handle = await adapter.connect(instance.id);
        await adapter.teardown(handle);
        this.log(`  stopped ${instance.id}`);
      }
      await removeFleetInstances(args.fleet, toRemove.map((instance) => instance.id));
      return;
    }

    const toAdd = flags.count - current.length;
    this.log(`Scaling "${manifest.name}" on fleet "${args.fleet}" up from ${current.length} to ${flags.count} — starting ${toAdd}...`);
    this.log(`Building production image for "${manifest.name}"...`);
    await buildProductionImage(appDir, manifest);
    const imageRef = productionImageTag(manifest);
    const target = { imageRef, manifest };
    const { remoteImageRef } = await adapter.upload(target);

    for (let i = 0; i < toAdd; i++) {
      const handle = await adapter.start(remoteImageRef, target);
      this.log(`  started ${handle.id}`);
      await appendFleetInstances(args.fleet, [{ id: handle.id, appName: manifest.name, startedAt: new Date().toISOString() }]);
    }
  }
}
