import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Approve/deny need a credential the requesting app itself never sees —
 * unlike mesh-coordinator's per-peer owner tokens (minted for whoever
 * registers a resource), this is one shared secret for whoever operates
 * `berth grants approve/deny`, persisted alongside the grants database so a
 * server restart doesn't invalidate a token an operator already has.
 */
export function readOrCreateOperatorToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, "operator.token");
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf-8").trim();
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}
