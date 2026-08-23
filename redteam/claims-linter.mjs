#!/usr/bin/env node
// BUILD_PLAN M2.4 — keeps docs/internal/claims.md honest, mechanically.
//
// The claims inventory is only worth anything if its "proving test" column
// stays true. This parses the inventory's claim tables and checks two things
// for every claim row:
//
//   1. Every test-path it cites (a `…​.mjs`/`.ts`/`.js`/`.sh` token) resolves to
//      a file that exists — a citation that rots when a test is renamed reads
//      exactly like a live one, which is the failure mode that happens quietly.
//   2. The row carries SOME evidence: a resolving test path, or one of the
//      honest no-milestone markers — UNPROVEN, "unit test", "transitively",
//      "by definition", or a threat-model reference for a documented
//      not-a-boundary row. A claim tagged as enforced with no evidence at all
//      is the thing this exists to catch.
//
// A claim row is identified by its id in the first column (K1, B15, H3, R6,
// U9 …), which cleanly excludes the tier-legend and vocabulary tables. Run in
// CI (redteam-milestone.yml) so a test rename that orphans a claim fails the
// build the same day.
//
//   node redteam/claims-linter.mjs
//
// It does not verify that a cited test actually asserts its claim — a human
// does that when the row is written. It verifies the citation resolves and the
// row is not silently evidence-free.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CLAIMS_PATH = join(REPO_ROOT, "docs", "internal", "claims.md");

/** Column-1 shape of a real claim row: K1, B15, H3, R6, U9 … */
const CLAIM_ID = /^\*?\*?([KBHRU]\d+)\./;
/** Honest states a row may be in without citing a resolvable test. */
const NO_TEST_MARKERS = [/\bUNPROVEN\b/i, /\bunit test\b/i, /\btransitively\b/i, /\bby definition\b/i, /threat-model\.md/i, /secrets-reference\.md/i];
const TEST_PATH = /`([^`]*\.(?:mjs|ts|js|sh))`/g;
const BARE_TEST_PATH = /(?:^|\s)([A-Za-z0-9_./-]+\.(?:mjs|ts|js|sh))(?=[\s,)]|$)/g;

function citedPaths(cell) {
  const paths = new Set();
  for (const m of cell.matchAll(TEST_PATH)) paths.add(m[1].trim());
  for (const m of cell.matchAll(BARE_TEST_PATH)) paths.add(m[1].trim());
  return [...paths];
}

function resolvesOnDisk(cite) {
  return [
    join(REPO_ROOT, cite),
    join(REPO_ROOT, "packages/docker-orchestrator/test", cite),
    join(REPO_ROOT, cite.replace(/^.*?\/((?:packages|breakout|bench|redteam|scripts|docs)\/.*)$/, "$1")),
  ].some((c) => existsSync(c));
}

function main() {
  if (!existsSync(CLAIMS_PATH)) {
    console.error(`claims-linter: ${CLAIMS_PATH} does not exist`);
    process.exit(1);
  }
  const lines = readFileSync(CLAIMS_PATH, "utf-8").split("\n");

  let claims = 0;
  let unproven = 0;
  const problems = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const idMatch = cells[0].match(CLAIM_ID);
    if (!idMatch) continue; // not a claim row (legend / vocab / header)

    claims += 1;
    const id = idMatch[1];
    const joined = cells.join(" ");

    const cites = citedPaths(joined);
    for (const cite of cites) {
      if (!resolvesOnDisk(cite)) problems.push(`${id}: cites "${cite}", which does not exist on disk`);
    }

    const hasMarker = NO_TEST_MARKERS.some((re) => re.test(joined));
    if (cites.length === 0 && !hasMarker) {
      problems.push(`${id}: tagged as a claim but cites no test and carries no honest no-test marker (UNPROVEN / unit test / transitively / documented)`);
    }
    if (/\bUNPROVEN\b/i.test(joined)) unproven += 1;
  }

  console.log(`claims-linter: ${claims} claim rows, ${unproven} UNPROVEN.`);
  if (problems.length > 0) {
    console.error("claims-linter: FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (claims === 0) {
    console.error("claims-linter: found no claim rows (expected rows keyed K1/B1/H1/R1/U1 …) — has the format changed?");
    process.exit(1);
  }
  console.log("claims-linter: OK — every cited test resolves, every claim row carries evidence.");
}

main();
