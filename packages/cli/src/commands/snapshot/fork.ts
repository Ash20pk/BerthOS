import { Command, Args, Flags } from "@oclif/core";
import { loadManifestOrExit } from "../../util/manifest.js";
import { resolveFleet } from "../../util/fleet.js";
import { resolveInstanceId } from "../../util/resolve-instance.js";

export default class SnapshotFork extends Command {
  static override description =
    "Fork a running remote instance into a new, independent copy-on-write clone (Daytona only — see gaps.md gap #29). Distinct from `berth snapshot create --fleet`: the original instance keeps running unchanged, and the fork is live right now, not a template for later";
  static override args = {
    appName: Args.string({ required: true, description: "the app's name (as declared in its berth.yml)" }),
  };
  static override flags = {
    fleet: Flags.string({ required: true, description: "fleet alias the instance to fork is running on" }),
    instance: Flags.string({ description: "specific instance id to fork — skips the appName lookup in the fleet's local state" }),
    name: Flags.string({ description: "name for the forked instance (provider default if omitted)" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotFork);
    await loadManifestOrExit(process.cwd());

    let id: string;
    try {
      id = await resolveInstanceId(flags.fleet, args.appName, flags.instance);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }

    const { adapter } = await resolveFleet(flags.fleet);
    if (!adapter.connect) {
      this.error(`${adapter.name} adapter doesn't support reconnecting to an existing instance by id`);
    }
    if (!adapter.fork) {
      this.error(`${adapter.name} adapter doesn't support fork() — no copy-on-write clone primitive available (see gaps.md gap #29)`);
    }

    const handle = await adapter.connect(id);
    this.log(`Forking instance "${id}" on fleet "${flags.fleet}"...`);
    const forked = await adapter.fork(handle, flags.name ? { name: flags.name } : undefined);

    this.log(`Forked instance created: "${forked.id}" (original "${id}" keeps running, unaffected).`);
  }
}
