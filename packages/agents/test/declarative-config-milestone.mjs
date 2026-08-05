#!/usr/bin/env node
// Real, running verification of gap #23's closure: createAgentFromYaml()
// parses a real YAML file and boots a real Computer from it — not just
// that the YAML parses (already covered by declarative.test.ts's 9 unit
// tests, no Docker needed there). A fake Anthropic API key is enough:
// createAgent() constructs an LLMProvider client eagerly but never talks to
// the network unless agent.run() is called, and this test only needs to
// prove the Docker-boot wiring is correct, not make a real (paid) LLM call.
//
// createAgentFromYaml() always goes through createAgent()'s own apps path,
// which always builds a production-target image (BERTH_REQUIRE_ENFORCEMENT=1)
// — same as computer-boot-milestone.mjs, this only completes a real tool
// call on a kernel that can actually enforce Landlock (CI's ubuntu-latest).
// On Docker Desktop for Mac/Windows, agent-init refuses to exec under an
// unenforced ruleset, so the container's own runtime never comes up and the
// first real RPC call (write_file) times out — the tool *list* still builds
// correctly even there, since that comes from static manifest resolution,
// not a live call, which is as far as this test gets on this class of dev
// machine. CI-verified only, not locally runnable here.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentFromYaml } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  process.env.ANTHROPIC_API_KEY ??= "sk-ant-fake-for-declarative-config-milestone";

  const dir = await mkdtemp(join(tmpdir(), "declarative-config-milestone-"));
  const configPath = join(dir, "research-assistant.yml");
  await writeFile(
    configPath,
    [
      "name: research-assistant",
      "systemPrompt: \"You are a helpful assistant with access to a real sandboxed filesystem.\"",
      `apps: ${FILESYSTEM_APP_DIR}`,
      "llm:",
      "  provider: anthropic",
    ].join("\n"),
  );

  console.log(`Loading Agent from ${configPath}...`);
  const { agent, computer, config } = await createAgentFromYaml(configPath);

  try {
    assert(agent.name === "research-assistant", `expected agent.name "research-assistant", got: ${agent.name}`);
    assert(config.name === "research-assistant", `expected config.name to round-trip, got: ${JSON.stringify(config)}`);

    const toolNames = computer.tools.map((t) => t.name).sort();
    console.log("tools:", toolNames);
    assert(toolNames.includes("write_file"), `expected an unnamespaced "write_file" tool, got: ${JSON.stringify(toolNames)}`);
    assert(toolNames.includes("read_file"), `expected an unnamespaced "read_file" tool, got: ${JSON.stringify(toolNames)}`);

    console.log("Calling write_file through the Computer the YAML config actually booted...");
    await computer.call("write_file", { path: "declarative-config-test.txt", content: "hello from a yaml-declared agent" });
    const result = await computer.call("read_file", { path: "declarative-config-test.txt" });
    assert(
      result.content === "hello from a yaml-declared agent",
      `expected round-tripped content, got: ${JSON.stringify(result)}`,
    );

    console.log("\nPASS — createAgentFromYaml() parsed a real YAML file and booted a real, correctly-wired Computer.");
  } finally {
    await computer.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nDECLARATIVE CONFIG MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
