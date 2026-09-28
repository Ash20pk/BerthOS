#!/usr/bin/env node
// Real, running verification that `runtime: python` apps are full members of
// a multi-app sandbox, under real enforcement, in a production image:
//
//   - a Python governor (governs: true) gates a Python app's exports — the
//     gate in berth_sdk/governance_gate.py, fail-closed like the Node one;
//   - the same Python governor answers a Node app's gate (apps/notes), which
//     needs it to serve per-caller peer sockets as rpc.ts does;
//   - a Python app reaches another over app:invoke:, i.e. through the
//     target's peers/<caller>/rpc.sock;
//   - each app's runtime comes from /etc/berth/runtime, written at build time;
//   - an app shipping its own berth_sdk/ never gets it run as root: the
//     policy compiler runs from the image's copy, not the app's directory.
//
// No bind mount, so it runs wherever Docker does.
import Docker from "dockerode";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berthos/manifest-schema";
import { buildImage, startContainer, stopContainer, invokeAppExport } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FIXTURES = join(__dirname, "fixtures");
const IMAGE_TAG = "berth/python-multi-app-milestone:test";

const docker = new Docker();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exec(container, command) {
  const run = await container.exec({ Cmd: ["sh", "-c", command], AttachStdout: true, AttachStderr: true });
  const stream = await run.start({ hijack: true, stdin: false });
  const stdout = [];
  const stderr = [];
  const { PassThrough } = await import("node:stream");
  const out = new PassThrough();
  const err = new PassThrough();
  out.on("data", (c) => stdout.push(c));
  err.on("data", (c) => stderr.push(c));
  docker.modem.demuxStream(stream, out, err);
  await new Promise((resolve) => stream.on("end", resolve));
  return Buffer.concat(stdout).toString("utf8") + Buffer.concat(stderr).toString("utf8");
}

async function main() {
  const specs = [
    { name: "python-governor", appDir: join(FIXTURES, "python-governor") },
    { name: "python-worker", appDir: join(FIXTURES, "python-worker") },
    { name: "python-target", appDir: join(FIXTURES, "python-target") },
    { name: "python-planted-sdk", appDir: join(FIXTURES, "python-planted-sdk") },
    { name: "notes", appDir: join(REPO_ROOT, "apps", "notes") },
  ];
  for (const spec of specs) spec.manifest = await loadManifest(join(spec.appDir, "berth.yml"));

  console.log("--- Building a production image: three Python apps, a planted SDK, and a Node app ---");
  await buildImage({
    appDir: specs[0].appDir,
    tag: IMAGE_TAG,
    target: "production",
    appName: specs[0].name,
    companions: specs.slice(1).map(({ name, appDir }) => ({ name, appDir })),
    docker,
  });

  const running = await startContainer({
    image: IMAGE_TAG,
    name: `berth-python-multi-app-milestone-${Date.now()}`,
    manifest: specs[0].manifest,
    workingDir: `/app/apps/${specs[0].name}`,
    apps: specs.map((s) => ({ name: s.name, workingDir: `/app/apps/${s.name}`, manifest: s.manifest })),
    docker,
  });
  const container = running.container;

  try {
    const call = (app, exportName, input) =>
      invokeAppExport(container, app, { id: exportName, export: exportName, input }, { docker, timeoutMs: 10000 });

    // Every app logs "ready" once its sockets are bound; poll the governed
    // call rather than sleeping a fixed time.
    let ok;
    for (let attempt = 0; attempt < 60; attempt++) {
      ok = await call("python-worker", "ok").catch((err) => ({ error: String(err) }));
      if (!ok.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log("python-worker.ok        ->", JSON.stringify(ok));
    assert(ok.result?.ran === "ok", `expected the governor to allow python-worker.ok, got ${JSON.stringify(ok)}`);

    const blocked = await call("python-worker", "blocked");
    console.log("python-worker.blocked   ->", JSON.stringify(blocked));
    assert(
      blocked.error === "governance denied blocked: blocked by python-governor",
      `expected a Python app's export to be denied by the governor, got ${JSON.stringify(blocked)}`,
    );

    const invoked = await call("python-worker", "call_target");
    console.log("python-worker.call_target ->", JSON.stringify(invoked));
    assert(
      invoked.result?.result?.target === "python-target",
      `expected app:invoke: to reach python-target's peer socket, got ${JSON.stringify(invoked)}`,
    );

    const notes = await call("notes", "list_notes");
    console.log("notes.list_notes        ->", JSON.stringify(notes));
    assert(Array.isArray(notes.result?.notes), `expected the Node app's gate to get a verdict from the Python governor, got ${JSON.stringify(notes)}`);

    const logs = (await container.logs({ stdout: true, stderr: true })).toString("utf8");
    assert(/\[python-governor\] evaluate notes\.list_notes from host/.test(logs), "expected the Python governor to have been asked about notes.list_notes");

    const runtimes = await exec(container, "for f in /etc/berth/runtime/*; do echo \"$(basename \"$f\")=$(cat \"$f\")\"; done");
    console.log(runtimes.trim());
    for (const expected of ["_primary=python", "python-worker=python", "notes=node"]) {
      assert(runtimes.includes(expected), `expected /etc/berth/runtime to record ${expected}, got:\n${runtimes}`);
    }

    const planted = await exec(container, "ls /run/berth-planted-sdk-ran-as-uid-* 2>/dev/null || echo none");
    assert(planted.trim() === "none", `an app-supplied berth_sdk ran during boot: ${planted}`);
    const policy = await exec(container, "cat /app/apps/python-planted-sdk/.berth/capability-policy.json");
    assert(/"appName": "python-planted-sdk"/.test(policy), `expected the real compiler to have written python-planted-sdk's policy, got ${policy}`);

    const modes = await exec(container, "stat -c '%a %n' /run/berth/python-worker/rpc.sock /run/berth/python-target/peers/python-worker/rpc.sock");
    console.log(modes.trim());
    assert(/^600 \/run\/berth\/python-worker\/rpc\.sock$/m.test(modes), `expected the relay socket at 0600, got ${modes}`);
    assert(/^660 \/run\/berth\/python-target\/peers\/python-worker\/rpc\.sock$/m.test(modes), `expected the peer socket at 0660, got ${modes}`);

    console.log("\nPYTHON MULTI-APP MILESTONE VERIFIED");
  } finally {
    await stopContainer(container);
  }
}

main().catch((err) => {
  console.error("\nPYTHON MULTI-APP MILESTONE VERIFICATION FAILED:", err);
  process.exit(1);
});
