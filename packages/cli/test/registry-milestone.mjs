#!/usr/bin/env node
// Real, running verification of the Phase 5 milestone: "publish -> discover
// -> install tested with a real third-party-style app" (per the plan's own
// stated Phase 5 verification approach), plus the "open SDK for external
// developers" half of Phase 5's scope.
//
// Boots a real @berth/registry-server (real SQLite index, real blob storage
// on disk), then drives the ACTUAL `berth` CLI as a user would, playing both
// ends of the ecosystem:
//   1. `berth init` a throwaway app from the local hello-world template into
//      a fresh OS temp dir outside this repo — this IS what a genuine
//      third-party developer has: a self-contained scaffold with its own
//      vendored @berth/sdk, no monorepo-relative config (unlike, say,
//      examples/resident-apps/hello-world, whose tsconfig.json extends
//      "../../../tsconfig.base.json" — real, but coupled to this repo,
//      which isn't the case being tested here).
//   2. `berth publish --registry=<url>` on it — a REAL Docker image build,
//      same as any other publish, plus a real multipart upload.
//   3. Confirms the registry actually indexed and can serve it back.
//   4. `berth init --registry=<url> --template=<published-name>` into a
//      SECOND fresh temp dir, simulating a different developer installing
//      it — confirms package.json's "@berth/sdk" was rewritten to the
//      vendored tarball (not left as whatever the publisher had), runs a
//      real `pnpm install` + `pnpm build`, then boots the scaffolded app's
//      vendored @berth/sdk runtime and calls its "ping" export over the real
//      stdio RPC protocol.
//
// Requires Docker Desktop running (step 2's production image build) and all
// workspace packages already built (`pnpm build` at the repo root).
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistryServer } from "@berth/registry-server";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const BERTH_BIN = join(REPO_ROOT, "packages", "cli", "bin", "berth.js");

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-registry-milestone-data-"));
  // Deliberately NOT under packages/*, apps/*, or examples/* — pnpm-workspace.yaml
  // doesn't claim these directories, so this is a genuine outside-the-workspace test.
  const publisherParent = await mkdtemp(join(tmpdir(), "berth-registry-milestone-publisher-"));
  const scaffoldParent = await mkdtemp(join(tmpdir(), "berth-registry-milestone-scaffold-"));

  const app = await createRegistryServer({ dataDir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const registryUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Registry listening at ${registryUrl} (data: ${dataDir})`);

  try {
    console.log("\n--- Scaffolding a throwaway third-party-style app locally ---");
    const initOut = await runCli(["init", "publisher-app", "--template=hello-world"], publisherParent);
    assert(/berth\.yml is valid/.test(initOut), `local init did not validate:\n${initOut}`);
    const publisherDir = join(publisherParent, "publisher-app");

    console.log("\n--- Publishing it to the registry ---");
    const publishOut = await runCli(["publish", `--registry=${registryUrl}`, "--author=milestone-test"], publisherDir);
    assert(/Published publisher-app@0\.1\.0/.test(publishOut), `unexpected publish output:\n${publishOut}`);

    console.log("\n--- Confirming the registry indexed it ---");
    const listRes = await fetch(new URL("/apps", registryUrl));
    const listed = await listRes.json();
    assert(listed.some((a) => a.name === "publisher-app" && a.version === "0.1.0"), `publisher-app not listed: ${JSON.stringify(listed)}`);

    const searchRes = await fetch(new URL("/apps?q=publisher", registryUrl));
    assert((await searchRes.json()).length === 1, "search for 'publisher' should find publisher-app");

    console.log("\n--- A second developer scaffolds a fresh project from the registry ---");
    const scaffoldOut = await runCli(
      ["init", "third-party-app", `--registry=${registryUrl}`, "--template=publisher-app"],
      scaffoldParent,
    );
    assert(/berth\.yml is valid/.test(scaffoldOut), `init did not validate the scaffolded manifest:\n${scaffoldOut}`);

    const targetDir = join(scaffoldParent, "third-party-app");
    assert(existsSync(join(targetDir, "vendor", "berth-sdk.tgz")), "vendored SDK tarball missing");

    const manifestText = await readFile(join(targetDir, "berth.yml"), "utf-8");
    assert(/^name: third-party-app$/m.test(manifestText), `berth.yml name wasn't rewritten:\n${manifestText}`);

    const pkgJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf-8"));
    assert(
      pkgJson.dependencies["@berth/sdk"] === "file:./vendor/berth-sdk.tgz",
      `expected the second developer's own vendorSdk() pass to (re-)point @berth/sdk at their own vendored tarball, got "${pkgJson.dependencies["@berth/sdk"]}"`,
    );

    console.log("\n--- Building the scaffolded app outside the workspace ---");
    await execFileAsync("pnpm", ["build"], { cwd: targetDir });

    console.log("\n--- Booting the scaffolded app via its vendored @berth/sdk runtime ---");
    const pingResult = await bootAndPing(targetDir);
    assert.deepEqualJson(pingResult, { id: "1", result: { message: "pong" } });

    console.log("\nPHASE 5 MILESTONE VERIFIED: publish -> registry -> init -> install -> boot, entirely outside the workspace.");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(publisherParent, { recursive: true, force: true });
    await rm(scaffoldParent, { recursive: true, force: true });
  }
}

async function runCli(args, cwd) {
  const { stdout, stderr } = await execFileAsync("node", [BERTH_BIN, ...args], { cwd });
  return stdout + stderr;
}

function bootAndPing(appDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(appDir, "node_modules", "@berth", "sdk", "runtime.js")], { cwd: appDir });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runtime did not respond in time; stdout so far:\n${stdout}`));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.trim().split("\n").find((l) => l.trim().startsWith("{"));
      if (line) {
        clearTimeout(timer);
        child.kill();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    });
    child.on("error", reject);

    child.stderr.on("data", (chunk) => {
      if (/RPC server listening/.test(chunk.toString())) {
        child.stdin.write(JSON.stringify({ id: "1", export: "ping", input: {} }) + "\n");
      }
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert.deepEqualJson = (actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nPHASE 5 MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
