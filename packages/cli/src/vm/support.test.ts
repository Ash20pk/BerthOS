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
  assert.deepEqual(vmUnsupported(app, { egress: true, secrets: false, python: false, semanticFs: false }), []);
  assert.equal(vmUnsupported(m({ capabilities: ["network:bind:8080"] }), { egress: true, secrets: false, python: false, semanticFs: false }).length, 1);
  assert.deepEqual(egressAllowList([app, m({ capabilities: ["browser:navigate:*.github.com", "network:host:api.example.com"] })]), [
    "api.example.com",
    "*.example.org:8443",
    "*.github.com",
  ]);
});

test("with a berth-vmm that takes a secrets disk, an app declaring secrets runs", () => {
  const app = m({ secrets: ["GITHUB_TOKEN"], capabilities: ["filesystem:write:/workspace"] });
  assert.match(vmUnsupported(app, { egress: true, secrets: false, python: false, semanticFs: false }).join(), /secrets: GITHUB_TOKEN.*berth vm install/);
  assert.deepEqual(vmUnsupported(app, { egress: false, secrets: true, python: false, semanticFs: false }), []);
});

test("with a berth-vmm whose image has python3, a runtime: python app runs", () => {
  const app = m({ runtime: "python", capabilities: ["filesystem:write:/workspace"] });
  assert.match(vmUnsupported(app).join(), /runtime: python.*berth vm install/);
  assert.deepEqual(vmUnsupported(app, { egress: false, secrets: false, python: true, semanticFs: false }), []);
});

test("with a berth-vmm whose image has semantic-fs, an app declaring /context runs", () => {
  const app = m({ capabilities: ["filesystem:read:/context", "filesystem:write:/context", "filesystem:write:/workspace"] });
  const without = vmUnsupported(app);
  assert.equal(without.length, 2);
  assert.match(without.join(), /no semantic-fs.*berth vm install/);
  assert.deepEqual(vmUnsupported(app, { egress: false, secrets: false, python: false, semanticFs: true }), []);
  assert.equal(vmUnsupported(m({ capabilities: ["filesystem:read:/contextual"] })).length, 0, "only /context and below");
});
