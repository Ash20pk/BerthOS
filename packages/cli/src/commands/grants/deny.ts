import { Command, Args, Flags } from "@oclif/core";
import { applyClientTls, warnIfCredentialOverPlaintext } from "@berth/tls";
import { userInfo } from "node:os";

const DEFAULT_SERVER = "http://127.0.0.1:4874";

export default class GrantsDeny extends Command {
  static override description = "Deny a pending capability grant";
  static override args = {
    id: Args.string({ required: true, description: "grant id, from `berth grants list`" }),
  };
  static override flags = {
    server: Flags.string({ description: "berth-grants server URL", default: DEFAULT_SERVER }),
    ca: Flags.string({
      description: "CA certificate to trust for an https:// server (e.g. the one `berth tls init` minted); also settable via NODE_EXTRA_CA_CERTS",
    }),
    insecure: Flags.boolean({
      description: "skip TLS certificate verification — encrypted but unauthenticated, and trivially interceptable. Use --ca instead",
      default: false,
    }),
    by: Flags.string({ description: "who denied this (defaults to the current OS user)" }),
    reason: Flags.string({ description: "why this was denied" }),
    token: Flags.string({
      description: "berth-grants operator token (also read from BERTH_GRANTS_TOKEN) — printed by `berth-grants` on first start, or saved to <data-dir>/operator.token",
      env: "BERTH_GRANTS_TOKEN",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GrantsDeny);
    applyClientTls(flags);
    warnIfCredentialOverPlaintext(flags.server, "an operator token");
    const decidedBy = flags.by ?? userInfo().username;

    const res = await fetch(new URL(`/grants/${args.id}/deny`, flags.server), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(flags.token ? { authorization: `Bearer ${flags.token}` } : {}),
      },
      body: JSON.stringify({ decidedBy, reason: flags.reason }),
    });
    const body = await res.json();
    if (!res.ok) this.error(`berth-grants returned ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`);

    const grant = body as { appName: string; capability: string };
    this.log(`Denied ${grant.capability} for "${grant.appName}".`);
  }
}
