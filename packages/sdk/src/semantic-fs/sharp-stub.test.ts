import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const embeddingsUrl = new URL("./embeddings.js", import.meta.url).href;

// What a sandbox image built from a clone actually contains: a
// node_modules/sharp symlink pointing at a path on the machine that built it.
function projectWithBrokenSharp(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-sharp-"));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync("/nonexistent/builder/packages/sdk/vendor/sharp-stub", join(dir, "node_modules", "sharp"));
  writeFileSync(join(dir, "uses-sharp.mjs"), 'import sharp from "sharp";\nexport default sharp;\n');
  return dir;
}

async function importInChild(dir: string, registerFirst: boolean): Promise<string> {
  const script = `
    ${registerFirst ? `(await import(${JSON.stringify(embeddingsUrl)})).registerSharpStub();` : ""}
    try {
      const sharp = (await import(${JSON.stringify(new URL(`file://${join(dir, "uses-sharp.mjs")}`).href)})).default;
      try { sharp(); console.log("CALLED"); } catch (e) { console.log("STUB " + e.message); }
    } catch (e) {
      console.log("IMPORT_FAILED " + e.code);
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir });
  return stdout.trim();
}

test("without the hook, a broken sharp link fails to import (the bug this guards)", async () => {
  const dir = projectWithBrokenSharp();
  try {
    assert.match(await importInChild(dir, false), /^IMPORT_FAILED ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSharpStub() resolves sharp to the SDK's own stub wherever the SDK is installed", async () => {
  const dir = projectWithBrokenSharp();
  try {
    assert.match(await importInChild(dir, true), /^STUB sharp is stubbed out in @berthos\/sdk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
