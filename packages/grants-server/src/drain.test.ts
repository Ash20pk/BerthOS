import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// Kill-under-load (BUILD_PLAN M0.5): boot the real server binary, put
// requests in flight, SIGTERM it, and assert it drains — in-flight requests
// get answered, the process exits 0, and new connections are refused.
test("berth-grants drains in-flight requests on SIGTERM and exits 0", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-grants-drain-"));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const serverJs = join(dirname(fileURLToPath(import.meta.url)), "server.js");
  const child = spawn(process.execPath, [serverJs], {
    env: {
      ...process.env,
      BERTH_GRANTS_PORT: String(port),
      BERTH_GRANTS_DATA_DIR: dataDir,
      BERTH_GRANTS_OPERATOR_TOKEN: "drain-test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  try {
    // Wait for the server to answer /health.
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        const res = await fetch(`${base}/health`);
        up = res.ok;
      } catch {
        await sleep(100);
      }
    }
    assert.ok(up, "server never became healthy");

    // Load: a burst of writes in flight while the signal lands.
    const inFlight = Array.from({ length: 20 }, (_, i) =>
      fetch(`${base}/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appName: `load-${i}`, capability: "fs:read:/tmp" }),
      }),
    );
    // Give the burst a beat to actually reach the server before the signal
    // lands — otherwise the drain closes the listener before any socket
    // connects and the test measures the OS, not the server.
    await sleep(50);
    child.kill("SIGTERM");

    const responses = await Promise.allSettled(inFlight);
    const answered = responses.filter(
      (r) => r.status === "fulfilled" && (r.value.status === 200 || r.value.status === 201),
    ).length;
    // Every request that reached the server before the drain must be
    // answered, not dropped; requests the OS never delivered may reject.
    assert.ok(answered >= 1, `expected in-flight requests to be answered, got ${answered}/20`);

    const code = await exited;
    assert.equal(code, 0, "server should exit 0 after draining");

    // Drained means drained: nothing is listening any more.
    await assert.rejects(fetch(`${base}/health`));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
  }
});
