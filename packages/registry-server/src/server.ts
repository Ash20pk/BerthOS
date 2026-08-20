#!/usr/bin/env node
import { resolveServerTlsFromEnv, schemeFor } from "@berth/tls";
import { createRegistryServer } from "./index.js";

const port = Number(process.env.BERTH_REGISTRY_PORT ?? 4873);
const host = process.env.BERTH_REGISTRY_HOST ?? "127.0.0.1";
const dataDir = process.env.BERTH_REGISTRY_DATA_DIR ?? "./.berth-registry-data";

const tls = resolveServerTlsFromEnv("BERTH_REGISTRY");
const app = await createRegistryServer({ dataDir, logger: true, tls });
await app.listen({ port, host });
console.log(`[berth-registry] listening on ${schemeFor(tls)}://${host}:${port} (data: ${dataDir})`);

// Drain on SIGTERM/SIGINT (BUILD_PLAN M0.5): app.close() stops accepting,
// waits for in-flight requests, then runs onClose hooks — which is where the
// SQLite handle is closed — before the process exits.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`[berth-registry] ${signal} received, draining`);
    app.close().then(
      () => process.exit(0),
      (err) => {
        console.error(`[berth-registry] error during drain:`, err);
        process.exit(1);
      },
    );
  });
}
