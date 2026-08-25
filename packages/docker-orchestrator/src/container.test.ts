import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import { BerthManifestSchema } from "@berth/manifest-schema";
import {
  declaresBrowserCapability,
  declaresTerminalCapability,
  needsBrowserPorts,
  needsTerminalPort,
  maxResources,
  startContainer,
} from "./container.js";
import { CONTAINER_SECRETS_PATH, containerSecretsDir } from "./secrets.js";

function manifest(capabilities: string[], expose?: { browser?: boolean; terminal?: boolean }) {
  return BerthManifestSchema.parse({ name: "app", version: "1.0.0", capabilities, expose });
}

function manifestWithResources(resources: { cpu?: number; memory_mb?: number; gpu?: number }) {
  return BerthManifestSchema.parse({ name: "app", version: "1.0.0", resources });
}

test("needsBrowserPorts is true when browser:* is declared and expose.browser defaults true", () => {
  const m = manifest(["browser:navigate:*.github.com"]);
  assert.equal(declaresBrowserCapability(m), true);
  assert.equal(needsBrowserPorts(m), true);
});

test("needsBrowserPorts is false when expose.browser is explicitly disabled", () => {
  const m = manifest(["browser:navigate:*.github.com"], { browser: false });
  assert.equal(declaresBrowserCapability(m), true);
  assert.equal(needsBrowserPorts(m), false);
});

test("needsBrowserPorts is false when no browser:* capability is declared, regardless of expose", () => {
  const m = manifest(["filesystem:write:/workspace"], { browser: true });
  assert.equal(declaresBrowserCapability(m), false);
  assert.equal(needsBrowserPorts(m), false);
});

test("needsTerminalPort follows the same rule as needsBrowserPorts", () => {
  const exposed = manifest(["terminal:attach:*"]);
  const hidden = manifest(["terminal:attach:*"], { terminal: false });
  assert.equal(needsTerminalPort(exposed), true);
  assert.equal(needsTerminalPort(hidden), false);
  assert.equal(declaresTerminalCapability(hidden), true);
});

test("maxResources returns nothing declared when no manifest sets resources", () => {
  assert.deepEqual(maxResources([manifestWithResources({})]), {});
});

test("maxResources passes through a single app's declared limits", () => {
  assert.deepEqual(maxResources([manifestWithResources({ cpu: 1, memory_mb: 512, gpu: 1 })]), {
    cpu: 1,
    memoryMb: 512,
    gpu: 1,
  });
});

test("maxResources takes the max across companion apps sharing one container, per field independently", () => {
  const primary = manifestWithResources({ cpu: 0.5, memory_mb: 256 });
  const companion = manifestWithResources({ cpu: 2, gpu: 1 });
  assert.deepEqual(maxResources([primary, companion]), { cpu: 2, memoryMb: 256, gpu: 1 });
});

/**
 * REMEDIATION.md 5.5. `Env` on createContainer is permanent, inspectable
 * container configuration — a bearer token or a provider API key put there is
 * readable by anything that can talk to the Docker socket for the life of the
 * container, and is copied verbatim into every commit and snapshot of it.
 * These tests drive the real startContainer() against a fake Docker and assert
 * on what it *would* have sent, which is the only place the distinction is
 * observable without a daemon.
 */
function fakeDocker(captured: { create?: Docker.ContainerCreateOptions }): Docker {
  return {
    createContainer: async (opts: Docker.ContainerCreateOptions) => {
      captured.create = opts;
      return {
        start: async () => {},
        inspect: async () => ({ NetworkSettings: { Ports: { "7300/tcp": [{ HostPort: "49999" }] } } }),
      };
    },
  } as unknown as Docker;
}

