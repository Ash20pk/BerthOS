#!/usr/bin/env node
import { resolveServerTlsFromEnv, schemeFor } from "@berth/tls";
import { createMeshCoordinatorServer } from "./index.js";

const port = Number(process.env.BERTH_MESH_COORDINATOR_PORT ?? 4875);
const host = process.env.BERTH_MESH_COORDINATOR_HOST ?? "127.0.0.1";
const dataDir = process.env.BERTH_MESH_COORDINATOR_DATA_DIR ?? "./.berth-mesh-coordinator-data";

const tls = resolveServerTlsFromEnv("BERTH_MESH_COORDINATOR");
const app = await createMeshCoordinatorServer({ dataDir, logger: true, tls });
await app.listen({ port, host });
console.log(`[berth-mesh-coordinator] listening on ${schemeFor(tls)}://${host}:${port} (data: ${dataDir})`);

// Drain on SIGTERM/SIGINT (BUILD_PLAN M0.5): app.close() stops accepting,
// waits for in-flight requests, then runs onClose hooks — which is where the
// SQLite handle is closed — before the process exits.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`[berth-mesh-coordinator] ${signal} received, draining`);
    app.close().then(
      () => process.exit(0),
      (err) => {
        console.error(`[berth-mesh-coordinator] error during drain:`, err);
        process.exit(1);
      },
    );
  });
}
