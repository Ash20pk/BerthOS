import { Command, Args } from "@oclif/core";
import { readFleetState } from "../../util/fleet-state.js";
import { resolveFleet } from "../../util/fleet.js";

export default class FleetStatus extends Command {
  static override description =
    "Show instances this CLI has started against a fleet alias — from local state (nothing persisted this before), cross-checked against the live provider when reachable";
  static override args = {
    fleet: Args.string({ required: true, description: "fleet name (e2b, daytona, or a ~/.berthrc alias)" }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(FleetStatus);
    const state = await readFleetState(args.fleet);

    if (state.instances.length === 0) {
      this.log(`No instances recorded locally for fleet "${args.fleet}".`);
    } else {
      this.log(`Locally recorded instances for fleet "${args.fleet}":`);
      for (const instance of state.instances) {
        this.log(`  ${instance.id}  ${instance.appName}  started ${instance.startedAt}`);
      }
    }

    // Ports to try adapter.previewUrl() against per instance — computed and
    // recorded once at `berth deploy` time (see deploy.ts's previewPortsFor),
    // since this command has no access to the deployed app's own berth.yml
    // to re-derive expose.preview/declared capabilities from.
    const previewPortsById = new Map(state.instances.map((instance) => [instance.id, instance.previewPorts ?? []]));

    try {
      const { adapter } = await resolveFleet(args.fleet);
      if (!adapter.list) {
        this.log(`\n(${adapter.name} adapter doesn't support live listing — showing local state only.)`);
        return;
      }
      const live = await adapter.list();
      this.log(`\nLive on ${adapter.name}: ${live.length} instance${live.length === 1 ? "" : "s"}`);
      for (const handle of live) {
        this.log(`  ${handle.id}`);
        for (const port of previewPortsById.get(handle.id) ?? []) {
          const url = await adapter.previewUrl?.(handle, port);
          if (url) this.log(`    preview (port ${port}): ${url}`);
        }
      }
    } catch (err) {
      this.log(`\n(couldn't reach "${args.fleet}" for a live cross-check: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
