import { Command, Args, Flags } from "@oclif/core";
import { userInfo } from "node:os";

const DEFAULT_SERVER = "http://127.0.0.1:4874";

export default class GrantsDeny extends Command {
  static override description = "Deny a pending capability grant";
  static override args = {
    id: Args.string({ required: true, description: "grant id, from `berth grants list`" }),
  };
  static override flags = {
    server: Flags.string({ description: "berth-grants server URL", default: DEFAULT_SERVER }),
    by: Flags.string({ description: "who denied this (defaults to the current OS user)" }),
    reason: Flags.string({ description: "why this was denied" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GrantsDeny);
    const decidedBy = flags.by ?? userInfo().username;

    const res = await fetch(new URL(`/grants/${args.id}/deny`, flags.server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy, reason: flags.reason }),
    });
    const body = await res.json();
    if (!res.ok) this.error(`berth-grants returned ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`);

    const grant = body as { appName: string; capability: string };
    this.log(`Denied ${grant.capability} for "${grant.appName}".`);
  }
}
