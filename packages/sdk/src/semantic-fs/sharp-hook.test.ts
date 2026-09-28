import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const embeddingsUrl = new URL("./embeddings.js", import.meta.url).href;

// What a sandbox image built from a clone actually contains: a
// node_modules/sharp symlink pointing at a path on the machine that built it,
// imported from inside @xenova/transformers (src/utils/image.js). Alongside
// it, an app module that imports sharp itself, which must not be touched.
function projectWithBrokenSharp(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-sharp-"));
  const transformers = join(dir, "node_modules", "@xenova", "transformers", "src", "utils");
  mkdirSync(transformers, { recursive: true });
  writeFileSync(join(transformers, "image.js"), 'import sharp from "sharp";\nexport default sharp;\n');
  symlinkSync("/nonexistent/builder/packages/sdk/vendor/sharp-stub", join(dir, "node_modules", "sharp"));
  writeFileSync(join(dir, "uses-sharp.mjs"), 'import sharp from "sharp";\nexport default sharp;\n');
  return dir;
}

function withRealSharp(dir: string): void {
  rmSync(join(dir, "node_modules", "sharp"));
  mkdirSync(join(dir, "node_modules", "sharp"));
  writeFileSync(join(dir, "node_modules", "sharp", "package.json"), JSON.stringify({ name: "sharp", type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", "sharp", "index.js"), 'export default function sharp() { return "REAL"; }\n');
}

async function importInChild(dir: string, importer: string, registerFirst: boolean): Promise<string> {
  const script = `
    ${registerFirst ? `(await import(${JSON.stringify(embeddingsUrl)})).registerSharpStub();` : ""}
    try {
      const sharp = (await import(${JSON.stringify(pathToFileURL(join(dir, importer)).href)})).default;
      try { console.log("CALLED " + sharp()); } catch (e) { console.log("STUB " + e.message); }
    } catch (e) {
      console.log("IMPORT_FAILED " + e.code);
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir });
  return stdout.trim();
}

const FROM_TRANSFORMERS = "node_modules/@xenova/transformers/src/utils/image.js";

test("without the hook, a broken sharp link fails to import (the bug this guards)", async () => {
  const dir = projectWithBrokenSharp();
  try {
    assert.match(await importInChild(dir, FROM_TRANSFORMERS, false), /^IMPORT_FAILED ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSharpStub() resolves @xenova/transformers' sharp to the SDK's own stub wherever the SDK is installed", async () => {
  const dir = projectWithBrokenSharp();
  try {
    assert.match(await importInChild(dir, FROM_TRANSFORMERS, true), /^STUB sharp is stubbed out in @berthos\/sdk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSharpStub() leaves an app's own import of sharp alone", async () => {
  const dir = projectWithBrokenSharp();
  try {
    withRealSharp(dir);
    assert.equal(await importInChild(dir, "uses-sharp.mjs", true), "CALLED REAL");
    // Same process shape, same registration: only the importer differs.
    assert.match(await importInChild(dir, FROM_TRANSFORMERS, true), /^STUB /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
