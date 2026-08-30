import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { generateAgentServerApp } from "./network.js";
import type { ComputerAppSpec } from "./resolve-apps.js";

// The synthesized agent app is the one place in this repo where an app calls
// another app's exports directly, so it is also the only consumer of
// REMEDIATION.md 1.4's `app:invoke:` grant and of the per-caller socket path
// that carries the caller's identity. Neither is exercised by a milestone test
// without an API key (crew-networked-milestone.mjs skips without one), and
// both are pure codegen — a contract with entrypoint.sh and @berth/sdk's
// startPeerSocketServers() that would otherwise only break in a container.

function sibling(name: string, exportNames: string[]) {
  return {
    name,
    appDir: `/nonexistent/${name}`,
    manifest: {
      name,
      version: "0.1.0",
      capabilities: [],
      exports: exportNames.map((exportName) => ({ name: exportName })),
      on_install: [],
      on_agent_ready: [],
    },
  } as unknown as ComputerAppSpec;
}

const SIBLINGS = [sibling("filesystem", ["write_file", "read_file"]), sibling("code-interpreter", ["run_code"])];

async function generate() {
  return generateAgentServerApp({
    name: "agent-server",
    llm: { provider: "anthropic", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    siblingApps: SIBLINGS,
  });
}

test("the generated manifest declares app:invoke: for exactly the siblings whose exports it embeds", async () => {
  const { appDir } = await generate();
  try {
    const manifest = await loadManifest(join(appDir, "berth.yml"));
    const invokes = manifest.capabilities.filter((cap) => cap.startsWith("app:invoke:"));
    // Exactly these: a missing line is an EACCES at runtime, and an extra one
    // is a grant to an app the agent has no tool for.
    assert.deepEqual(invokes.sort(), ["app:invoke:code-interpreter", "app:invoke:filesystem"]);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test("an agent with no siblings declares no app:invoke: at all", async () => {
  const { appDir } = await generateAgentServerApp({
    name: "agent-server",
    llm: { provider: "anthropic", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    siblingApps: [],
  });
  try {
    const manifest = await loadManifest(join(appDir, "berth.yml"));
    assert.equal(
      manifest.capabilities.some((cap) => cap.startsWith("app:invoke:")),
      false,
    );
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test("the generated agent calls a sibling on its own per-caller socket, not that app's general one", async () => {
  const { appDir, name } = await generate();
  try {
    const source = await readFile(join(appDir, "dist", "index.js"), "utf-8");
    // The path is what identifies the caller to the serving app (see
    // @berth/sdk's startPeerSocketServers), so it has to carry this app's own
    // name, and it must not be the 0600 socket the host relay uses.
    assert.match(source, /\/run\/berth\/\$\{appName\}\/peers\/\$\{SELF\}\/rpc\.sock/);
    assert.match(source, new RegExp(`const SELF = ${JSON.stringify(name)}`));
    assert.doesNotMatch(source, /\/run\/berth\/\$\{appName\}\/rpc\.sock/);
    // And the pre-1.4 world-writable location must be gone entirely.
    assert.doesNotMatch(source, /\/tmp\/berth-rpc/);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});
