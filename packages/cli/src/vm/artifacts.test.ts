import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { artifactsPresent, checkArtifacts, expandUrlTemplate, installArtifacts, releasePair, sourceCandidates } from "./artifacts.js";
import { DEFAULT_ARTIFACTS_URL } from "./config.js";
import { kernelPin, rootfsPin, vmmPin, type ArtifactPin } from "./pins.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function fixture() {
  const kernel = Buffer.from("kernel image bytes ".repeat(100));
  const rootfs = Buffer.from("erofs image bytes ".repeat(300));
  const ks = sha(kernel);
  const rs = sha(rootfs);
  const pins: ArtifactPin[] = [kernelPin(ks, kernel.length), rootfsPin(rs, rootfs.length)];
  const root = mkdtempSync(join(tmpdir(), "berth-vm-art-"));
  return { kernel, rootfs, pins, root, dest: join(root, "dest") };
}

function writeLayout(dir: string, pins: ArtifactPin[], bodies: Buffer[]) {
  pins.forEach((p, i) => {
    mkdirSync(dirname(join(dir, p.relPath)), { recursive: true });
    writeFileSync(join(dir, p.relPath), bodies[i]!);
  });
}

async function serve(handler: (path: string) => { status: number; body?: Buffer; length?: number; location?: string }): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const r = handler(req.url ?? "");
    res.writeHead(r.status, { ...(r.length !== undefined ? { "content-length": String(r.length) } : {}), ...(r.location ? { location: r.location } : {}) });
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

/** A directory shaped like a vm-artifacts GitHub release: every asset named by its sha256. */
function releaseDir(dir: string, pins: ArtifactPin[], bodies: Buffer[]) {
  mkdirSync(dir, { recursive: true });
  pins.forEach((p, i) => writeFileSync(join(dir, p.asset), bodies[i]!));
}

test("the default template is the GitHub release for the kernel and rootfs pair, by asset name", () => {
  const f = fixture();
  const [k, r] = f.pins as [ArtifactPin, ArtifactPin];
  const tag = `vm-artifacts-${k.sha256.slice(0, 8)}-${r.sha256.slice(0, 8)}`;
  const base = `https://github.com/Ash20pk/BerthOS/releases/download/${tag}`;
  assert.equal(expandUrlTemplate(DEFAULT_ARTIFACTS_URL, k, releasePair(f.pins)), `${base}/Image-${k.sha256}`);
  assert.equal(expandUrlTemplate(DEFAULT_ARTIFACTS_URL, r, releasePair(f.pins)), `${base}/rootfs-${r.sha256}.erofs`);
  // berth-vmm sits in the release of the pair it was built for.
  const v = vmmPin("darwin-arm64", { "darwin-arm64": { sha256: "c".repeat(64), size: 3 } })!;
  assert.equal(expandUrlTemplate(DEFAULT_ARTIFACTS_URL, v, releasePair(f.pins)), `${base}/berth-vmm-darwin-arm64-${"c".repeat(64)}`);
  // The older placeholders still work for a mirror keyed by sha256.
  assert.equal(expandUrlTemplate("https://m/{kind}/sha256/{sha256}/{file}", k), `https://m/kernel/sha256/${k.sha256}/Image`);
  assert.ok(sourceCandidates(k, "/d").includes(`/d/Image-${k.sha256}`), "a downloaded release directory works with --from");
});

