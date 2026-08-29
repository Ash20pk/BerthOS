#!/usr/bin/env node
// Conformance runner for the Attestation Record Specification.
//
// Usage:
//   node run.mjs --adapter "<command>" [--tags core,derivation,canonical,extended] [--json <path>]
//
// The adapter is any executable speaking the JSON-Lines protocol of SPEC.md
// section 8.2. This runner is deliberately dependency-free and implements as
// little of the specification as it can get away with — in particular it does
// NOT canonicalize or hash anything itself. Where a case needs a correctly
// sealed record, the runner asks the adapter under test for the digest and
// stamps that. A canonicalization bug therefore shows up in the `digest` cases,
// where it belongs, instead of making thirty unrelated shape cases fail for a
// reason nobody can read.
//
// Exit code is 0 only if every applicable case passed. A skipped case is
// reported and never counted as a pass.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUSES = ["ACTIVE", "NOT_ENFORCED", "UNDETERMINED"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const args = { tags: null, cases: resolve(HERE, "cases.json"), json: null, adapter: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--adapter") { args.adapter = value; i++; }
    else if (flag === "--tags") { args.tags = value.split(",").map((t) => t.trim()).filter(Boolean); i++; }
    else if (flag === "--cases") { args.cases = resolve(value); i++; }
    else if (flag === "--json") { args.json = resolve(value); i++; }
    else if (flag === "--help" || flag === "-h") { args.help = true; }
    else throw new Error(`unknown argument ${JSON.stringify(flag)}`);
  }
  return args;
}

/**
 * One adapter process for the whole run: requests go out as JSON Lines, and
 * responses are matched back by their `id` rather than by arrival order, so an
 * adapter that answers out of order is still judged on its answers. A response
 * that never arrives shows up as a failed case, not a hang — hence the timeout.
 */
