import { Args, Command, Flags } from "@oclif/core";
import { readGuestLog, VmSandbox } from "../../vm/sandbox.js";
import { printable } from "../../vm/guest-lines.js";

export default class VmLogs extends Command {
  static override description =
    "Print a microVM sandbox's guest log (apps' stdout/stderr, berth-init, context-bus), as the process that started it saved it from the log port";
  static override examples = ["<%= config.bin %> vm logs berth-dev-notes", "<%= config.bin %> vm logs berth-dev-notes --follow"];
  static override args = { name: Args.string({ required: true, description: "the sandbox name (see `berth vm status`)" }) };
  static override flags = { follow: Flags.boolean({ char: "f", description: "keep printing new lines until the VM exits", default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VmLogs);
    const sandbox = await VmSandbox.find(args.name).catch((err: Error) => this.error(err.message));
    if (!sandbox) this.error(`no running sandbox named "${args.name}"`);
    sandbox.detach();
    let printed = 0;
    const print = () => {
      const lines = readGuestLog(sandbox.runDir);
      for (const l of lines.slice(printed)) this.log(`${String(l.t).padStart(7)} [${printable(l.src)}/${printable(l.stream)}] ${printable(l.line)}`);
      printed = lines.length;
    };
    print();
    if (!flags.follow) return;
    while (sandbox.isRunning()) {
      await new Promise((r) => setTimeout(r, 300));
      print();
    }
  }
}
