#!/usr/bin/env node
// Real, running verification of REMEDIATION 5.5: a booted sandbox's
// credentials are not in `docker inspect`, are not in a `docker commit` of it,
// are not in a snapshot directory that could be copied to another machine —
// and still actually reach the process inside the container.
//
// That last clause is the whole difficulty. Asserting only that a token is
// absent from `Env` is trivially satisfiable by never delivering it at all, so
// every check here is paired with a functional one:
//
//   1. inspect the running container: no BERTH_HTTP_RPC_TOKEN, no API key, and
//      neither value present under any other name;
//   2. the host secrets file is 0600 inside a 0700 directory;
//   3. the HTTP RPC bridge accepts the bearer token — which it can only do if
//      entrypoint.sh sourced the file and @berth/sdk's server read it — and
//      still refuses a wrong one;
//   4. a real `berth snapshot create` of this container writes an env.json
//      with no credential values in it, at 0600, naming what it withheld;
//   5. `docker exec env` — a fresh process built from the container's `Config.Env`
//      rather than from entrypoint's environment — sees neither secret, which
//      is what "not baked into the container's configuration" means concretely.
//
// Uses target:"dev" for the same reason http-rpc-bridge-milestone.mjs does:
// it keeps this test about the secrets mechanism rather than about Docker
// Desktop's linuxkit kernel being unable to enforce Landlock.
import { randomBytes } from "node:crypto";
import { readFile, stat, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { loadManifest } from "@berth/manifest-schema";
import Docker from "dockerode";
import { buildImage, startContainer, stopContainer, createSnapshot, containerSecretsDir, CONTAINER_SECRETS_PATH } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const IMAGE_TAG = "berth/filesystem-secrets-milestone:dev";
const CONTAINER_NAME = "berth-secrets-milestone";

// Distinctive enough to grep for in a whole image tarball without false hits.
const FAKE_API_KEY = `sk-ant-milestone-${randomBytes(8).toString("hex")}`;

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

async function main() {
  const docker = new Docker();
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));
  const runDir = await mkdtemp(join(tmpdir(), "berth-secrets-milestone-run-"));
  const snapshotsDir = await mkdtemp(join(tmpdir(), "berth-secrets-milestone-snapshots-"));

  console.log("--- Building filesystem's dev image ---");
  await buildImage({ appDir: APP_DIR, tag: IMAGE_TAG, target: "dev", docker });

  // Leftover from an interrupted previous run — createContainer would 409.
  await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});

  const authToken = randomBytes(32).toString("hex");
  console.log("\n--- Booting a sandbox carrying an RPC token and a provider API key ---");
  const running = await startContainer({
    image: IMAGE_TAG,
    name: CONTAINER_NAME,
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    httpRpc: { authToken },
    env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace", ANTHROPIC_API_KEY: FAKE_API_KEY },
    secretsRunDir: runDir,
    docker,
  });

  try {
    const inspect = await running.container.inspect();
    const containerEnv = inspect.Config.Env ?? [];
    const envBlob = containerEnv.join("\n");

    console.log("\n--- Test 1: docker inspect shows neither credential ---");
    check("no BERTH_HTTP_RPC_TOKEN entry", !containerEnv.some((e) => e.startsWith("BERTH_HTTP_RPC_TOKEN=")));
    check("no ANTHROPIC_API_KEY entry", !containerEnv.some((e) => e.startsWith("ANTHROPIC_API_KEY=")));
    check("the RPC token's value appears nowhere in Env", !envBlob.includes(authToken));
    check("the API key's value appears nowhere in Env", !envBlob.includes(FAKE_API_KEY), "a provider API key is readable from `docker inspect`");
    check(
      "the non-secret half of the environment is untouched",
      containerEnv.includes("BERTH_HTTP_RPC_PORT=7300") && containerEnv.includes("BERTH_WORKSPACE_ROOT=/workspace/.berth/dev-workspace"),
      `env was ${JSON.stringify(containerEnv)}`,
    );
    check(
      "the secrets file is mounted read-only",
      (inspect.HostConfig?.Binds ?? []).some((b) => b.endsWith(`:${CONTAINER_SECRETS_PATH}:ro`)),
      `binds were ${JSON.stringify(inspect.HostConfig?.Binds)}`,
    );

    console.log("\n--- Test 2: the host secrets file is 0600 in a 0700 directory ---");
    const secretsDir = containerSecretsDir(CONTAINER_NAME, runDir);
    const secretsPath = join(secretsDir, "secrets.env");
    check("secrets.env is 0600", ((await stat(secretsPath)).mode & 0o777) === 0o600, `mode is ${((await stat(secretsPath)).mode & 0o777).toString(8)}`);
    check("its directory is 0700", ((await stat(secretsDir)).mode & 0o777) === 0o700);
    const secretsFile = await readFile(secretsPath, "utf-8");
    check("it carries both credentials", secretsFile.includes(authToken) && secretsFile.includes(FAKE_API_KEY));

    console.log("\n--- Test 3: the token still reaches the app — the bridge authenticates with it ---");
    const url = `http://127.0.0.1:${running.ports.httpRpc}`;
    await waitFor(async () => {
      try {
        return (await fetch(`${url}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 60000, "GET /healthz to return 200");

    const authed = await rpcCall(url, authToken, "write_file", { path: "secrets-milestone.txt", content: "delivered without docker inspect" });
    check(
      "the bridge accepts the bearer token it was never given in Env",
      authed.status === 200 && !authed.body.error,
      `got ${authed.status} ${JSON.stringify(authed.body)} — the secrets file never reached the app, so this change broke delivery rather than only hiding the value`,
    );
    const wrong = await rpcCall(url, `${authToken}-wrong`, "write_file", { path: "nope.txt", content: "x" });
    check("the bridge still refuses a wrong token", wrong.status === 401, `got ${wrong.status}`);

    console.log("\n--- Test 4: docker exec sees neither secret (they are not container configuration) ---");
    const execEnv = await execCapture(running.container, ["env"]);
    check("no RPC token in a fresh exec'd process's environment", !execEnv.includes(authToken));
    check("no API key in a fresh exec'd process's environment", !execEnv.includes(FAKE_API_KEY));

    console.log("\n--- Test 5: a real snapshot of this container carries no credentials ---");
    const snapshotEnv = {};
    for (const entry of containerEnv) {
      const eq = entry.indexOf("=");
      if (eq > 0) snapshotEnv[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    // Exactly what `berth snapshot create` does — and then some: the API key is
    // added back by hand, so this also covers a caller that assembles `env`
    // itself instead of reading it out of inspect.
    snapshotEnv.ANTHROPIC_API_KEY = FAKE_API_KEY;
    const { dir } = await createSnapshot({ container: running.container, appName: "secrets-milestone", manifest, env: snapshotEnv, snapshotsDir, docker });

    const envJson = await readFile(join(dir, "env.json"), "utf-8");
    check("env.json holds no API key", !envJson.includes(FAKE_API_KEY), `env.json: ${envJson}`);
    check("env.json holds no RPC token", !envJson.includes(authToken));
    check("env.json is 0600", ((await stat(join(dir, "env.json"))).mode & 0o777) === 0o600);
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf-8"));
    check(
      "the snapshot records what it withheld",
      (metadata.redactedEnvNames ?? []).includes("ANTHROPIC_API_KEY"),
      `redactedEnvNames was ${JSON.stringify(metadata.redactedEnvNames)}`,
    );

    // The committed image layer is the other half of a snapshot, and the one
    // that would carry a secret baked into the filesystem rather than into
    // env.json. /run/berth/secrets.env is a bind mount, and `docker commit`
    // excludes mount points — asserted against the real tarball rather than
    // trusting that.
    const imageTar = await readFile(join(dir, "image.tar"));
    check(
      "the committed image tarball contains neither credential",
      !imageTar.includes(FAKE_API_KEY) && !imageTar.includes(authToken),
      "a credential is baked into the snapshot's image layer",
    );
  } finally {
    await stopContainer(running.container, { secretsRunDir: runDir }).catch(() => {});
    await rm(snapshotsDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log("\n--- Test 6: stopping the container removes its host secrets file ---");
  check("the per-container secrets directory is gone", !(await exists(containerSecretsDir(CONTAINER_NAME, runDir))));

  console.log("");
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("All secrets checks passed.");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rpcCall(url, token, exportName, input) {
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: randomBytes(4).toString("hex"), export: exportName, input }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function execCapture(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
