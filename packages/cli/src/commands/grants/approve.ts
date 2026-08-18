import { Command, Args, Flags } from "@oclif/core";
import { applyClientTls, warnIfCredentialOverPlaintext } from "@berth/tls";

const DEFAULT_SERVER = "http://127.0.0.1:4874";

export default class GrantsApprove extends Command {
  static override description =
    "Approve a pending capability grant — takes effect on the app's NEXT container restart, not live (Landlock rulesets are fixed at boot and can't be widened once applied)";
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
    token: Flags.string({
      description: "berth-grants operator token (also read from BERTH_GRANTS_TOKEN) — printed by `berth-grants` on first start, or saved to <data-dir>/operator.token",
      env: "BERTH_GRANTS_TOKEN",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GrantsApprove);
    applyClientTls(flags);
    warnIfCredentialOverPlaintext(flags.server, "an operator token");

    // No `--by`: the server names the operator from the token presented. The
    // old flag defaulted to the local OS username and the server wrote it
    // down verbatim, so the recorded approver was whatever the caller felt
    // like claiming (REMEDIATION.md 5.1). Mint a named token with
    // `berth-grants --add-operator <name>` to control what gets recorded.
    const res = await fetch(new URL(`/grants/${args.id}/approve`, flags.server), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(flags.token ? { authorization: `Bearer ${flags.token}` } : {}),
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    if (!res.ok) this.error(`berth-grants returned ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`);

    const grant = body as { appName: string; capability: string; decidedBy: string };
    this.log(`Approved ${grant.capability} for "${grant.appName}", recorded as "${grant.decidedBy}".`);
    this.log(`This takes effect the next time "${grant.appName}"'s container restarts, not immediately.`);
  }
}
