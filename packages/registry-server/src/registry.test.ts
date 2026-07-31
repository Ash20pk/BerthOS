import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryServer } from "./index.js";

const MANIFEST = `
name: sample-app
version: 1.0.0
description: a sample app for registry tests
capabilities: []
exports:
  - name: ping
    output: { message: string }
`;

async function withServer(fn: (app: Awaited<ReturnType<typeof createRegistryServer>>) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-registry-test-"));
  const app = await createRegistryServer({ dataDir, now: () => "2026-01-01T00:00:00.000Z" });
  try {
    await fn(app);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function multipartBody(fields: Record<string, string>, boundary: string): string {
  let body = "";
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.tar.gz"\r\nContent-Type: application/gzip\r\n\r\nFAKE-TARBALL-BYTES\r\n`;
  body += `--${boundary}--\r\n`;
  return body;
}

test("publishes an app and serves it back via list/get/download", async () => {
  await withServer(async (app) => {
    const boundary = "----berthtest";
    const publishRes = await app.inject({
      method: "POST",
      url: "/apps",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody({ manifest: MANIFEST, author: "jordan" }, boundary),
    });
    assert.equal(publishRes.statusCode, 201, publishRes.body);
    assert.deepEqual(JSON.parse(publishRes.body), {
      name: "sample-app",
      version: "1.0.0",
      publishedAt: "2026-01-01T00:00:00.000Z",
    });

    const listRes = await app.inject({ method: "GET", url: "/apps" });
    const listed = JSON.parse(listRes.body);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "sample-app");
    assert.equal(listed[0].description, "a sample app for registry tests");

    const searchRes = await app.inject({ method: "GET", url: "/apps?q=sample" });
    assert.equal(JSON.parse(searchRes.body).length, 1);
    const missRes = await app.inject({ method: "GET", url: "/apps?q=nope" });
    assert.equal(JSON.parse(missRes.body).length, 0);

    const getRes = await app.inject({ method: "GET", url: "/apps/sample-app/latest" });
    assert.equal(getRes.statusCode, 200);
    assert.equal(JSON.parse(getRes.body).version, "1.0.0");

    const downloadRes = await app.inject({ method: "GET", url: "/apps/sample-app/1.0.0/download" });
    assert.equal(downloadRes.statusCode, 200);
    assert.equal(downloadRes.body, "FAKE-TARBALL-BYTES");
  });
});

test("rejects republishing the same name+version", async () => {
  await withServer(async (app) => {
    const boundary = "----berthtest2";
    const payload = multipartBody({ manifest: MANIFEST }, boundary);
    const headers = { "content-type": `multipart/form-data; boundary=${boundary}` };

    const first = await app.inject({ method: "POST", url: "/apps", headers, payload });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({ method: "POST", url: "/apps", headers, payload });
    assert.equal(second.statusCode, 409);
    assert.match(JSON.parse(second.body).error, /already published/);
  });
});

test("resolves 'latest' to the highest semver, not the most recent insert", async () => {
  await withServer(async (app) => {
    const boundary = "----berthtest3";
    const headers = { "content-type": `multipart/form-data; boundary=${boundary}` };

    const v2 = MANIFEST.replace("version: 1.0.0", "version: 2.0.0");
    const v1_5 = MANIFEST.replace("version: 1.0.0", "version: 1.5.0");

    await app.inject({ method: "POST", url: "/apps", headers, payload: multipartBody({ manifest: v2 }, boundary) });
    await app.inject({ method: "POST", url: "/apps", headers, payload: multipartBody({ manifest: v1_5 }, boundary) });

    const latest = await app.inject({ method: "GET", url: "/apps/sample-app/latest" });
    assert.equal(JSON.parse(latest.body).version, "2.0.0");
  });
});

test("returns 404 for an unknown app", async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: "GET", url: "/apps/does-not-exist" });
    assert.equal(res.statusCode, 404);
  });
});

test("rejects a manifest that fails schema validation", async () => {
  await withServer(async (app) => {
    const boundary = "----berthtest4";
    const badManifest = "name: Bad_Name\nversion: not-semver\n";
    const res = await app.inject({
      method: "POST",
      url: "/apps",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody({ manifest: badManifest }, boundary),
    });
    assert.equal(res.statusCode, 400);
  });
});
