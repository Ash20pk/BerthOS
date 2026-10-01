import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berthos/manifest-schema";
import { egressAllowList, vmUnsupported } from "./support.js";

const m = (extra: Partial<BerthManifest> & Record<string, unknown>) => ({ name: "a", version: "1", capabilities: [], exports: [], ...extra }) as unknown as BerthManifest;

test("filesystem-only node apps run in the VM; network, browser, python, secrets and /context don't yet", () => {
  assert.deepEqual(vmUnsupported(m({ capabilities: ["filesystem:write:/workspace", "filesystem:read:/app"] })), []);
  const r = vmUnsupported(
    m({ runtime: "python", secrets: ["API_KEY"], capabilities: ["network:connect:443", "browser:navigate:*", "terminal:attach:*", "filesystem:read:/context", "github:read:*"] }),
  );
  assert.equal(r.length, 7);
  assert.match(r.join("\n"), /python.*secrets.*network:connect:443.*browser.*terminal.*\/context.*github:read/s);
});

test("with a berth-vmm that has the egress dialer, network:host and network:connect run; the allowlist is the declared scopes", () => {
  const app = m({ capabilities: ["network:host:api.example.com", "network:host:*.example.org:8443", "network:connect:8090", "filesystem:write:/workspace"] });
  assert.equal(vmUnsupported(app).length, 3);
  assert.deepEqual(vmUnsupported(app, { egress: true }), []);
  assert.equal(vmUnsupported(m({ capabilities: ["network:bind:8080"] }), { egress: true }).length, 1);
  assert.deepEqual(egressAllowList([app, m({ capabilities: ["browser:navigate:*.github.com", "network:host:api.example.com"] })]), [
    "api.example.com",
    "*.example.org:8443",
    "*.github.com",
  ]);
});
