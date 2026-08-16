#!/usr/bin/env node
import { createRegistryServer } from "./index.js";

const port = Number(process.env.BERTH_REGISTRY_PORT ?? 4873);
const host = process.env.BERTH_REGISTRY_HOST ?? "127.0.0.1";
const dataDir = process.env.BERTH_REGISTRY_DATA_DIR ?? "./.berth-registry-data";

const app = await createRegistryServer({ dataDir, logger: true });
await app.listen({ port, host });
console.log(`[berth-registry] listening on http://${host}:${port} (data: ${dataDir})`);
