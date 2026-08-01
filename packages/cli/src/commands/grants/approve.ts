import { Command, Args, Flags } from "@oclif/core";
import { userInfo } from "node:os";

const DEFAULT_SERVER = "http://127.0.0.1:4874";

export default class GrantsApprove extends Command {
  static override description =
    "Approve a pending capability grant — takes effect on the app's NEXT container restart, not live (Landlock rulesets are fixed at boot and can't be widened once applied)";
  static override args = {
    id: Args.string({ required: true, description: "grant id, from `berth grants list`" }),
  };
  static override flags = {
    server: Flags.string({ description: "berth-grants server URL", default: DEFAULT_SERVER }),
    by: Flags.string({ description: "who approved this (defaults to the current OS user)" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GrantsApprove);
    const decidedBy = flags.by ?? userInfo().username;

    const res = await fetch(new URL(`/grants/${args.id}/approve`, flags.server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy }),
    });
    const body = await res.json();
    if (!res.ok) this.error(`berth-grants returned ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`);

    const grant = body as { appName: string; capability: string };
    this.log(`Approved ${grant.capability} for "${grant.appName}".`);
    this.log(`This takes effect the next time "${grant.appName}"'s container restarts, not immediately.`);
  }
}
