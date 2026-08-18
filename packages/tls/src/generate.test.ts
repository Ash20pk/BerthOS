import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { generateSelfSignedCerts } from "./generate.js";
import { resolveServerTls } from "./server.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "berth-tls-gen-"));
}

test("generates a CA, a cert, and a key", () => {
  const { caCertPath, certPath, keyPath } = generateSelfSignedCerts({ dir: dir() });
  for (const path of [caCertPath, certPath, keyPath]) {
    assert.ok(readFileSync(path, "utf-8").includes("-----BEGIN"), `${path} should be PEM`);
  }
});

test("keeps private keys 0600 and the directory 0700", () => {
  const target = dir();
  const { keyPath } = generateSelfSignedCerts({ dir: target });
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(target, "ca.key")).mode & 0o777, 0o600);
  assert.equal(statSync(target).mode & 0o777, 0o700);
});

test("tags IP hosts as IP: and names as DNS: in the SAN", () => {
  const { certPath } = generateSelfSignedCerts({ dir: dir(), hosts: ["berth.internal", "127.0.0.1"] });
  const text = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-text"], { encoding: "utf-8" });
  // A DNS:127.0.0.1 entry is accepted by openssl and then never matches,
  // because clients compare literal IPs against iPAddress entries only.
  assert.match(text, /DNS:berth\.internal/);
  assert.match(text, /IP Address:127\.0\.0\.1/);
});

test("is idempotent unless forced", () => {
  const target = dir();
  const first = generateSelfSignedCerts({ dir: target });
  const before = readFileSync(first.certPath, "utf-8");
  generateSelfSignedCerts({ dir: target });
  assert.equal(readFileSync(first.certPath, "utf-8"), before);

  generateSelfSignedCerts({ dir: target, force: true });
  assert.notEqual(readFileSync(first.certPath, "utf-8"), before);
});

test("a generated cert actually serves HTTPS that a client trusting the CA accepts", async () => {
  const { caCertPath, certPath, keyPath } = generateSelfSignedCerts({ dir: dir(), hosts: ["localhost", "127.0.0.1"] });
  const tls = resolveServerTls({ certPath, keyPath })!;

  // A real handshake, not an assertion about the shape of a config object —
  // the SAN and key-pairing bugs this file is most likely to grow are exactly
  // the ones only a handshake catches.
  const server = createServer({ cert: tls.cert, key: tls.key }, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  try {
    const trusting = new Agent({ connect: { ca: readFileSync(caCertPath, "utf-8") } });
    const res = await undiciFetch(`https://localhost:${port}/`, { dispatcher: trusting });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    // And a client that does not know the CA must refuse it — otherwise the
    // test above would pass just as well against a broken trust setup.
    // undici surfaces every transport failure as a bare "fetch failed", so
    // the actual TLS reason is on `.cause`; asserting on the top-level
    // message would pass for a connection refused just as happily.
    await assert.rejects(
      () => undiciFetch(`https://localhost:${port}/`, { dispatcher: new Agent() }),
      (err: Error & { cause?: Error }) => {
        assert.match(String(err.cause?.message ?? err.message), /certificate|unable to verify|self.signed/i);
        return true;
      },
    );
  } finally {
    server.close();
  }
});
