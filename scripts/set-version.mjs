#!/usr/bin/env node
// Sets one version on everything the release workflow publishes, in lockstep:
// every non-private workspace package.json, the root package.json, and the
// Python SDK's pyproject.toml. The agent framework under experimental/ is
// private on npm and unpublished on PyPI, so it keeps its own version. Run by .github/workflows/release.yml; safe
// to run locally to see what a release would change (it only edits files).
//
//   node scripts/set-version.mjs 0.2.0            # write
//   node scripts/set-version.mjs 0.2.0 --check    # exit 1 unless already at 0.2.0
//
// Internal @berthos/* dependencies use the workspace: protocol, which
// `pnpm publish` rewrites to the published version, so they need no edit here.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

const PYPROJECTS = ["packages/sdk-python/pyproject.toml"];
// Plain x.y.z only. A pre-release would need two spellings (npm's 0.2.0-rc.1,
// PEP 440's 0.2.0rc1) and an npm dist-tag other than latest; not worth it yet.
const SEMVER = /^\d+\.\d+\.\d+$/;

const [version, flag] = process.argv.slice(2);
if (!version || !SEMVER.test(version)) {
  console.error(`usage: set-version.mjs <x.y.z> [--check]  (got ${JSON.stringify(version)})`);
  process.exit(2);
}
const check = flag === "--check";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// pnpm's own view of the workspace, so a package added to pnpm-workspace.yaml
// is picked up without touching this script.
const workspace = JSON.parse(execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" }));
const manifests = [join(root, "package.json")];
for (const pkg of workspace) {
  const file = join(pkg.path, "package.json");
  if (file !== manifests[0] && !JSON.parse(readFileSync(file, "utf8")).private) manifests.push(file);
}

const stale = [];
for (const file of manifests) {
  const text = readFileSync(file, "utf8");
  const json = JSON.parse(text);
  if (json.version === version) continue;
  stale.push(`${relative(root, file)}: ${json.version}`);
  if (!check) {
    // Replace the one field in place, so the file's formatting survives.
    const updated = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
    // The first "version" key is the top-level one in every manifest here;
    // re-parse rather than trust that, so a nested key can't take the edit.
    if (JSON.parse(updated).version !== version) throw new Error(`${relative(root, file)}: could not set the top-level version`);
    writeFileSync(file, updated);
  }
}

for (const rel of PYPROJECTS) {
  const file = join(root, rel);
  const text = readFileSync(file, "utf8");
  const current = text.match(/^version\s*=\s*"([^"]*)"/m)?.[1];
  if (current === undefined) throw new Error(`${rel}: no [project] version line`);
  if (current === version) continue;
  stale.push(`${rel}: ${current}`);
  if (!check) writeFileSync(file, text.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${version}"`));
}

if (check && stale.length) {
  console.error(`not at ${version}:\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
console.log(stale.length ? `${check ? "would set" : "set"} ${version} on:\n  ${stale.join("\n  ")}` : `already at ${version}`);