class Adapter {
  constructor(command) {
    this.child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.child.on("error", (err) => this.failAll(new Error(`adapter failed to start: ${err.message}`)));
    this.child.on("exit", (code) => this.failAll(new Error(`adapter exited (code ${code}) with requests outstanding`)));
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (line.trim() === "") return;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        this.failAll(new Error(`adapter wrote a line that is not JSON: ${JSON.stringify(line.slice(0, 200))}`));
        return;
      }
      const waiter = this.pending.get(response.id);
      if (!waiter) return; // an unmatched id is the adapter's problem, surfaced by the timeout of whatever is waiting
      this.pending.delete(response.id);
      waiter.resolve(response);
    });
  }

  failAll(err) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
    this.dead = err;
  }

  send(request, timeoutMs = 15000) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    const line = JSON.stringify({ id, ...request });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`adapter did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.child.stdin.write(line + "\n");
    });
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const isMapping = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep merge, with one extra rule the corpus depends on: a `null` leaf deletes
 * the key. That is how a case says "this required field is absent" without the
 * corpus needing a second parallel notation for deletions — and it costs
 * nothing, because SPEC section 2.1 puts `null` outside the data model, so no
 * conforming record can carry one to be confused with a deletion marker.
 */
function applyPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (isMapping(value) && isMapping(target[key])) applyPatch(target[key], value);
    else target[key] = clone(value);
  }
  return target;
}

/** A record nested `depth` mappings deep — SPEC section 2.3 requires a verifier not to blow its stack on one. */
function deeplyNested(depth) {
  let node = { schemaVersion: 1 };
  for (let i = 0; i < depth; i++) node = { nested: node };
  return node;
}

/**
 * Builds the record a `verify` case is about. `seal` decides where the digest
 * lands relative to the mutation, which is the whole difference between "this
 * field is malformed" and "this record was edited after emission":
 *
 *   after  — mutate, then seal. The record is internally consistent, so only
 *            the defect under test can fail. Every shape case uses this.
 *   before — seal, then mutate. A genuine post-emission edit.
 *   none   — leave whatever the base and the patch put there. Used by cases
 *            that are about `recordSha256` itself.
 */
async function buildRecord(adapter, testCase, corpus) {
  if ("literal" in testCase) return clone(testCase.literal);
  if (testCase.literalDeep) return deeplyNested(testCase.literalDeep);

  const base = clone(corpus.records[testCase.record]);
  if (base === undefined) throw new Error(`case names base record ${JSON.stringify(testCase.record)}, which the corpus does not define`);
  const seal = testCase.seal ?? "after";

  if (seal === "before") {
    base.recordSha256 = await sealDigest(adapter, base);
    return testCase.patch ? applyPatch(base, testCase.patch) : base;
  }
  const record = testCase.patch ? applyPatch(base, testCase.patch) : base;
  if (seal === "after") record.recordSha256 = await sealDigest(adapter, record);
  return record;
}

async function sealDigest(adapter, record) {
  const response = await adapter.send({ op: "digest", record });
  if (typeof response.sha256 !== "string" || !SHA256_HEX.test(response.sha256)) {
    throw new Error(`adapter answered 'digest' with ${JSON.stringify(response.sha256)}, which is not 64 lowercase hex`);
  }
  return response.sha256;
}

async function runCase(adapter, testCase, corpus, describe) {
  const { op, expect } = testCase;

  if (op === "describe") {
    const problems = [];
    if (typeof describe.implementation !== "string" || describe.implementation === "") problems.push("missing 'implementation'");
    if (describe.specVersion !== corpus.specVersion) problems.push(`targets specVersion ${JSON.stringify(describe.specVersion)}, this corpus is ${corpus.specVersion}`);
    if (typeof describe.kind !== "string" || describe.kind === "") problems.push("missing 'kind' (SPEC 4.2: an implementation must document the constant it emits)");
    if (!Number.isInteger(describe.recordSchemaVersion) || describe.recordSchemaVersion < 0) problems.push("missing non-negative integer 'recordSchemaVersion'");
    if (!Array.isArray(describe.codes) || describe.codes.length === 0) problems.push("missing 'codes' (SPEC 8.2)");
    else if (!describe.codes.every((c) => typeof c === "string")) problems.push("'codes' must be strings");
    return problems.length === 0 ? { status: "pass" } : { status: "fail", detail: problems.join("; ") };
  }

  if (op === "derive") {
    const response = await adapter.send({ op: "derive", rulesetReports: testCase.rulesetReports, doctorProbe: testCase.doctorProbe });
    if (!STATUSES.includes(response.status)) {
      return { status: "fail", detail: `answered ${JSON.stringify(response.status)}, which is not one of ${STATUSES.join("|")}` };
    }
    return response.status === expect.status
      ? { status: "pass" }
      : { status: "fail", detail: `derived ${response.status}, expected ${expect.status} (probe ${testCase.doctorProbe.status}, ${testCase.rulesetReports.length} report(s))` };
  }

  if (op === "digest") {
    const response = await adapter.send({ op: "digest", record: testCase.record });
    if (response.sha256 === expect.sha256) return { status: "pass" };
    return {
      status: "fail",
      detail: `digest ${JSON.stringify(response.sha256)}, expected ${expect.sha256}${testCase.note ? ` — ${testCase.note}` : ""}`,
    };
  }

  if (op === "verify") {
    const record = await buildRecord(adapter, testCase, corpus);
    const response = await adapter.send({ op: "verify", record });
    if (typeof response.valid !== "boolean") return { status: "fail", detail: `expected a boolean 'valid', got ${JSON.stringify(response.valid)}` };

    if (expect.valid === true) {
      return response.valid
        ? { status: "pass" }
        : { status: "fail", detail: `rejected a record the spec requires it to accept: ${JSON.stringify(response.problems)}` };
    }

    if (response.valid) return { status: "fail", detail: "accepted a record the spec requires it to reject" };
    if (!Array.isArray(response.problems) || response.problems.length === 0) {
      return { status: "fail", detail: "rejected without reporting any problem (SPEC 2.3)" };
    }
    const reported = response.problems.map((p) => p?.code);
    if (!reported.every((c) => typeof c === "string" && c.length > 0)) {
      return { status: "fail", detail: `rejected with problems carrying no machine-readable code: ${JSON.stringify(response.problems)}` };
    }
    // Extra codes are permitted (SPEC 2.3): noticing more than the case demands
    // is not a failure. Missing one the case names is.
    const missing = (expect.codes ?? []).filter((code) => !reported.includes(code));
    if (missing.length > 0) {
      return { status: "fail", detail: `did not report ${missing.join(", ")}; reported ${reported.join(", ") || "(none)"}` };
    }
    return { status: "pass" };
  }

  return { status: "fail", detail: `unknown case op ${JSON.stringify(op)}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.adapter) {
    console.log(`usage: node run.mjs --adapter "<command>" [--tags core,derivation,canonical,extended] [--cases cases.json] [--json out.json]`);
    process.exit(args.help ? 0 : 2);
  }

  const corpus = JSON.parse(readFileSync(args.cases, "utf-8"));
  const adapter = new Adapter(args.adapter);

  let describe;
  try {
    describe = await adapter.send({ op: "describe" });
  } catch (err) {
    console.error(`FATAL: adapter did not answer 'describe' — ${err.message}`);
    if (adapter.stderr) console.error(adapter.stderr);
    adapter.close();
    process.exit(1);
  }

  // An implementation may declare that it does not support an OPTIONAL level
  // (SPEC 8.4). It may not declare its way out of a required one.
  const declaredSkips = (describe.skipTags ?? []).filter((t) => t === "extended");
  const selected = corpus.cases.filter((c) => !args.tags || c.tags.some((t) => args.tags.includes(t)));

  console.log(`Attestation Record conformance ${corpus.specVersion}`);
  console.log(`implementation: ${describe.implementation} (targets spec ${describe.specVersion}, record schemaVersion ${describe.recordSchemaVersion}, kind ${JSON.stringify(describe.kind)})`);
  console.log(`${selected.length} of ${corpus.cases.length} cases selected${args.tags ? ` (tags: ${args.tags.join(",")})` : ""}\n`);

  const results = [];
  for (const testCase of selected) {
    let result;
    if (declaredSkips.some((t) => testCase.tags.includes(t))) {
      result = { status: "skip", detail: `implementation declares it does not support the '${declaredSkips.join(",")}' level` };
    } else {
      try {
        result = await runCase(adapter, testCase, corpus, describe);
      } catch (err) {
        result = { status: "fail", detail: err.message };
      }
    }
    results.push({ id: testCase.id, tags: testCase.tags, ...result });
    if (result.status === "fail") console.log(`FAIL  ${testCase.id} — ${result.detail}`);
    else if (result.status === "skip") console.log(`SKIP  ${testCase.id} — ${result.detail}`);
  }
  adapter.close();

  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  const passed = results.length - failed.length - skipped.length;
  console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped (a skip is not a pass)`);

  if (args.json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.json, JSON.stringify({ specVersion: corpus.specVersion, implementation: describe, results }, null, 2) + "\n");
  }
  if (adapter.stderr.trim() && failed.length > 0) console.error(`\nadapter stderr:\n${adapter.stderr}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
