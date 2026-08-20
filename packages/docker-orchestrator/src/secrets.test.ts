import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSecretEnvName,
  partitionSecretEnv,
  stripSecretEnv,
  serializeSecretsEnvFile,
  writeContainerSecretsFile,
  removeContainerSecretsDir,
  containerSecretsDir,
  isGroupOrWorldReadable,
  partitionSecretsPerApp,
  writePerAppSecretsFiles,
} from "./secrets.js";

test("isSecretEnvName catches the credentials Berth itself sets", () => {
  for (const name of [
    "BERTH_HTTP_RPC_TOKEN",
    "BERTH_TERMINAL_CREDENTIAL",
    "BERTH_VNC_PASSWORD",
    "BERTH_GRANTS_TOKEN",
    "BERTH_REGISTRY_TOKEN",
    "BERTH_GRANTS_OPERATOR_TOKEN",
  ]) {
    assert.equal(isSecretEnvName(name), true, `${name} must not reach docker inspect`);
  }
});

test("isSecretEnvName catches real provider key names, including ones that don't end in API_KEY", () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_KEY",
    "HF_TOKEN",
    "GITHUB_PAT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "DB_PASSWORD",
    "anthropic_api_key",
  ]) {
    assert.equal(isSecretEnvName(name), true, `${name} must be treated as a secret`);
  }
});

test("isSecretEnvName leaves Berth's own non-credential env alone", () => {
  for (const name of [
    "BERTH_APPS",
    "BERTH_WORKSPACE_ROOT",
    "BERTH_MESH_PEER_NAME",
    "BERTH_MESH_COORDINATOR_URL",
    "BERTH_MESH_KEY_PATH",
    "BERTH_HTTP_RPC_PORT",
    "BERTH_HTTP_RPC_APP",
    "BERTH_REQUIRE_ENFORCEMENT",
    "BERTH_GRANTS_SERVER_URL",
    "BERTH_BOOT_ID",
    "PATH",
    "HOME",
  ]) {
    assert.equal(isSecretEnvName(name), false, `${name} is not a credential and belongs in Env`);
  }
});

test("partitionSecretEnv splits without losing or duplicating an entry", () => {
  const { plain, secret } = partitionSecretEnv({
    BERTH_APPS: "[]",
    ANTHROPIC_API_KEY: "sk-ant-test",
    BERTH_HTTP_RPC_PORT: "7300",
    BERTH_HTTP_RPC_TOKEN: "deadbeef",
  });
  assert.deepEqual(plain, { BERTH_APPS: "[]", BERTH_HTTP_RPC_PORT: "7300" });
  assert.deepEqual(secret, { ANTHROPIC_API_KEY: "sk-ant-test", BERTH_HTTP_RPC_TOKEN: "deadbeef" });
});

test("stripSecretEnv keeps the withheld names but never their values", () => {
  const { env, strippedNames } = stripSecretEnv({
    BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace",
    OPENAI_API_KEY: "sk-openai-test",
    BERTH_TERMINAL_CREDENTIAL: "berth:hunter2",
  });
  assert.deepEqual(env, { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" });
  assert.deepEqual(strippedNames, ["BERTH_TERMINAL_CREDENTIAL", "OPENAI_API_KEY"]);
  assert.ok(!JSON.stringify(env).includes("sk-openai-test"));
  assert.ok(!JSON.stringify(strippedNames).includes("hunter2"));
});

/**
 * The interesting half of the serializer. A key containing `$(...)`, a
 * backtick, or a single quote is not hypothetical — `openssl rand -base64`
 * output routinely contains `+`/`/`, and a pasted key can contain anything at
 * all. Getting this wrong means the shell *executes* part of a credential at
 * container boot, which is strictly worse than the leak this whole change is
 * closing.
 */
test("serializeSecretsEnvFile survives shell metacharacters in a value", async () => {
  const hostile = {
    A_TOKEN: "it's got a quote",
    B_TOKEN: "$(touch /tmp/berth-secrets-test-pwned)",
    C_TOKEN: "back`tick`s and $VARS and \\backslashes",
    D_TOKEN: "line one\nline two",
  };
  const file = serializeSecretsEnvFile(hostile);

  // Round-trip it through a real shell rather than asserting on the text: the
  // only question that matters is what bash ends up with in its environment.
  const { execFile } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "berth-secrets-serialize-"));
  const path = join(dir, "secrets.env");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, file);

  const printed = await new Promise<string>((resolve, reject) => {
    execFile(
      "bash",
      ["-c", `set -a; . "${path}"; set +a; for n in A_TOKEN B_TOKEN C_TOKEN D_TOKEN; do printf '%s=%s\\0' "$n" "\${!n}"; done`],
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  const roundTripped = Object.fromEntries(
    printed
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const eq = entry.indexOf("=");
        return [entry.slice(0, eq), entry.slice(eq + 1)];
      }),
  );
  assert.deepEqual(roundTripped, hostile);
});

test("serializeSecretsEnvFile refuses a name the shell cannot represent, rather than dropping it", () => {
  assert.throws(() => serializeSecretsEnvFile({ "MY-API-KEY": "x" }), /not a valid shell environment variable name/);
});

