#!/usr/bin/env node
// Real, running verification of Crew.networked(): two independently booted
// agent-computers (each its own container, each running its own
// in-container agent loop via a synthesized agent-server app, joined to a
// shared Docker network) are reachable as Tools by a host-side manager
// agent. Requires ANTHROPIC_API_KEY — skips (not fails) if absent.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, Crew, createAnthropicProvider, bootNetworkedAgent } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const HELLO_WORLD_APP_DIR = join(REPO_ROOT, "examples", "hello-world");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("SKIP — set ANTHROPIC_API_KEY to run this milestone test.");
    return;
  }

  const apiKeyEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  console.log("Booting peer A (filesystem tools) as a networked agent...");
  const peerA = await bootNetworkedAgent({
    name: "peer-a",
    apps: [FILESYSTEM_APP_DIR],
    llm: { provider: "anthropic", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    systemPrompt: "You write files when asked, using your write_file tool.",
    env: apiKeyEnv,
  });

  console.log("Booting peer B (hello-world's ping) as a networked agent...");
  const peerB = await bootNetworkedAgent({
    name: "peer-b",
    apps: [HELLO_WORLD_APP_DIR],
    llm: { provider: "anthropic", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    systemPrompt: "You respond to pings, using your ping tool, and report back exactly what it returns.",
    env: apiKeyEnv,
  });

  try {
    console.log("peer containers:", peerA.computer.containerName, peerB.computer.containerName);

    const manager = new Agent({
      name: "manager",
      systemPrompt: "You coordinate two independent networked agents, peer-a and peer-b, delegating tasks to whichever is relevant.",
      llm: createAnthropicProvider(),
      tools: [],
    });

    const crew = Crew.networked({ manager, peers: [peerA, peerB] });

    const output = await crew.run(
      'Ask peer-a to write a file named "networked-crew-test.txt" containing exactly "networked", and separately ask peer-b to ping and report back exactly what it said.',
    );

    console.log("crew output:", output);
    assert(/pong/i.test(output), `expected the crew's answer to include peer-b's real ping response, got: ${output}`);

    console.log(
      "\nPASS — two independently networked agent-computers, each running their own in-container agent loop, both completed real delegated tasks.",
    );
  } finally {
    await peerA.stop();
    await peerB.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCREW NETWORKED MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
