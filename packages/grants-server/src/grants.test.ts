import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrantsServer } from "./index.js";

const OPERATOR_TOKEN = "test-operator-token";
const AUTH_HEADER = { authorization: `Bearer ${OPERATOR_TOKEN}` };

async function withServer(
  fn: (app: Awaited<ReturnType<typeof createGrantsServer>>) => Promise<void>,
  opts: { webhookUrl?: string } = {},
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-grants-test-"));
  const app = await createGrantsServer({
    dataDir,
    now: () => "2026-01-01T00:00:00.000Z",
    webhookUrl: opts.webhookUrl,
    operatorToken: OPERATOR_TOKEN,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("requests a grant, lists it as pending, then approves it", async () => {
  await withServer(async (app) => {
    const createRes = await app.inject({
      method: "POST",
      url: "/grants",
      payload: { appName: "my-app", capability: "network:connect:8080", reason: "needs to call an internal API" },
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    const grant = JSON.parse(createRes.body);
    assert.equal(grant.status, "pending");
    assert.equal(grant.appName, "my-app");

    const listRes = await app.inject({ method: "GET", url: "/grants?status=pending" });
    assert.equal(listRes.statusCode, 200);
    assert.equal(JSON.parse(listRes.body).length, 1);

    const approveRes = await app.inject({
      method: "POST",
      url: `/grants/${grant.id}/approve`,
      headers: AUTH_HEADER,
      payload: { decidedBy: "ash" },
    });
    assert.equal(approveRes.statusCode, 200, approveRes.body);
    assert.equal(JSON.parse(approveRes.body).status, "approved");

    const approvedListRes = await app.inject({ method: "GET", url: "/grants?status=approved&app=my-app" });
    assert.deepEqual(JSON.parse(approvedListRes.body).map((g: { capability: string }) => g.capability), [
      "network:connect:8080",
    ]);
  });
});

test("denies a grant with a reason and rejects deciding it twice", async () => {
  await withServer(async (app) => {
    const createRes = await app.inject({
      method: "POST",
      url: "/grants",
      payload: { appName: "my-app", capability: "filesystem:read:/etc/secrets" },
    });
    const grant = JSON.parse(createRes.body);

    const denyRes = await app.inject({
      method: "POST",
      url: `/grants/${grant.id}/deny`,
      headers: AUTH_HEADER,
      payload: { decidedBy: "ash", reason: "too broad" },
    });
    assert.equal(denyRes.statusCode, 200);
    const denied = JSON.parse(denyRes.body);
    assert.equal(denied.status, "denied");
    assert.equal(denied.reason, "too broad");

    const secondDecision = await app.inject({
      method: "POST",
      url: `/grants/${grant.id}/approve`,
      headers: AUTH_HEADER,
      payload: { decidedBy: "someone-else" },
    });
    assert.equal(secondDecision.statusCode, 409);
  });
});

test("404s for an unknown grant id and 400s for a missing body field", async () => {
  await withServer(async (app) => {
    const missingBody = await app.inject({ method: "POST", url: "/grants", payload: { appName: "my-app" } });
    assert.equal(missingBody.statusCode, 400);

    const notFound = await app.inject({
      method: "POST",
      url: "/grants/00000000-0000-0000-0000-000000000000/approve",
      headers: AUTH_HEADER,
      payload: { decidedBy: "ash" },
    });
    assert.equal(notFound.statusCode, 404);
  });
});

test("rejects approving/denying a grant without the operator token — the actual gap #27 fix", async () => {
  await withServer(async (app) => {
    const createRes = await app.inject({
      method: "POST",
      url: "/grants",
      payload: { appName: "my-app", capability: "network:connect:8080" },
    });
    const grant = JSON.parse(createRes.body);

    const noToken = await app.inject({
      method: "POST",
      url: `/grants/${grant.id}/approve`,
      payload: { decidedBy: "my-app" },
    });
    assert.equal(noToken.statusCode, 401, noToken.body);

    const wrongToken = await app.inject({
      method: "POST",
      url: `/grants/${grant.id}/approve`,
      headers: { authorization: "Bearer not-the-operator-token" },
      payload: { decidedBy: "my-app" },
    });
    assert.equal(wrongToken.statusCode, 401, wrongToken.body);

    const deniedWithoutToken = await app.inject({
      method: "POST",
      url: `/grants/${grant.id}/deny`,
      payload: { decidedBy: "my-app" },
    });
    assert.equal(deniedWithoutToken.statusCode, 401, deniedWithoutToken.body);

    // Still pending after both self-approval attempts were rejected.
    const stillPending = await app.inject({ method: "GET", url: `/grants/${grant.id}` });
    assert.equal(JSON.parse(stillPending.body).status, "pending");

    const approved = await app.inject({
      method: "POST",
      url: `/grants/${grant.id}/approve`,
      headers: AUTH_HEADER,
      payload: { decidedBy: "ash" },
    });
    assert.equal(approved.statusCode, 200, approved.body);
  });
});

test("notifies a configured webhook when a grant is requested", async () => {
  const received: unknown[] = [];
  const http = await import("node:http");
  const webhookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
  const address = webhookServer.address();
  const webhookUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  try {
    await withServer(
      async (app) => {
        await app.inject({
          method: "POST",
          url: "/grants",
          payload: { appName: "my-app", capability: "network:connect:8080" },
        });
        // notifyWebhook() is fire-and-forget — give it a tick to land.
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      { webhookUrl },
    );
    assert.equal(received.length, 1);
    assert.equal((received[0] as { event: string }).event, "grant.requested");
  } finally {
    webhookServer.close();
  }
});
