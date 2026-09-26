#!/usr/bin/env node
// The suite's own control (SPEC 7.5). Two runs, two required outcomes:
//
//   reference adapter  MUST pass   — Berth conforms to the spec it wrote
//   broken adapter     MUST fail   — the suite can actually fail something
//
// Either expectation unmet exits non-zero. The second half is the one that
// matters: it is what keeps "Berth passes its own conformance suite" from being
// a sentence about a suite that passes everything.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "run.mjs");

function run(adapterPath) {
  const result = spawnSync(process.execPath, [RUNNER, "--adapter", `${process.execPath} ${adapterPath}`], {
    encoding: "utf-8",
    cwd: HERE,
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

let failures = 0;

const reference = run(resolve(HERE, "adapters/berth.mjs"));
console.log(reference.out.trimEnd());
if (reference.code === 0) {
  console.log("\nOK   reference adapter passes the suite");
} else {
  console.log(`\nFAIL reference adapter did not pass (exit ${reference.code}) — Berth does not conform to its own spec`);
  failures++;
}

const broken = run(resolve(HERE, "adapters/broken.mjs"));
if (broken.code !== 0) {
  const failed = [...broken.out.matchAll(/^FAIL {2}(\S+)/gm)].map((m) => m[1]);
  console.log(`OK   broken adapter fails the suite on ${failed.length} case(s) — the suite is falsifiable`);
  console.log(`     ${failed.slice(0, 12).join(", ")}${failed.length > 12 ? ", ..." : ""}`);
} else {
  console.log("FAIL broken adapter PASSED — the suite cannot fail anything, so it proves nothing");
  console.log(broken.out.trimEnd());
  failures++;
}

process.exit(failures === 0 ? 0 : 1);
