import { Command, Flags } from "@oclif/core";

const DEFAULT_SERVER = "http://127.0.0.1:4874";

export default class GrantsList extends Command {
  static override description = "List capability grant requests from a running berth-grants server";
  static override flags = {
    server: Flags.string({ description: "berth-grants server URL", default: DEFAULT_SERVER }),
    status: Flags.string({ description: "filter by status", options: ["pending", "approved", "denied"] }),
    app: Flags.string({ description: "filter by app name" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GrantsList);
    const url = new URL("/grants", flags.server);
    if (flags.status) url.searchParams.set("status", flags.status);
    if (flags.app) url.searchParams.set("app", flags.app);

    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) this.error(`berth-grants returned ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`);

    const grants = body as Array<{ id: string; appName: string; capability: string; status: string; requestedAt: string; reason: string | null }>;
    if (grants.length === 0) {
      this.log("No grants found.");
      return;
    }
    for (const g of grants) {
      this.log(`${g.id}  ${g.status.padEnd(8)}  ${g.appName}  ${g.capability}${g.reason ? `  (${g.reason})` : ""}`);
    }
  }
}