test("writeContainerSecretsFile writes 0600 in a 0700 directory", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-secrets-run-"));
  const path = await writeContainerSecretsFile("berth-dev-app", { ANTHROPIC_API_KEY: "sk-ant-test" }, runDir);

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(containerSecretsDir("berth-dev-app", runDir))).mode & 0o777, 0o700);
  assert.ok((await readFile(path, "utf-8")).includes("sk-ant-test"));
  assert.equal(await isGroupOrWorldReadable(path), false);
});

/**
 * The second `berth dev` boot of the same app is the case that matters:
 * writeFile()'s `mode` is ignored entirely for a file that already exists, so
 * a mode set only at creation time would silently decay the moment anything
 * (an editor, a `cp`, an earlier Berth version) left a 0644 file behind.
 */
test("writeContainerSecretsFile re-tightens the mode of a file that already exists", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-secrets-run-"));
  const { chmod } = await import("node:fs/promises");

  const path = await writeContainerSecretsFile("berth-dev-app", { A_TOKEN: "first" }, runDir);
  await chmod(path, 0o644);
  await chmod(containerSecretsDir("berth-dev-app", runDir), 0o755);

  await writeContainerSecretsFile("berth-dev-app", { A_TOKEN: "second" }, runDir);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(containerSecretsDir("berth-dev-app", runDir))).mode & 0o777, 0o700);
  assert.ok((await readFile(path, "utf-8")).includes("second"));
});

test("removeContainerSecretsDir deletes the whole directory and is a no-op when it's already gone", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-secrets-run-"));
  await writeContainerSecretsFile("berth-dev-app", { A_TOKEN: "x" }, runDir);

  await removeContainerSecretsDir("berth-dev-app", runDir);
  await assert.rejects(stat(containerSecretsDir("berth-dev-app", runDir)));
  await assert.doesNotReject(removeContainerSecretsDir("berth-dev-app", runDir));
});

/**
 * BERTH_SECRETS_FILE points at a mount that only exists for the boot that
 * created it. Replayed into a restore on another machine it resolves to
 * nothing, and entrypoint.sh — which fails closed on an unreadable secrets
 * file, deliberately — would refuse to boot the restored sandbox at all.
 */
test("stripSecretEnv drops boot-scoped names without reporting them as withheld credentials", () => {
  const { env, strippedNames } = stripSecretEnv({
    BERTH_SECRETS_FILE: "/run/berth/secrets.env",
    BERTH_WORKSPACE_ROOT: "/workspace",
    ANTHROPIC_API_KEY: "sk-ant-test",
  });
  assert.deepEqual(env, { BERTH_WORKSPACE_ROOT: "/workspace" });
  assert.deepEqual(strippedNames, ["ANTHROPIC_API_KEY"]);
});

test("partitionSecretsPerApp: no declarations means everything stays shared — byte-identical boot", () => {
  const secret = { ANTHROPIC_API_KEY: "sk-1", BERTH_HTTP_RPC_TOKEN: "t" };
  const { shared, perApp, missing } = partitionSecretsPerApp(secret, [
    { name: "filesystem", secrets: [] },
    { name: "code-editor", secrets: [] },
  ]);
  assert.deepEqual(shared, secret);
  assert.deepEqual(perApp, {});
  assert.deepEqual(missing, []);
});

test("partitionSecretsPerApp: a declared name leaves the shared file and reaches only its declarer", () => {
  const { shared, perApp } = partitionSecretsPerApp(
    { A_API_KEY: "va", BERTH_HTTP_RPC_TOKEN: "t" },
    [
      { name: "app-a", secrets: ["A_API_KEY"] },
      { name: "app-b", secrets: [] },
    ],
  );
  assert.deepEqual(shared, { BERTH_HTTP_RPC_TOKEN: "t" });
  assert.deepEqual(perApp, { "app-a": { A_API_KEY: "va" } });
  assert.ok(!("app-b" in perApp));
});

test("partitionSecretsPerApp: two apps may both declare the same name; each gets it, shared does not", () => {
  const { shared, perApp } = partitionSecretsPerApp({ SHARED_TOKEN: "v" }, [
    { name: "app-a", secrets: ["SHARED_TOKEN"] },
    { name: "app-b", secrets: ["SHARED_TOKEN"] },
  ]);
  assert.deepEqual(shared, {});
  assert.deepEqual(perApp, { "app-a": { SHARED_TOKEN: "v" }, "app-b": { SHARED_TOKEN: "v" } });
});

test("partitionSecretsPerApp: a declared name with no value is reported missing, not invented", () => {
  const { shared, perApp, missing } = partitionSecretsPerApp({}, [{ name: "app-a", secrets: ["ABSENT_KEY"] }]);
  assert.deepEqual(shared, {});
  assert.deepEqual(perApp, {});
  assert.deepEqual(missing, [{ app: "app-a", name: "ABSENT_KEY" }]);
});

test("writePerAppSecretsFiles: 0600 files in a 0700 apps/ dir; nothing written and no dir when empty", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "berth-secrets-run-"));
  assert.equal(await writePerAppSecretsFiles("berth-two-app", {}, runDir), undefined);

  const dir = await writePerAppSecretsFiles("berth-two-app", { "app-a": { A_API_KEY: "va" } }, runDir);
  assert.ok(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const file = join(dir, "secrets.app-a.env");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok((await readFile(file, "utf-8")).includes("A_API_KEY='va'"));
});
