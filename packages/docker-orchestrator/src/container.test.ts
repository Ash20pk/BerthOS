import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import { BerthManifestSchema } from "@berthos/manifest-schema";
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
 * `Env` on createContainer is permanent, inspectable
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
  runtime?: string;
  extraSecurityOpt?: string[];
  /** Use the /context posture the process env already selects, even none. */
  postureFromEnv?: boolean;
}): Promise<Docker.ContainerCreateOptions> {
  // The enforcement banner runs a real probe container against the real
  // daemon, which has nothing to do with what's under test here.
  process.env.BERTH_NO_ENFORCEMENT_BANNER = "1";
  // The fake daemon can't run a sidecar, and a failed sidecar now turns
  // /context off. Tests that don't pick a /context posture get the in-sandbox
  // one by asking for it — the same HostConfig they saw before that change.
  const choosePosture =
    !options.postureFromEnv &&
    process.env.BERTH_NO_SEMANTIC_FS === undefined &&
    process.env.BERTH_DISABLE_FS_SIDECAR === undefined;
  if (choosePosture) process.env.BERTH_DISABLE_FS_SIDECAR = "1";
  const captured: { create?: Docker.ContainerCreateOptions } = {};
  try {
    await startContainer({
      image: "berth/test:dev",
      name: options.name,
      manifest: manifest(["filesystem:write:/workspace"]),
      env: options.env,
      httpRpc: options.httpRpc,
      secretsRunDir: options.secretsRunDir,
      runtime: options.runtime,
      extraSecurityOpt: options.extraSecurityOpt,
      docker: fakeDocker(captured),
    });
  } finally {
    if (choosePosture) delete process.env.BERTH_DISABLE_FS_SIDECAR;
  }
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

/**
 * The hardened-runtime opt-in is a passthrough to Docker's
 * HostConfig.Runtime — observable only in what createContainer is sent. The
 * empty-string case matters for the same reason BERTH_PUBLISH_HOST's does: a
 * stray `BERTH_RUNTIME=` in a .env must not select a runtime named "".
 */
test("startContainer passes runtime through to HostConfig.Runtime, and omits it entirely when unset", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-container-runtime-"));
  const withRuntime = await startWithFakeDocker({ name: "berth-test-runtime", secretsRunDir: runDir, runtime: "runsc" });
  assert.equal(withRuntime.HostConfig?.Runtime, "runsc");

  const without = await startWithFakeDocker({ name: "berth-test-no-runtime", secretsRunDir: runDir });
  assert.ok(!("Runtime" in (without.HostConfig ?? {})), "no runtime requested must mean no Runtime key at all — the daemon default, not an empty string");
});

test("BERTH_RUNTIME selects the runtime when the caller passes none, and empty means unset", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-container-runtime-env-"));
  process.env.BERTH_RUNTIME = "runsc";
  try {
    const created = await startWithFakeDocker({ name: "berth-test-runtime-env", secretsRunDir: runDir });
    assert.equal(created.HostConfig?.Runtime, "runsc");
  } finally {
    process.env.BERTH_RUNTIME = "";
  }
  const created = await startWithFakeDocker({ name: "berth-test-runtime-env-empty", secretsRunDir: runDir });
  assert.ok(!("Runtime" in (created.HostConfig ?? {})));
  delete process.env.BERTH_RUNTIME;
});

/**
 * ExtraSecurityOpt is appended to the computed SecurityOpt
 * entries — how attestation-milestone.mjs's control boot pins a seccomp
 * profile that ENOSYSes the landlock syscalls.
 */
test("startContainer appends extraSecurityOpt to HostConfig.SecurityOpt", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-container-secopt-"));
  const created = await startWithFakeDocker({
    name: "berth-test-secopt",
    secretsRunDir: runDir,
    extraSecurityOpt: ["seccomp={\"defaultAction\":\"SCMP_ACT_ALLOW\"}"],
  });
  assert.ok((created.HostConfig?.SecurityOpt ?? []).some((o: string) => o.startsWith("seccomp=")));

  const without = await startWithFakeDocker({ name: "berth-test-no-secopt", secretsRunDir: runDir });
  assert.ok(!(without.HostConfig?.SecurityOpt ?? []).some((o: string) => o.startsWith("seccomp=")));
});

