#!/usr/bin/env node
import { createGrantsServer } from "./index.js";

const port = Number(process.env.BERTH_GRANTS_PORT ?? 4874);
const host = process.env.BERTH_GRANTS_HOST ?? "127.0.0.1";
const dataDir = process.env.BERTH_GRANTS_DATA_DIR ?? "./.berth-grants-data";
const webhookUrl = process.env.BERTH_GRANTS_WEBHOOK_URL;

const app = await createGrantsServer({ dataDir, webhookUrl });
await app.listen({ port, host });
console.log(`[berth-grants] listening on http://${host}:${port} (data: ${dataDir})`);