test("installs from a local HTTP server shaped like a GitHub release, following the redirect to the asset host", async () => {
  const f = fixture();
  const [k, r] = f.pins as [ArtifactPin, ArtifactPin];
  const tag = `vm-artifacts-${k.sha256.slice(0, 8)}-${r.sha256.slice(0, 8)}`;
  const bodies = new Map([
    [`/cdn/${k.asset}`, f.kernel],
    [`/cdn/${r.asset}`, f.rootfs],
  ]);
  const prefix = `/Ash20pk/BerthOS/releases/download/${tag}/`;
  const { url, server, hits } = await serve((path) => {
    // github.com answers a release download with a 302 to its asset CDN.
    if (path.startsWith(prefix)) return { status: 302, location: `/cdn/${path.slice(prefix.length)}` };
    const body = bodies.get(path);
    return body ? { status: 200, body, length: body.length } : { status: 404 };
  });
  try {
    const results = await installArtifacts({ root: f.dest, urlTemplate: `${url}/Ash20pk/BerthOS/releases/download/vm-artifacts-{kernel8}-{rootfs8}/{asset}`, pins: f.pins });
    assert.deepEqual(results.map((x) => x.source), ["downloaded", "downloaded"]);
    assert.deepEqual(hits, [`${prefix}${k.asset}`, `/cdn/${k.asset}`, `${prefix}${r.asset}`, `/cdn/${r.asset}`]);
    assert.deepEqual((await checkArtifacts(f.dest, f.pins)).map((x) => x.status), ["verified", "verified"]);
    // berth-vmm's layout, not the release's names, on disk.
    assert.deepEqual(readFileSync(join(f.dest, k.relPath)), f.kernel);
    assert.deepEqual(readFileSync(join(f.dest, r.relPath)), f.rootfs);
  } finally {
    server.close();
  }
});

test("installs from a file: URL template (a downloaded release directory as a mirror), and refuses a wrong file there", async () => {
  const f = fixture();
  const rel = join(f.root, "release");
  releaseDir(rel, f.pins, [f.kernel, f.rootfs]);
  const template = `file://${rel}/{asset}`;
  const results = await installArtifacts({ root: f.dest, urlTemplate: template, pins: f.pins });
  assert.deepEqual(results.map((x) => x.source), ["downloaded", "downloaded"]);
  assert.ok(artifactsPresent(f.dest, f.pins));

  const bad = join(f.root, "bad");
  releaseDir(bad, f.pins, [Buffer.alloc(f.kernel.length, 7), f.rootfs]);
  await assert.rejects(installArtifacts({ root: join(f.root, "dest2"), urlTemplate: `file://${bad}/{asset}`, pins: f.pins }), /served sha256 [0-9a-f]{64}, not the pinned/);
  releaseDir(bad, [f.pins[0]!], [Buffer.concat([f.kernel, Buffer.from("x")])]);
  await assert.rejects(installArtifacts({ root: join(f.root, "dest3"), urlTemplate: `file://${bad}/{asset}`, pins: [f.pins[0]!] }), /size \d+, but the pinned kernel is \d+ bytes/);
});

test("berth-vmm: made executable and cleared of quarantine only after its sha256 matched", async () => {
  const f = fixture();
  const vmm = Buffer.from("\xcf\xfa\xed\xfe a mach-o, really ".repeat(20));
  const pin = vmmPin("darwin-arm64", { "darwin-arm64": { sha256: sha(vmm), size: vmm.length } })!;
  assert.equal(pin.relPath, "bin/berth-vmm");
  const calls: string[][] = [];
  const run = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof import("node:child_process").spawnSync;
  const rel = join(f.root, "release");
  releaseDir(rel, [pin], [vmm]);
  const logs: string[] = [];
  const [res] = await installArtifacts({ root: f.dest, urlTemplate: `file://${rel}/{asset}`, pins: [pin], release: releasePair(f.pins), run, log: (m) => logs.push(m) });
  const dest = join(f.dest, "bin", "berth-vmm");
  assert.equal(res!.path, dest);
  assert.equal(statSync(dest).mode & 0o777, 0o755);
  if (process.platform === "darwin") {
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.slice(0, 3), ["xattr", "-d", "com.apple.quarantine"]);
    assert.match(calls[0]![3]!, /berth-vmm\.partial-/, "cleared on the verified temporary file, before it is put in place");
    assert.match(logs.join("\n"), /cleared com\.apple\.quarantine after verifying/);
  }

  // Wrong bytes: refused, and xattr is never run on them.
  calls.length = 0;
  const bad = join(f.root, "bad");
  releaseDir(bad, [pin], [Buffer.alloc(vmm.length, 1)]);
  await assert.rejects(installArtifacts({ root: join(f.root, "dest-bad"), urlTemplate: `file://${bad}/{asset}`, pins: [pin], run }), /not the pinned/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(f.root, "dest-bad", "bin", "berth-vmm")), false);
});

