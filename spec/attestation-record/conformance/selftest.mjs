#!/usr/bin/env node
// The suite's own control (SPEC 8.5). Three runs, three required outcomes:
//
//   standalone verifier  MUST pass  — scripts/verify-attestation.mjs conforms
//   library verifier     MUST pass  — @berth/audit conforms, and by running the
//                                     same corpus through both, the two
//                                     reference implementations are shown not
//                                     to have drifted apart
//   broken adapter       MUST fail  — the suite can actually fail something
//
// Any expectation unmet exits non-zero. The last one is the one that matters:
// it is what keeps "Berth passes its own conformance suite" from being a
// sentence about a suite that passes everything.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "run.mjs");

function run(adapterArgs) {
  const result = spawnSync(process.execPath, [RUNNER, "--adapter", `${process.execPath} ${adapterArgs}`], {
    encoding: "utf-8",
    cwd: HERE,
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

let failures = 0;

for (const [label, args] of [
  ["standalone verifier", `${resolve(HERE, "adapters/berth.mjs")} --impl standalone`],
  ["library verifier", `${resolve(HERE, "adapters/berth.mjs")} --impl library`],
]) {
  const result = run(args);
  console.log(result.out.trimEnd());
  if (result.code === 0) {
    console.log(`\nOK   ${label} passes the suite\n`);
  } else {
    console.log(`\nFAIL ${label} did not pass (exit ${result.code}) — Berth does not conform to its own spec\n`);
    failures++;
  }
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
