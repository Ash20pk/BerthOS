import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrantsServer } from "@berth/grants-server";
import { applyHumanApprovalGate, HumanApprovalDeniedError } from "./approval.js";
import type { Tool } from "./types.js";

function fakeTool(name: string, invoke: Tool["invoke"] = async () => "ok"): Tool {
  return { name, description: "", inputSchema: {}, invoke };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pinned rather than read back from `<dataDir>/operator.token`, so a test
 * that forgot to send it fails as a 401 here rather than by minting its own
 * copy of whatever the server happens to have persisted.
 */
const OPERATOR_TOKEN = "test-operator-token";

async function withRunningGrantsServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-grants-test-"));
  const app = await createGrantsServer({ dataDir, operatorToken: OPERATOR_TOKEN });
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    await fn(address);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Polls until exactly one pending grant exists, then decides it — standing in for a human clicking approve/deny. */
async function decideNextPendingGrant(baseUrl: string, decision: "approve" | "deny", body: Record<string, unknown> = {}): Promise<void> {
  let id: string | undefined;
  while (!id) {
    const res = await fetch(`${baseUrl}/grants?status=pending`);
    const pending = (await res.json()) as { id: string }[];
    if (pending.length > 0) id = pending[0]!.id;
    else await sleep(10);
  }
  const res = await fetch(`${baseUrl}/grants/${id}/${decision}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR_TOKEN}` },
    body: JSON.stringify({ decidedBy: "tester", ...body }),
  });
  assert.equal(res.status, 200, await res.text());
}

test("a gated tool call blocks until a human approves it, then runs the real invoke", async () => {
  await withRunningGrantsServer(async (baseUrl) => {
    const [gated] = applyHumanApprovalGate([fakeTool("delete_file", async () => "deleted")], {
      grantsServerUrl: baseUrl,
      requesterName: "agent-1",
      pollIntervalMs: 20,
    });

    const [result] = await Promise.all([gated!.invoke({ path: "/tmp/x" }), decideNextPendingGrant(baseUrl, "approve")]);

    assert.equal(result, "deleted");
  });
});

test("a gated tool call throws HumanApprovalDeniedError, carrying the reason, when a human denies it", async () => {
  await withRunningGrantsServer(async (baseUrl) => {
    const [gated] = applyHumanApprovalGate([fakeTool("delete_file")], {
      grantsServerUrl: baseUrl,
      requesterName: "agent-1",
      pollIntervalMs: 20,
    });

    const [caught] = await Promise.all([
      gated!.invoke({ path: "/tmp/x" }).catch((err: unknown) => err as HumanApprovalDeniedError),
      decideNextPendingGrant(baseUrl, "deny", { reason: "too risky" }),
    ]);

    assert.ok(caught instanceof HumanApprovalDeniedError);
    assert.equal(caught.reason, "too risky");
    assert.equal(caught.toolName, "delete_file");
  });
});

test("a gated tool call that never gets a decision times out and throws HumanApprovalDeniedError", async () => {
  await withRunningGrantsServer(async (baseUrl) => {
    const [gated] = applyHumanApprovalGate([fakeTool("delete_file")], {
      grantsServerUrl: baseUrl,
      requesterName: "agent-1",
      pollIntervalMs: 10,
      timeoutMs: 50,
    });

    await assert.rejects(() => gated!.invoke({}), /timed out/);
  });
});

test("only gates the tool names listed in `only`; every other tool runs immediately with no grant requested", async () => {
  await withRunningGrantsServer(async (baseUrl) => {
    const [safe, risky] = applyHumanApprovalGate([fakeTool("read_file", async () => "contents"), fakeTool("delete_file")], {
      grantsServerUrl: baseUrl,
      requesterName: "agent-1",
      only: ["delete_file"],
    });

    const result = await safe!.invoke({ path: "/tmp/x" });
    assert.equal(result, "contents");

    const listRes = await fetch(`${baseUrl}/grants`);
    assert.deepEqual(await listRes.json(), [], "the ungated tool never created a grant");

    void risky; // exercised by the other tests
  });
});

test("requests a grant with capability agent-action:<toolName> and the tool input as the reason", async () => {
  await withRunningGrantsServer(async (baseUrl) => {
    const [gated] = applyHumanApprovalGate([fakeTool("delete_file")], {
      grantsServerUrl: baseUrl,
      requesterName: "agent-1",
      pollIntervalMs: 20,
    });

    const invokePromise = gated!.invoke({ path: "/tmp/x" }).catch(() => undefined);

    let grant: { appName: string; capability: string; reason: string } | undefined;
    while (!grant) {
      const res = await fetch(`${baseUrl}/grants?status=pending`);
      const pending = (await res.json()) as { appName: string; capability: string; reason: string }[];
      if (pending.length > 0) grant = pending[0];
      else await sleep(10);
    }
    assert.equal(grant.appName, "agent-1");
    assert.equal(grant.capability, "agent-action:delete_file");
    assert.equal(grant.reason, JSON.stringify({ path: "/tmp/x" }));

    await decideNextPendingGrant(baseUrl, "deny");
    await invokePromise;
  });
});
