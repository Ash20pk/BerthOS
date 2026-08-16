#!/usr/bin/env node
import { resolveServerTlsFromEnv, schemeFor } from "@berth/tls";
import { createMeshCoordinatorServer } from "./index.js";

const port = Number(process.env.BERTH_MESH_COORDINATOR_PORT ?? 4875);
const host = process.env.BERTH_MESH_COORDINATOR_HOST ?? "127.0.0.1";
const dataDir = process.env.BERTH_MESH_COORDINATOR_DATA_DIR ?? "./.berth-mesh-coordinator-data";

const tls = resolveServerTlsFromEnv("BERTH_MESH_COORDINATOR");
const app = await createMeshCoordinatorServer({ dataDir, tls });
await app.listen({ port, host });
console.log(`[berth-mesh-coordinator] listening on ${schemeFor(tls)}://${host}:${port} (data: ${dataDir})`);
