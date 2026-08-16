#!/usr/bin/env node
import { resolveServerTlsFromEnv, schemeFor } from "@berth/tls";
import { createGrantsServer, readOrCreateOperatorToken } from "./index.js";

const port = Number(process.env.BERTH_GRANTS_PORT ?? 4874);
const host = process.env.BERTH_GRANTS_HOST ?? "127.0.0.1";
const dataDir = process.env.BERTH_GRANTS_DATA_DIR ?? "./.berth-grants-data";
const webhookUrl = process.env.BERTH_GRANTS_WEBHOOK_URL;
const operatorToken = process.env.BERTH_GRANTS_OPERATOR_TOKEN ?? readOrCreateOperatorToken(dataDir);

const tls = resolveServerTlsFromEnv("BERTH_GRANTS");
const app = await createGrantsServer({ dataDir, webhookUrl, operatorToken, tls });
await app.listen({ port, host });
console.log(`[berth-grants] listening on ${schemeFor(tls)}://${host}:${port} (data: ${dataDir})`);
if (!process.env.BERTH_GRANTS_OPERATOR_TOKEN) {
  console.log(`[berth-grants] operator token (required for approve/deny, also saved to ${dataDir}/operator.token):`);
  console.log(`[berth-grants]   ${operatorToken}`);
  console.log(`[berth-grants] pass it to \`berth grants approve/deny\` via --token or BERTH_GRANTS_TOKEN`);
}
