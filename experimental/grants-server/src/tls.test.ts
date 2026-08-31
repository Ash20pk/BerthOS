import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { generateSelfSignedCerts, resolveServerTls } from "@berth/tls";
import { createGrantsServer } from "./index.js";

const OPERATOR_TOKEN = "test-operator-token";

/**
 * A real listening server and a real handshake, not app.inject() — inject
 * bypasses the network stack entirely, so it would pass identically whether
 * TLS was configured or silently ignored, which is the one thing this file
 * exists to check.
 */
async function withTlsServer(fn: (url: string, caCertPath: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-grants-tls-"));
  const { caCertPath, certPath, keyPath } = generateSelfSignedCerts({ dir: join(dataDir, "certs"), hosts: ["localhost", "127.0.0.1"] });
  const app = await createGrantsServer({
    dataDir,
    operatorToken: OPERATOR_TOKEN,
    tls: resolveServerTls({ certPath, keyPath }),
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { port: number };
  try {
    await fn(`https://localhost:${address.port}`, caCertPath);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("serves HTTPS when given a cert, and a client trusting the CA can drive the whole grant flow", async () => {
  await withTlsServer(async (url, caCertPath) => {
    const dispatcher = new Agent({ connect: { ca: readFileSync(caCertPath, "utf-8") } });

    const created = await undiciFetch(`${url}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appName: "my-app", capability: "network:connect:8080" }),
      dispatcher,
    });
    assert.equal(created.status, 201);
    const grant = (await created.json()) as { id: string };

    // The operator token crossing the wire is the whole point of 5.3.
    const approved = await undiciFetch(`${url}/grants/${grant.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR_TOKEN}` },
      body: JSON.stringify({ decidedBy: "alice" }),
      dispatcher,
    });
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as { status: string }).status, "approved");
  });
});

test("refuses a client that does not trust the CA", async () => {
  await withTlsServer(async (url) => {
    await assert.rejects(
      () => undiciFetch(`${url}/grants`, { dispatcher: new Agent() }),
      (err: Error & { cause?: Error }) => {
        // undici reports every transport failure as "fetch failed"; the TLS
        // reason is on .cause, and asserting on the outer message would pass
        // for a connection refused just as happily.
        assert.match(String(err.cause?.message ?? err.message), /certificate|unable to verify|self.signed/i);
        return true;
      },
    );
  });
});

test("refuses a plain-HTTP request to a TLS server", async () => {
  await withTlsServer(async (url) => {
    const plain = url.replace("https://", "http://");
    await assert.rejects(() => undiciFetch(plain, { dispatcher: new Agent() }));
  });
});

test("stays on plain HTTP when no cert is configured", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-grants-tls-"));
  const app = await createGrantsServer({ dataDir, operatorToken: OPERATOR_TOKEN });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as { port: number };
  try {
    // Existing deployments must keep working exactly as before.
    const res = await undiciFetch(`http://127.0.0.1:${port}/grants`);
    assert.equal(res.status, 200);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
