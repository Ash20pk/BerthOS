import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeshCoordinatorServer } from "./index.js";

async function withServer(fn: (app: Awaited<ReturnType<typeof createMeshCoordinatorServer>>) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-mesh-coordinator-test-"));
  const app = await createMeshCoordinatorServer({ dataDir, now: () => "2026-01-01T00:00:00.000Z" });
  try {
    await fn(app);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function register(
  app: Awaited<ReturnType<typeof createMeshCoordinatorServer>>,
  body: { name: string; publicKey: string; endpointHost: string; endpointPort: number; meshPeerPatterns?: string[] },
  token?: string,
) {
  return app.inject({
    method: "POST",
    url: "/peers",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });
}

test("first registration mints a token and allocates a stable CGNAT mesh IP", async () => {
  await withServer(async (app) => {
    const res = await register(app, { name: "planner", publicKey: "pk-a", endpointHost: "10.0.0.1", endpointPort: 51820 });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.meshIp, "100.64.0.2");
    assert.equal(typeof body.ownerToken, "string");
    assert.deepEqual(body.peers, []);
  });
});

test("re-registration without the owner token is rejected, with the token it's accepted", async () => {
  await withServer(async (app) => {
    const first = await register(app, { name: "planner", publicKey: "pk-a", endpointHost: "10.0.0.1", endpointPort: 51820 });
    const { ownerToken } = JSON.parse(first.body);

    const hijack = await register(app, { name: "planner", publicKey: "attacker-key", endpointHost: "6.6.6.6", endpointPort: 1 });
    assert.equal(hijack.statusCode, 401);

    const legit = await register(
      app,
      { name: "planner", publicKey: "pk-a-rotated", endpointHost: "10.0.0.2", endpointPort: 51820 },
      ownerToken,
    );
    assert.equal(legit.statusCode, 200);
    assert.equal(JSON.parse(legit.body).meshIp, "100.64.0.2");
  });
});

test("two peers with mutually-matching patterns are introduced to each other", async () => {
  await withServer(async (app) => {
    await register(app, {
      name: "planner",
      publicKey: "pk-planner",
      endpointHost: "10.0.0.1",
      endpointPort: 51820,
      meshPeerPatterns: ["browser"],
    });
    const browserRes = await register(app, {
      name: "browser",
      publicKey: "pk-browser",
      endpointHost: "10.0.0.2",
      endpointPort: 51820,
      meshPeerPatterns: ["planner"],
    });
    const browserBody = JSON.parse(browserRes.body);
    assert.equal(browserBody.peers.length, 1);
    assert.equal(browserBody.peers[0].name, "planner");
    assert.equal(browserBody.peers[0].meshIp, "100.64.0.2");
  });
});

test("a one-directional match is NOT introduced (mutual consent required)", async () => {
  await withServer(async (app) => {
    // planner declares network:peer:browser, but browser never declares planner back.
    const planner = JSON.parse(
      (
        await register(app, {
          name: "planner",
          publicKey: "pk-planner",
          endpointHost: "10.0.0.1",
          endpointPort: 51820,
          meshPeerPatterns: ["browser"],
        })
      ).body,
    );
    const browserRes = await register(app, {
      name: "browser",
      publicKey: "pk-browser",
      endpointHost: "10.0.0.2",
      endpointPort: 51820,
      meshPeerPatterns: ["someone-else"],
    });
    assert.deepEqual(JSON.parse(browserRes.body).peers, []);

    const plannerAgain = await register(
      app,
      {
        name: "planner",
        publicKey: "pk-planner",
        endpointHost: "10.0.0.1",
        endpointPort: 51820,
        meshPeerPatterns: ["browser"],
      },
      planner.ownerToken,
    );
    assert.deepEqual(JSON.parse(plannerAgain.body).peers, [], "planner also shouldn't see browser without mutual consent");
  });
});

test("a third, non-matching peer never appears in either party's roster", async () => {
  await withServer(async (app) => {
    const planner = JSON.parse(
      (await register(app, { name: "planner", publicKey: "pk-a", endpointHost: "h1", endpointPort: 1, meshPeerPatterns: ["browser"] })).body,
    );
    await register(app, { name: "browser", publicKey: "pk-b", endpointHost: "h2", endpointPort: 2, meshPeerPatterns: ["planner"] });
    // intruder wildcards *everyone*, but nobody named "intruder" back.
    await register(app, { name: "intruder", publicKey: "pk-c", endpointHost: "h3", endpointPort: 3, meshPeerPatterns: ["*"] });

    const plannerAgain = JSON.parse(
      (
        await register(
          app,
          { name: "planner", publicKey: "pk-a", endpointHost: "h1", endpointPort: 1, meshPeerPatterns: ["browser"] },
          planner.ownerToken,
        )
      ).body,
    );
    const names = plannerAgain.peers.map((p: { name: string }) => p.name);
    assert.ok(!names.includes("intruder"), "intruder declared * but planner never named it back — must not appear");
  });
});

test("GET /peers requires the owner token and returns the same mutual roster", async () => {
  await withServer(async (app) => {
    const a = JSON.parse(
      (await register(app, { name: "a", publicKey: "pk-a", endpointHost: "h1", endpointPort: 1, meshPeerPatterns: ["b"] })).body,
    );
    await register(app, { name: "b", publicKey: "pk-b", endpointHost: "h2", endpointPort: 2, meshPeerPatterns: ["a"] });

    const unauthed = await app.inject({ method: "GET", url: "/peers?name=a" });
    assert.equal(unauthed.statusCode, 401);

    const authed = await app.inject({
      method: "GET",
      url: "/peers?name=a",
      headers: { authorization: `Bearer ${a.ownerToken}` },
    });
    assert.equal(authed.statusCode, 200);
    assert.equal(JSON.parse(authed.body).peers[0].name, "b");
  });
});

test("DELETE /peers/:name removes a peer, requiring its token", async () => {
  await withServer(async (app) => {
    const a = JSON.parse(
      (await register(app, { name: "a", publicKey: "pk-a", endpointHost: "h1", endpointPort: 1 })).body,
    );

    const wrongToken = await app.inject({ method: "DELETE", url: "/peers/a", headers: { authorization: "Bearer nope" } });
    assert.equal(wrongToken.statusCode, 401);

    const ok = await app.inject({ method: "DELETE", url: "/peers/a", headers: { authorization: `Bearer ${a.ownerToken}` } });
    assert.equal(ok.statusCode, 204);

    const reregister = await register(app, { name: "a", publicKey: "pk-a2", endpointHost: "h1", endpointPort: 1 });
    assert.equal(reregister.statusCode, 201, "name should be free again after delete, minting a fresh token");
  });
});