async function startWithFakeDocker(options: {
  name: string;
  env?: Record<string, string>;
  httpRpc?: { authToken: string };
  secretsRunDir: string;
}): Promise<Docker.ContainerCreateOptions> {
  // The enforcement banner runs a real probe container against the real
  // daemon, which has nothing to do with what's under test here.
  process.env.BERTH_NO_ENFORCEMENT_BANNER = "1";
  const captured: { create?: Docker.ContainerCreateOptions } = {};
  await startContainer({
    image: "berth/test:dev",
    name: options.name,
    manifest: manifest(["filesystem:write:/workspace"]),
    env: options.env,
    httpRpc: options.httpRpc,
    secretsRunDir: options.secretsRunDir,
    docker: fakeDocker(captured),
  });
  assert.ok(captured.create, "startContainer never called createContainer");
  return captured.create;
}

test("startContainer keeps credential-valued env out of Env, and delivers it through a 0600 bind-mounted file instead", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-container-secrets-"));
  const created = await startWithFakeDocker({
    name: "berth-test-secrets",
    env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace", ANTHROPIC_API_KEY: "sk-ant-should-never-be-inspectable" },
    httpRpc: { authToken: "rpc-token-should-never-be-inspectable" },
    secretsRunDir: runDir,
  });

  const envEntries = created.Env ?? [];
  const envBlob = envEntries.join("\n");
  assert.ok(!envBlob.includes("sk-ant-should-never-be-inspectable"), `provider key leaked into Env: ${envBlob}`);
  assert.ok(!envBlob.includes("rpc-token-should-never-be-inspectable"), `RPC token leaked into Env: ${envBlob}`);
  assert.ok(!envEntries.some((e) => e.startsWith("ANTHROPIC_API_KEY=")), "ANTHROPIC_API_KEY must not appear in Env at all");
  assert.ok(!envEntries.some((e) => e.startsWith("BERTH_HTTP_RPC_TOKEN=")), "BERTH_HTTP_RPC_TOKEN must not appear in Env at all");

  // Non-secret configuration is untouched — including the two BERTH_HTTP_RPC_*
  // values that aren't credentials, since the bridge is useless without them.
  assert.ok(envEntries.includes("BERTH_WORKSPACE_ROOT=/workspace/.berth/dev-workspace"));
  assert.ok(envEntries.includes("BERTH_HTTP_RPC_PORT=7300"));
  assert.ok(envEntries.includes(`BERTH_SECRETS_FILE=${CONTAINER_SECRETS_PATH}`));

  const secretsHostPath = join(containerSecretsDir("berth-test-secrets", runDir), "secrets.env");
  assert.ok(
    (created.HostConfig?.Binds ?? []).includes(`${secretsHostPath}:${CONTAINER_SECRETS_PATH}:ro`),
    `expected a read-only secrets mount, got: ${JSON.stringify(created.HostConfig?.Binds)}`,
  );
  assert.equal((await stat(secretsHostPath)).mode & 0o777, 0o600);
  const fileContents = await readFile(secretsHostPath, "utf-8");
  assert.ok(fileContents.includes("sk-ant-should-never-be-inspectable"), "the key still has to actually reach the container");
  assert.ok(fileContents.includes("rpc-token-should-never-be-inspectable"));
});

test("startContainer mounts nothing extra for a container whose env holds no credentials", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-container-secrets-"));
  const created = await startWithFakeDocker({
    name: "berth-test-no-secrets",
    env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" },
    secretsRunDir: runDir,
  });

  assert.ok(!(created.Env ?? []).some((e) => e.startsWith("BERTH_SECRETS_FILE=")));
  assert.ok(!(created.HostConfig?.Binds ?? []).some((b) => b.includes(CONTAINER_SECRETS_PATH)));
  // The per-container run dir may exist (the semantic-fs sidecar keeps its
  // mountpoint there since M1.1) — what must not exist is any secrets
  // artifact in it.
  await assert.rejects(stat(join(containerSecretsDir("berth-test-no-secrets", runDir), "secrets.env")), "no secrets means no file on the host either");
  await assert.rejects(stat(join(containerSecretsDir("berth-test-no-secrets", runDir), "apps")), "no declared secrets means no per-app files either");
});
