import { Args, Command, Flags } from "@oclif/core";
import { VmSandbox } from "../../vm/sandbox.js";

export default class VmStatus extends Command {
  static override description = "List the running microVM sandboxes, or show one's apps, pids, cgroups and limits as berth-init reports them";
  static override examples = ["<%= config.bin %> vm status", "<%= config.bin %> vm status berth-dev-notes --json"];
  static override args = { name: Args.string({ description: "a sandbox name (berth dev --runtime vm uses berth-dev-<app>)" }) };
  static override flags = { json: Flags.boolean({ description: "berth-init's status answer as JSON", default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VmStatus);
    const names = args.name ? [args.name] : VmSandbox.listNames();
    let found = 0;
    for (const name of names) {
      let sandbox: VmSandbox | undefined;
      try {
        sandbox = await VmSandbox.find(name, { onStale: (why) => this.log(`${name}: stale (${why}); cleaned up its run dir`) });
      } catch (err) {
        this.log(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!sandbox) {
        if (args.name) this.error(`no running sandbox named "${name}"`);
        continue;
      }
      found++;
      const status = await sandbox.status().catch((err: Error) => ({ error: err.message }) as Record<string, unknown>);
      sandbox.detach();
      if (flags.json) {
        this.log(JSON.stringify({ name, pid: sandbox.pid, runDir: sandbox.runDir, bootId: sandbox.bootId, status }, null, 2));
        continue;
      }
      const apps = (Array.isArray(status.apps) ? status.apps : []) as { name?: string; state?: string; pid?: number; uid?: number; cgroup?: { limits?: Record<string, string> } | null }[];
      this.log(`${name}  berth-vmm pid ${sandbox.pid}  boot ${sandbox.bootId}  started ${sandbox.record.startedAt}`);
      this.log(`  run dir ${sandbox.runDir}`);
      for (const a of apps) {
        const limits = a.cgroup?.limits ? Object.entries(a.cgroup.limits).map(([k, v]) => `${k}=${v.replace(" ", "/")}`).join(" ") : "no cgroup";
        this.log(`  ${a.name ?? "?"}: ${a.state ?? "?"}, pid ${a.pid ?? "-"}, uid ${a.uid ?? "-"}, ${limits}`);
      }
    }
    if (!args.name && found === 0 && !flags.json) this.log("no microVM sandboxes running");
  }
}
