import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { artifactsPresent, checkArtifacts, installArtifacts } from "./artifacts.js";
import type { ArtifactPin } from "./pins.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function fixture() {
  const kernel = Buffer.from("kernel image bytes ".repeat(100));
  const rootfs = Buffer.from("erofs image bytes ".repeat(300));
  const ks = sha(kernel);
  const rs = sha(rootfs);
  const pins: ArtifactPin[] = [
    { kind: "kernel", sha256: ks, size: kernel.length, file: "Image", relPath: `kernel/sha256/${ks}/Image` },
    { kind: "rootfs", sha256: rs, size: rootfs.length, file: `rootfs-${rs}.erofs`, relPath: `rootfs/rootfs-${rs}.erofs` },
  ];
  const root = mkdtempSync(join(tmpdir(), "berth-vm-art-"));
  return { kernel, rootfs, pins, root, dest: join(root, "dest") };
}

function writeLayout(dir: string, pins: ArtifactPin[], bodies: Buffer[]) {
  pins.forEach((p, i) => {
    mkdirSync(dirname(join(dir, p.relPath)), { recursive: true });
    writeFileSync(join(dir, p.relPath), bodies[i]!);
  });
}

async function serve(handler: (path: string) => { status: number; body?: Buffer; length?: number }): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const r = handler(req.url ?? "");
    res.writeHead(r.status, r.length !== undefined ? { "content-length": String(r.length) } : {});
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits };
}

test("installs from a build directory in berth-vmm's layout, verified, and is a no-op the second time", async () => {
  const f = fixture();
  const src = join(f.root, "build");
  writeLayout(src, f.pins, [f.kernel, f.rootfs]);
  const first = await installArtifacts({ root: f.dest, from: src, pins: f.pins });
  assert.deepEqual(first.map((r) => r.source), ["copied", "copied"]);
  assert.ok(artifactsPresent(f.dest, f.pins));
  assert.deepEqual((await checkArtifacts(f.dest, f.pins)).map((s) => s.status), ["verified", "verified"]);
  const second = await installArtifacts({ root: f.dest, from: src, pins: f.pins });
  assert.deepEqual(second.map((r) => r.source), ["installed", "installed"]);
});

test("a source whose bytes don't match the pin is refused, and nothing is left at the final path", async () => {
  const f = fixture();
  const src = join(f.root, "build");
  writeLayout(src, f.pins, [Buffer.from("tampered"), f.rootfs]);
  await assert.rejects(installArtifacts({ root: f.dest, from: src, pins: f.pins }), /has sha256 [0-9a-f]{64}, not the pinned/);
  assert.equal(existsSync(join(f.dest, f.pins[0]!.relPath)), false);
  assert.deepEqual(readdirSync(dirname(join(f.dest, f.pins[0]!.relPath))), [], "no partial file left behind");
});

test("downloads by sha256 from a URL template when the directory lacks an artifact", async () => {
  const f = fixture();
  const src = join(f.root, "build");
  writeLayout(src, [f.pins[1]!], [f.rootfs]); // only the rootfs is local
  const { url, server, hits } = await serve((path) => (path === `/kernel/${f.pins[0]!.sha256}/Image` ? { status: 200, body: f.kernel, length: f.kernel.length } : { status: 404 }));
  try {
    const results = await installArtifacts({ root: f.dest, from: src, urlTemplate: `${url}/{kind}/{sha256}/{file}`, pins: f.pins });
    assert.deepEqual(results.map((r) => r.source), ["downloaded", "copied"]);
    assert.deepEqual(hits, [`/kernel/${f.pins[0]!.sha256}/Image`]);
    assert.deepEqual(readFileSync(join(f.dest, f.pins[0]!.relPath)), f.kernel);
  } finally {
    server.close();
  }
});

test("a download is refused when it hashes wrong, is too big, or fails", async () => {
  const f = fixture();
  const cases: [string, (p: string) => { status: number; body?: Buffer; length?: number }, RegExp][] = [
    ["wrong bytes", () => ({ status: 200, body: Buffer.alloc(f.kernel.length, 1) }), /served sha256 [0-9a-f]{64}, not the pinned/],
    ["declared too big", () => ({ status: 200, body: Buffer.alloc(f.kernel.length + 10), length: f.kernel.length + 10 }), /content-length \d+, but the pinned kernel is \d+ bytes/],
    ["chunked and too big", () => ({ status: 200, body: Buffer.alloc(f.kernel.length * 3) }), /more than the pinned|got \d+ bytes/],
    ["404", () => ({ status: 404 }), /HTTP 404/],
  ];
  for (const [name, handler, want] of cases) {
    const { url, server } = await serve(handler);
    try {
      await assert.rejects(installArtifacts({ root: f.dest, urlTemplate: `${url}/{sha256}`, pins: [f.pins[0]!] }), want, name);
      assert.equal(existsSync(join(f.dest, f.pins[0]!.relPath)), false, name);
    } finally {
      server.close();
    }
  }
});

test("an installed artifact that no longer verifies is replaced", async () => {
  const f = fixture();
  const src = join(f.root, "build");
  writeLayout(src, f.pins, [f.kernel, f.rootfs]);
  writeLayout(f.dest, f.pins, [Buffer.from("old"), f.rootfs]);
  assert.equal(artifactsPresent(f.dest, f.pins), false);
  assert.deepEqual((await checkArtifacts(f.dest, f.pins)).map((s) => s.status), ["mismatch", "verified"]);
  const logs: string[] = [];
  const results = await installArtifacts({ root: f.dest, from: src, pins: f.pins, log: (m) => logs.push(m) });
  assert.deepEqual(results.map((r) => r.source), ["copied", "installed"]);
  assert.match(logs.join("\n"), /replacing it/);
});
