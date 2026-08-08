#!/usr/bin/env node
// Real, running verification that @berth/sdk-python's RPC framing is
// byte-compatible with @berth/sdk's rpc.ts: boots a real apps/hello-world-py
// container (BERTH_APP_RUNTIME=python), sends a real {id,export,input} line
// over its actual container stdio (the exact same attach-and-write pattern
// every other milestone test in this repo uses against Node apps), and
// asserts a correct {id,result} comes back.
//
// Real, non-obvious bug this surfaced (not specific to Python): dockerode's
// container.attach({stream,stdin,stdout,stderr,hijack:true}) has a genuine
// bug in docker-modem — since attach is a POST and its own options object
// gets passed through as `opts`, docker-modem's dial() unconditionally does
// `data = JSON.stringify(opts._body || opts)` for any POST call, so the
// attach OPTIONS THEMSELVES get sent as a request body with no trailing
// newline. That body's bytes land as the first thing written to the
// container's actual stdin once the connection upgrades — silently
// concatenating onto whatever the caller's first real RPC write is, unless
// something separates them. Prepending "\n" to the first write forces that
// line break for real, rather than papering over it with a timing delay
// (this is very likely the actual root cause of attach-timing flakiness
// seen elsewhere in this repo's other milestone tests too, not just here).
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "hello-world-py");
const IMAGE_TAG = "berth/hello-world-py:dev";

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));

  // /workspace is bind-mounted straight to REPO_ROOT in dev mode, so a
  // previous run's on_install marker is a real file left in this repo
  // (already gitignored, same test-pollution pattern noted in other
  // milestone tests here) — clear it so this run's on_install assertion is
  // meaningful rather than trivially skipped.
  await rm(join(APP_DIR, ".berth"), { recursive: true, force: true });

  console.log("--- Building hello-world-py's dev image ---");
  await buildImage({ appDir: APP_DIR, tag: IMAGE_TAG, target: "dev", docker });

  console.log("\n--- Starting the Python resident app's sandbox (BERTH_APP_RUNTIME=python) ---");
  const running = await startContainer({
    image: IMAGE_TAG,
    name: "berth-python-sdk-milestone",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/hello-world-py",
    env: { BERTH_APP_RUNTIME: "python" },
    docker,
  });

  const containerLog = await startLogCapture(running.container);
  try {
    await waitFor(() => /"hello-world-py" ready/.test(containerLog.text()), 20000, "hello-world-py runtime ready");
    // Inverted by REMEDIATION 1.5. This used to assert that the Python
    // lifecycle script *ran* the manifest's on_install at boot; that was the
    // vulnerability — an unsandboxed root shell from a berth.yml, executed
    // before any Landlock domain existed. on_install is a Docker build layer
    // now, in both SDKs, so the boot-time absence is what proves the Python
    // path was migrated too rather than quietly left behind. That its command
    // still runs at all is covered at build time by on-install-milestone.mjs,
    // and visible in this very run's build output as "python-on-install-ran".
    assert(
      !/running on_install/.test(containerLog.text()),
      "expected no on_install execution at boot — the Python lifecycle script still runs manifest shell as root",
    );
    assert(
      /\[berth:capability-policy\] wrote/.test(containerLog.text()),
      "expected the Python capability-policy script to have written a real policy file",
    );

    const rpc = await createRpcClient(running.container);

    console.log("\n--- Test: greet, a real RPC round trip over the Python runtime's stdio ---");
    const response = await rpc.call({ id: "1", export: "greet", input: { name: "World" } });
    console.log("response:", response);
    assert(!response.error, `expected greet to succeed, got error: ${response.error}`);
    assert(
      response.result?.message === "Hello, World! (from a real Python resident app)",
      `expected the Python handler's real response, got: ${JSON.stringify(response.result)}`,
    );

    console.log("\n--- Test: an unknown export gets a real error response, not silence ---");
    const badResponse = await rpc.call({ id: "2", export: "does_not_exist", input: {} });
    console.log("response:", badResponse);
    assert(
      badResponse.error === 'no such export "does_not_exist"',
      `expected a real "no such export" error, got: ${JSON.stringify(badResponse)}`,
    );

    rpc.close();
    console.log(
      "\nPASS — @berth/sdk-python's runtime, RPC framing, and manifest loading are byte-compatible with the " +
        "TypeScript SDK's, proven by a real container boot and a real stdio RPC round trip, not a unit test in isolation.",
    );
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startLogCapture(container) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer, stop: async () => raw.destroy() };
}

async function createRpcClient(container) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  const pending = new Map();

  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      } catch {
        // not a JSON line — ignore
      }
    }
  });

  let firstWrite = true;
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 30000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        // See this file's header comment: docker-modem's attach() writes
        // its own options object as a bodyless-newline POST body, which
        // would otherwise concatenate onto this being the first line
        // written to the container's stdin.
        const prefix = firstWrite ? "\n" : "";
        firstWrite = false;
        stream.write(prefix + JSON.stringify(request) + "\n");
      });
    },
    close() {
      stream.end();
    },
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nPYTHON SDK MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