test("no berth-vmm is pinned for a platform it isn't published for", () => {
  assert.equal(vmmPin("linux-x64", {}), undefined);
  assert.equal(vmmPin("linux-arm64", { "darwin-arm64": { sha256: "d".repeat(64), size: 1 } }), undefined);
});

/**
 * A server that sends `cut` bytes of the body and then goes silent without
 * closing, on the first `stalls` requests, as a CDN connection that stopped
 * did. Later requests honour Range (or, with `ignoreRange`, send all of it).
 */
async function stallingServer(body: Buffer, opts: { cut: number; stalls: number; ignoreRange?: boolean }) {
  const ranges: (string | undefined)[] = [];
  const open: import("node:http").ServerResponse[] = [];
  const server = createServer((req, res) => {
    ranges.push(req.headers.range);
    if (ranges.length <= opts.stalls) {
      res.writeHead(200, { "content-length": String(body.length) });
      res.write(body.subarray(0, opts.cut));
      open.push(res);
      return;
    }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m && !opts.ignoreRange) {
      const from = Number(m[1]);
      res.writeHead(206, { "content-length": String(body.length - from), "content-range": `bytes ${from}-${body.length - 1}/${body.length}` });
      res.end(body.subarray(from));
    } else {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    for (const r of open) r.destroy();
    server.close();
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ranges, close };
}

test("a download that stalls is aborted and resumed where it stopped, and still checked against the pin", async () => {
  process.env.BERTH_VM_DOWNLOAD_STALL_MS = "300";
  const f = fixture();
  const k = f.pins[0]!;
  const s = await stallingServer(f.kernel, { cut: 700, stalls: 1 });
  const logs: string[] = [];
  try {
    const [r] = await installArtifacts({ root: f.dest, urlTemplate: `${s.url}/{asset}`, pins: [k], log: (m) => logs.push(m) });
    assert.equal(r!.source, "downloaded");
    assert.deepEqual(readFileSync(join(f.dest, k.relPath)), f.kernel);
    assert.deepEqual(s.ranges, [undefined, "bytes=700-"], "the retry asked for the rest");
    assert.ok(logs.some((l) => /stalled: no data for 300 ms at 700 of \d+ bytes; retrying \(2 of 4\), resuming/.test(l)), logs.join("\n"));
  } finally {
    s.close();
    delete process.env.BERTH_VM_DOWNLOAD_STALL_MS;
  }
});

test("a retry the server answers with the whole file (no range support) starts over", async () => {
  process.env.BERTH_VM_DOWNLOAD_STALL_MS = "300";
  const f = fixture();
  const k = f.pins[0]!;
  const s = await stallingServer(f.kernel, { cut: 700, stalls: 1, ignoreRange: true });
  try {
    await installArtifacts({ root: f.dest, urlTemplate: `${s.url}/{asset}`, pins: [k] });
    assert.deepEqual(readFileSync(join(f.dest, k.relPath)), f.kernel, "not the first 700 bytes twice");
  } finally {
    s.close();
    delete process.env.BERTH_VM_DOWNLOAD_STALL_MS;
  }
});

test("a download that keeps stalling fails, saying so, and leaves nothing behind", async () => {
  process.env.BERTH_VM_DOWNLOAD_STALL_MS = "200";
  const f = fixture();
  const k = f.pins[0]!;
  const s = await stallingServer(f.kernel, { cut: 100, stalls: 99 });
  try {
    await assert.rejects(installArtifacts({ root: f.dest, urlTemplate: `${s.url}/{asset}`, pins: [k] }), /stalled: no data for 200 ms \(after 4 attempts\)/);
    assert.equal(s.ranges.length, 4);
    assert.ok(!existsSync(join(f.dest, k.relPath)));
    assert.deepEqual(readdirSync(dirname(join(f.dest, k.relPath))), [], "no partial file left");
  } finally {
    s.close();
    delete process.env.BERTH_VM_DOWNLOAD_STALL_MS;
  }
});
