import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berthos/manifest-schema";
import { vmUnsupported } from "./support.js";

const m = (extra: Partial<BerthManifest> & Record<string, unknown>) => ({ name: "a", version: "1", capabilities: [], exports: [], ...extra }) as unknown as BerthManifest;

test("filesystem-only node apps run in the VM; network, browser, python, secrets and /context don't yet", () => {
  assert.deepEqual(vmUnsupported(m({ capabilities: ["filesystem:write:/workspace", "filesystem:read:/app"] })), []);
  const r = vmUnsupported(
    m({ runtime: "python", secrets: ["API_KEY"], capabilities: ["network:connect:443", "browser:navigate:*", "terminal:attach:*", "filesystem:read:/context", "github:read:*"] }),
  );
  assert.equal(r.length, 7);
  assert.match(r.join("\n"), /python.*secrets.*network:connect:443.*browser.*terminal.*\/context.*github:read/s);
});