/**
 * Three postures for /context, not two. Before BERTH_NO_SEMANTIC_FS existed,
 * BERTH_DISABLE_FS_SIDECAR=1 was the only way to opt out of the sidecar — and
 * it does not mean "no semantic FS", it means "mount it in this container
 * instead", which puts CAP_SYS_ADMIN and /dev/fuse back. So a boot that would
 * never touch /context still paid for one of the two, and there was no way to
 * ask for neither.
 *
 * These run without a reachable sidecar (the fake daemon can't propagate a
 * FUSE mount), which is the failure the default posture must degrade to
 * "off" rather than paper over with the in-sandbox mount. Only DISABLE_FS_SIDECAR reaches
 * that mount, and it is exactly the branch that must NOT be reached when
 * semantic FS is off.
 */
async function hostConfigWithEnv(name: string, env: Record<string, string | undefined>) {
  const runDir = await mkdtemp(join(tmpdir(), "berth-container-semfs-"));
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await startWithFakeDocker({ name, secretsRunDir: runDir, postureFromEnv: true });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("BERTH_NO_SEMANTIC_FS=1 grants no SYS_ADMIN and no /dev/fuse anywhere", async () => {
  const created = await hostConfigWithEnv("berth-test-no-semfs", {
    BERTH_NO_SEMANTIC_FS: "1",
    BERTH_DISABLE_FS_SIDECAR: undefined,
  });
  assert.ok(
    !(created.HostConfig?.CapAdd ?? []).includes("SYS_ADMIN"),
    `a boot that asked for no semantic FS must not be granted SYS_ADMIN, got: ${JSON.stringify(created.HostConfig?.CapAdd)}`,
  );
  assert.ok(
    !(created.HostConfig?.Devices ?? []).some((d: { PathOnHost: string }) => d.PathOnHost === "/dev/fuse"),
    "no FUSE mount is attempted, so /dev/fuse must not be handed in",
  );
});

test("BERTH_NO_SEMANTIC_FS=1 tells the entrypoint too, so it waits on no mount", async () => {
  const created = await hostConfigWithEnv("berth-test-no-semfs-env", {
    BERTH_NO_SEMANTIC_FS: "1",
    BERTH_DISABLE_FS_SIDECAR: undefined,
  });
  assert.ok(
    (created.Env ?? []).includes("BERTH_NO_SEMANTIC_FS=1"),
    `the container needs this to skip its own daemon and its 5s /proc/mounts poll, got: ${JSON.stringify(created.Env)}`,
  );
});

test("without BERTH_NO_SEMANTIC_FS, the in-sandbox fallback still takes SYS_ADMIN — the posture being opted out of", async () => {
  const created = await hostConfigWithEnv("berth-test-semfs-fallback", {
    BERTH_NO_SEMANTIC_FS: undefined,
    BERTH_DISABLE_FS_SIDECAR: "1",
  });
  assert.ok(
    (created.HostConfig?.CapAdd ?? []).includes("SYS_ADMIN"),
    "this is the pre-M1.1 posture and must stay reachable — sys-admin-drop-milestone.mjs uses it as its negative control",
  );
  assert.ok(!(created.Env ?? []).includes("BERTH_NO_SEMANTIC_FS=1"));
});

test("a failed sidecar boots without /context instead of handing SYS_ADMIN to the sandbox", async () => {
  const created = await hostConfigWithEnv("berth-test-semfs-degrade", {
    BERTH_NO_SEMANTIC_FS: undefined,
    BERTH_DISABLE_FS_SIDECAR: undefined,
  });
  assert.ok(
    !(created.HostConfig?.CapAdd ?? []).includes("SYS_ADMIN"),
    `a sidecar failure the caller never asked about must not raise privilege, got: ${JSON.stringify(created.HostConfig?.CapAdd)}`,
  );
  assert.ok(
    !(created.HostConfig?.Devices ?? []).some((d: { PathOnHost: string }) => d.PathOnHost === "/dev/fuse"),
    "no in-sandbox mount is attempted, so /dev/fuse must not be handed in",
  );
  assert.ok(
    !(created.HostConfig?.SecurityOpt ?? []).some((o: string) => o.includes("apparmor:unconfined")),
    "the AppArmor exception belongs to the in-sandbox mount only",
  );
  assert.ok(
    (created.Env ?? []).includes("BERTH_NO_SEMANTIC_FS=1"),
    `the entrypoint must be told /context is off, or it waits on a mount nobody makes, got: ${JSON.stringify(created.Env)}`,
  );
});
