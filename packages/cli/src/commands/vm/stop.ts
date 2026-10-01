import { Args, Command, Flags } from "@oclif/core";
import { VmSandbox } from "../../vm/sandbox.js";

export default class VmStop extends Command {
  static override description = "Stop a microVM sandbox: berth-init stops its apps, syncs and unmounts, and powers off; berth-vmm is killed if it hasn't exited by the timeout";
  static override examples = ["<%= config.bin %> vm stop berth-dev-notes"];
  static override args = { name: Args.string({ required: true, description: "the sandbox name (see `berth vm status`)" }) };
  static override flags = { timeout: Flags.integer({ description: "seconds to wait for a clean power-off before SIGKILL", default: 10 }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VmStop);
    const sandbox = await VmSandbox.find(args.name, { onStale: (why) => this.log(`stale: ${why}; cleaned up its run dir`) }).catch((err: Error) => {
      this.warn(err.message);
      return undefined;
    });
    if (!sandbox) {
      this.log(`no running sandbox named "${args.name}"`);
      return;
    }
    const t0 = Date.now();
    const result = await sandbox.stop({ timeoutMs: flags.timeout * 1000 });
    if (result.killed) this.warn(`"${args.name}" didn't power off within ${flags.timeout}s; berth-vmm was killed (the state disk's ext4 journal is all that protects /workspace)`);
    else this.log(`"${args.name}" stopped in ${Date.now() - t0} ms (${String(result.powerOff?.reason ?? "power off")})`);
  }
}
