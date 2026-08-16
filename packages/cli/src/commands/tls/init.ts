import { Command, Flags } from "@oclif/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateSelfSignedCerts } from "@berth/tls";

const DEFAULT_DIR = join(homedir(), ".berth", "tls");

export default class TlsInit extends Command {
  static override description =
    "Mint a local CA and server certificate for running Berth's servers over HTTPS in development or on a closed network";
  static override examples = [
    "<%= config.bin %> tls init",
    "<%= config.bin %> tls init --host grants.internal --host 10.0.0.7",
    "<%= config.bin %> tls init --dir ./certs --force",
  ];
  static override flags = {
    dir: Flags.string({ description: "where to write the CA and certificate", default: DEFAULT_DIR }),
    host: Flags.string({
      description: "hostname or IP the certificate is valid for (repeatable). Defaults to localhost, 127.0.0.1, and ::1",
      multiple: true,
    }),
    days: Flags.integer({ description: "certificate lifetime in days", default: 365 }),
    force: Flags.boolean({ description: "regenerate even if certificates already exist", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TlsInit);

    const { caCertPath, certPath, keyPath } = generateSelfSignedCerts({
      dir: flags.dir,
      hosts: flags.host,
      days: flags.days,
      force: flags.force,
    });

    this.log(`CA certificate:     ${caCertPath}`);
    this.log(`Server certificate: ${certPath}`);
    this.log(`Server key:         ${keyPath}  (0600)`);
    this.log("");
    this.log("Point a server at it:");
    this.log(`  BERTH_GRANTS_TLS_CERT=${certPath} \\`);
    this.log(`  BERTH_GRANTS_TLS_KEY=${keyPath} \\`);
    this.log("  berth-grants");
    this.log("");
    this.log("Then tell clients to trust the CA:");
    this.log(`  berth grants list --server https://localhost:4874 --ca ${caCertPath}`);
    this.log(`  # or, for every TLS client in the process: NODE_EXTRA_CA_CERTS=${caCertPath}`);
    this.log("");
    // Said here rather than only in the docs: this is the moment someone
    // decides whether to use these in production, and a self-signed CA
    // every client must be told to trust is exactly the friction that ends
    // with verification turned off instead.
    this.log("These are for development and closed internal networks. For anything reachable from a");
    this.log("network you don't control, use a certificate from a real CA — see docs/tls-reference.md.");
  }
}
