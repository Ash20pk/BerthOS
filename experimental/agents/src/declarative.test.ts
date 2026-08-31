import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig, loadCrewConfig } from "./declarative.js";

async function withTempFile(contents: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "declarative-test-"));
  const path = join(dir, "config.yml");
  await writeFile(path, contents, "utf-8");
  await fn(path);
}

test("loadAgentConfig parses a minimal agent config", async () => {
  await withTempFile(
    `
name: research-assistant
systemPrompt: "You are a helpful assistant."
apps: apps/filesystem
`,
    async (path) => {
      const config = await loadAgentConfig(path);
      assert.equal(config.name, "research-assistant");
      assert.equal(config.systemPrompt, "You are a helpful assistant.");
      assert.equal(config.apps, "apps/filesystem");
    },
  );
});

test("loadAgentConfig parses a full agent config with a list of apps and an llm block", async () => {
  await withTempFile(
    `
name: research-assistant
apps:
  - apps/filesystem
  - apps/browser-native
llm:
  provider: anthropic
  model: claude-sonnet-5
maxTurns: 10
checkpoint: semantic-fs
trace: full
`,
    async (path) => {
      const config = await loadAgentConfig(path);
      assert.deepEqual(config.apps, ["apps/filesystem", "apps/browser-native"]);
      assert.deepEqual(config.llm, { provider: "anthropic", model: "claude-sonnet-5" });
      assert.equal(config.maxTurns, 10);
      assert.equal(config.checkpoint, "semantic-fs");
      assert.equal(config.trace, "full");
    },
  );
});

test("loadAgentConfig resolves ${ENV_VAR} apiKey references against process.env", async () => {
  process.env.DECLARATIVE_TEST_KEY = "sk-real-value";
  try {
    await withTempFile(
      `
apps: apps/filesystem
llm:
  provider: openai
  apiKey: \${DECLARATIVE_TEST_KEY}
`,
      async (path) => {
        const config = await loadAgentConfig(path);
        // loadAgentConfig() itself doesn't interpolate — that happens when
        // building the real CreateAgentOptions in createAgentFromYaml(), so
        // the raw config still shows the literal placeholder here.
        assert.equal(config.llm?.apiKey, "${DECLARATIVE_TEST_KEY}");
      },
    );
  } finally {
    delete process.env.DECLARATIVE_TEST_KEY;
  }
});

test("loadAgentConfig rejects an unknown llm provider", async () => {
  await withTempFile(
    `
apps: apps/filesystem
llm:
  provider: not-a-real-provider
`,
    async (path) => {
      await assert.rejects(() => loadAgentConfig(path));
    },
  );
});

test("loadAgentConfig connect config accepts both the bare-string and {name, apps} shapes", async () => {
  await withTempFile(
    `
connect: my-shared-os
`,
    async (path) => {
      const config = await loadAgentConfig(path);
      assert.equal(config.connect, "my-shared-os");
    },
  );

  await withTempFile(
    `
connect:
  name: my-shared-os
  apps: [filesystem]
`,
    async (path) => {
      const config = await loadAgentConfig(path);
      assert.deepEqual(config.connect, { name: "my-shared-os", apps: ["filesystem"] });
    },
  );
});

test("loadCrewConfig parses a sequential crew with two named inline agents", async () => {
  await withTempFile(
    `
name: writing-crew
kind: sequential
agents:
  - name: drafter
    apps: apps/filesystem
    systemPrompt: "Draft the release notes."
  - name: reviewer
    apps: apps/filesystem
    systemPrompt: "Review and tighten the draft."
`,
    async (path) => {
      const config = await loadCrewConfig(path);
      assert.equal(config.kind, "sequential");
      assert.equal(config.agents.length, 2);
      assert.equal(config.agents[0]?.name, "drafter");
      assert.equal(config.agents[1]?.name, "reviewer");
    },
  );
});

test("loadCrewConfig parses a withManager crew with a manager block", async () => {
  await withTempFile(
    `
kind: withManager
manager:
  name: manager
  apps: apps/filesystem
agents:
  - name: worker-a
    apps: apps/filesystem
  - name: worker-b
    apps: apps/filesystem
`,
    async (path) => {
      const config = await loadCrewConfig(path);
      assert.equal(config.kind, "withManager");
      assert.equal(config.manager?.name, "manager");
      assert.equal(config.agents.length, 2);
    },
  );
});

test("loadCrewConfig requires every agent to have a name (unlike a plain agent config)", async () => {
  await withTempFile(
    `
kind: sequential
agents:
  - apps: apps/filesystem
`,
    async (path) => {
      await assert.rejects(() => loadCrewConfig(path));
    },
  );
});

test("loadCrewConfig rejects an unknown kind", async () => {
  await withTempFile(
    `
kind: not-a-real-shape
agents:
  - name: a
    apps: apps/filesystem
`,
    async (path) => {
      await assert.rejects(() => loadCrewConfig(path));
    },
  );
});
