import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The SDK a `berth init` project runs is not dist/ but the external build:
// scripts/build-external.mjs bundles it into dist-external and packs
// berth-sdk.tgz, which init vendors as a file: dependency. That bundle is a
// different file layout from dist/, so anything embeddings.ts resolves
// relative to its own location (the sharp hook, the model directory) has to
// be checked there, from the packed tarball, not from dist/.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARBALL = join(PACKAGE_ROOT, "dist-external", "berth-sdk.tgz");

// The tarball's declared dependencies, taken from this workspace rather than
// the network. yaml is only a dependency of the inlined manifest-schema.
const DEPENDENCIES: Record<string, string> = {
  zod: join(PACKAGE_ROOT, "node_modules", "zod"),
  protobufjs: join(PACKAGE_ROOT, "node_modules", "protobufjs"),
  "@xenova/transformers": join(PACKAGE_ROOT, "node_modules", "@xenova", "transformers"),
  undici: join(PACKAGE_ROOT, "node_modules", "undici"),
  yaml: join(PACKAGE_ROOT, "..", "manifest-schema", "node_modules", "yaml"),
};

function installPackedSdk(dir: string): void {
  const sdk = join(dir, "node_modules", "@berthos", "sdk");
  mkdirSync(dirname(sdk), { recursive: true });
  execFileSync("tar", ["-xzf", TARBALL, "-C", dir]);
  renameSync(join(dir, "package"), sdk);
  for (const [name, source] of Object.entries(DEPENDENCIES)) {
    const target = join(dir, "node_modules", name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(source), target);
  }
}

function writeApp(dir: string): void {
  writeFileSync(join(dir, "berth.yml"), "name: embeddings-probe\nversion: 0.1.0\ndescription: probe\nexports: []\n");
  mkdirSync(join(dir, "dist"));
  writeFileSync(
    join(dir, "dist", "index.js"),
    'import { defineApp } from "@berthos/sdk";\n' +
      'export default defineApp((app) => { app.onAgentReady(async (ctx) => { await ctx.semanticFs.query("meaning"); }); });\n',
  );
}

/** A stand-in semantic-fs daemon: answers every frame, and resolves with the first "query" frame it sees. */
function fakeSemanticFs(socketPath: string): { server: net.Server; query: Promise<Record<string, unknown>> } {
  let onQuery: (frame: Record<string, unknown>) => void = () => {};
  const query = new Promise<Record<string, unknown>>((resolve) => (onQuery = resolve));
  const server = net.createServer((socket) => {
    // The test ends by killing the runtime, which resets this connection;
    // unhandled, that reset is an uncaught exception after the test passed.
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0);
        const frame = JSON.parse(buffer.subarray(4, 4 + length).toString("utf-8")) as Record<string, unknown>;
        buffer = buffer.subarray(4 + length);
        const reply = Buffer.from(JSON.stringify({ id: frame.id, ok: true, results: [] }));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(reply.length, 0);
        socket.write(Buffer.concat([prefix, reply]));
        if (frame.op === "query") onQuery(frame);
      }
    });
  });
  server.listen(socketPath);
  return { server, query };
}

test("the packed external SDK embeds a query (sharp hook and model both resolve from the bundle)", { timeout: 120_000 }, async () => {
  assert.ok(existsSync(TARBALL), `${TARBALL} is missing: run this package's build first`);
  const dir = mkdtempSync(join(tmpdir(), "bsx-"));
  installPackedSdk(dir);
  writeApp(dir);
  const { server, query } = fakeSemanticFs(join(dir, "s.sock"));
  let stderr = "";
  const child = spawn(process.execPath, [join(dir, "node_modules", "@berthos", "sdk", "runtime.js")], {
    cwd: dir,
    env: {
      ...process.env,
      BERTH_SEMANTIC_FS_SOCKET: join(dir, "s.sock"),
      BERTH_CONTEXT_BUS_SOCKET: join(dir, "absent.sock"),
      BERTH_RPC_SOCKET: join(dir, "r.sock"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<never>((_, reject) => child.once("exit", (code) => reject(new Error(`runtime exited (${code}):\n${stderr}`))));
    const frame = await Promise.race([query, exited]);
    assert.ok(Array.isArray(frame.embedding), `query was sent without an embedding; runtime stderr:\n${stderr}`);
    assert.equal((frame.embedding as number[]).length, 384);
    assert.doesNotMatch(stderr, /embedding/i);
  } finally {
    child.kill();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
