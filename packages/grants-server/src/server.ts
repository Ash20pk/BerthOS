#!/usr/bin/env node
import { homedir } from "node:os";
import { combineAuditSinks, createConsoleAuditSink, createFileAuditSink, defaultAuditPath } from "@berth/audit";
import { resolveServerTlsFromEnv, schemeFor } from "@berth/tls";
import { addOperator, createGrantsServer, loadOperatorRegistry, singleTokenRegistry } from "./index.js";

const port = Number(process.env.BERTH_GRANTS_PORT ?? 4874);
const host = process.env.BERTH_GRANTS_HOST ?? "127.0.0.1";
const dataDir = process.env.BERTH_GRANTS_DATA_DIR ?? "./.berth-grants-data";
const webhookUrl = process.env.BERTH_GRANTS_WEBHOOK_URL;

// `berth-grants --add-operator alice` mints a named token and exits. Every
// approval made with that token is attributed to "alice" by the server
// itself, which is what makes the audit trail's actor worth reading.
const addOperatorFlag = process.argv.indexOf("--add-operator");
if (addOperatorFlag !== -1) {
  const name = process.argv[addOperatorFlag + 1];
  if (!name) {
    console.error("[berth-grants] --add-operator needs a name, e.g. --add-operator alice");
    process.exit(1);
  }
  const token = addOperator(dataDir, name);
  console.log(`[berth-grants] operator "${name}" created. This token is shown once and only its hash is stored:`);
  console.log(`[berth-grants]   ${token}`);
  process.exit(0);
}

const explicitToken = process.env.BERTH_GRANTS_OPERATOR_TOKEN;
const loaded = explicitToken ? { registry: singleTokenRegistry(explicitToken) } : loadOperatorRegistry(dataDir);

const audit = combineAuditSinks(
  createFileAuditSink({ path: process.env.BERTH_AUDIT_PATH ?? defaultAuditPath(homedir()) }),
  createConsoleAuditSink(),
);

const tls = resolveServerTlsFromEnv("BERTH_GRANTS");
const app = await createGrantsServer({ dataDir, webhookUrl, operators: loaded.registry, audit, logger: true, tls });
await app.listen({ port, host });
console.log(`[berth-grants] listening on ${schemeFor(tls)}://${host}:${port} (data: ${dataDir})`);
console.log(`[berth-grants] operators: ${loaded.registry.names().join(", ")} — add more with \`berth-grants --add-operator <name>\``);
if (loaded.mintedToken) {
  console.log(`[berth-grants] operator token (required for approve/deny, also saved to ${dataDir}/operator.token):`);
  console.log(`[berth-grants]   ${loaded.mintedToken}`);
  console.log(`[berth-grants] pass it to \`berth grants approve/deny\` via --token or BERTH_GRANTS_TOKEN`);
}
