#!/usr/bin/env node
// Conformance runner for the Capability Manifest Specification.
//
// Usage:
//   node run.mjs --adapter "<command>" [--tags core,tiers,extended] [--json <path>]
//
// The adapter is any executable speaking the JSON-Lines protocol of SPEC.md
// section 7.2. This runner is deliberately dependency-free and knows nothing
// about any particular implementation: everything it needs about the
// implementation under test comes from that implementation's own `describe`
// response (its filesystem allowlist, its current schema version, its tier
// table). An implementation with a different allowlist is judged against what
// it declares, not against the reference values.
//
// Exit code is 0 only if every applicable case passed. A skipped case is
// reported and never counted as a pass.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const TIERS = ["kernel", "broker", "recorded", "unenforced"];

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

const samePath = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A path matches if the adapter reported it exactly, or reported something more
 * specific beneath it (`["exports",0,"input","a"]` satisfies an expectation of
 * `["exports",0,"input"]`). A *less* specific path does not match: SPEC section
 * 6 requires the index of the offending entry, so an implementation that
 * reports only `["capabilities"]` for a bad entry has failed the case it would
 * otherwise slip past.
 */
function pathReported(errors, expected) {
  if (!Array.isArray(errors)) return false;
  return errors.some((error) => {
    const actual = error?.path;
    if (!Array.isArray(actual)) return false;
    return actual.length >= expected.length && samePath(actual.slice(0, expected.length), expected);
  });
}

/** Deep-compares only the keys the expectation names — extra fields are the implementation's business. */
function subsetMismatch(expected, actual, prefix = "") {
  if (Array.isArray(expected) || expected === null || typeof expected !== "object") {
    return JSON.stringify(expected) === JSON.stringify(actual) ? null : `${prefix || "value"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (actual === null || typeof actual !== "object") return `${prefix || "value"}: expected a mapping, got ${JSON.stringify(actual)}`;
  for (const [key, value] of Object.entries(expected)) {
    const mismatch = subsetMismatch(value, actual[key], prefix ? `${prefix}.${key}` : key);
    if (mismatch) return mismatch;
  }
  return null;
}

/** Is `path` inside the allowlist the adapter declared? Segment-aware, as SPEC 3.4 rule 6 requires. */
function insideAllowlist(path, allowlist) {
  const bare = path.endsWith("/*") ? path.slice(0, -2) : path;
  return allowlist.some((entry) => bare === entry || bare.startsWith(`${entry}/`));
}

function substituteMarkers(manifest, describe) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return manifest;
  const out = { ...manifest };
  if (out.schema_version === "@current") out.schema_version = describe.schemaVersion;
  if (out.schema_version === "@future") out.schema_version = describe.schemaVersion + 1;
  return out;
}

async function runCase(adapter, testCase, describe) {
  const { op, expect } = testCase;

  if (op === "match") {
    const response = await adapter.send({ op: "match", granted: testCase.granted, requested: testCase.requested });
    if (typeof response.matches !== "boolean") return { status: "fail", detail: `expected a boolean 'matches', got ${JSON.stringify(response.matches)}` };
    return response.matches === expect.matches
      ? { status: "pass" }
      : { status: "fail", detail: `matches(${JSON.stringify(testCase.granted)}, ${JSON.stringify(testCase.requested)}) = ${response.matches}, expected ${expect.matches}` };
  }

  if (op === "validate") {
    // Allowlist-dependent cases only mean something for an implementation whose
    // declared allowlist actually excludes the path under test.
    if (testCase.tags.includes("allowlist-dependent")) {
      const scope = String(testCase.manifest?.capabilities?.[0] ?? "").split(":").slice(2).join(":");
      if (insideAllowlist(scope, describe.filesystemAllowlist ?? [])) {
        return { status: "skip", detail: `${scope} is inside this implementation's declared allowlist` };
      }
    }
    const manifest = substituteMarkers(testCase.manifest, describe);
    const response = await adapter.send({ op: "validate", manifest });
    if (typeof response.valid !== "boolean") return { status: "fail", detail: `expected a boolean 'valid', got ${JSON.stringify(response.valid)}` };
    if (response.valid !== expect.valid) {
      const why = response.valid ? "accepted a manifest the spec requires it to reject" : `rejected a manifest the spec requires it to accept: ${JSON.stringify(response.errors)}`;
      return { status: "fail", detail: why };
    }
    if (expect.valid === false) {
      if (!Array.isArray(response.errors) || response.errors.length === 0) return { status: "fail", detail: "rejected without reporting any error" };
      if (expect.path.length > 0 && !pathReported(response.errors, expect.path)) {
        return { status: "fail", detail: `no error reported at path ${JSON.stringify(expect.path)}; got ${JSON.stringify(response.errors.map((e) => e.path))}` };
      }
      return { status: "pass" };
    }
    if (expect.normalized) {
      if (response.normalized === undefined) return { status: "fail", detail: "valid, but returned no normalized manifest" };
      const mismatch = subsetMismatch(expect.normalized, response.normalized);
      if (mismatch) return { status: "fail", detail: `normalized ${mismatch}` };
    }
    return { status: "pass" };
  }

  if (op === "describe") {
    const problems = [];
    if (typeof describe.implementation !== "string" || describe.implementation === "") problems.push("missing 'implementation'");
    // Minor versions are additive (SPEC.md §10): a 1.0.0 implementation is
    // still measured against a 1.x corpus, and fails only what it doesn't do.
    if (!/^1\.\d+\.\d+$/.test(String(describe.specVersion))) problems.push(`targets specVersion ${JSON.stringify(describe.specVersion)}, this corpus is 1.x`);
    if (!Array.isArray(describe.filesystemAllowlist) || describe.filesystemAllowlist.length === 0) problems.push("missing 'filesystemAllowlist'");
    else if (!describe.filesystemAllowlist.every((p) => typeof p === "string" && p.startsWith("/"))) problems.push("'filesystemAllowlist' must be absolute paths");
    if (!Number.isInteger(describe.schemaVersion) || describe.schemaVersion < 0) problems.push("missing non-negative integer 'schemaVersion'");
    if (!Array.isArray(describe.tiers) || describe.tiers.length === 0) problems.push("missing 'tiers' (SPEC 5.2: the tier table is mandatory)");
    else {
      for (const entry of describe.tiers) {
        if (typeof entry?.namespace !== "string" || typeof entry?.action !== "string") problems.push(`tier entry without namespace/action: ${JSON.stringify(entry)}`);
        else if (!TIERS.includes(entry.tier)) problems.push(`${entry.namespace}:${entry.action} declares tier ${JSON.stringify(entry.tier)}, not one of ${TIERS.join("|")}`);
      }
    }
    return problems.length === 0 ? { status: "pass" } : { status: "fail", detail: problems.join("; ") };
  }

  if (op === "tier") {
    const response = await adapter.send({ op: "tier", namespace: testCase.namespace, action: testCase.action });
    const declared = (describe.tiers ?? []).find((t) => t.namespace === testCase.namespace && t.action === testCase.action);
    if (!expect.oneOf.includes(response.tier)) {
      return { status: "fail", detail: `${testCase.namespace}:${testCase.action} answered ${JSON.stringify(response.tier)}, expected one of ${expect.oneOf.join("|")}` };
    }
    if (expect.consistentWithDescribe) {
      if (declared && declared.tier !== response.tier) {
        return { status: "fail", detail: `describe says ${declared.tier}, tier says ${response.tier} — the table and the answer must agree` };
      }
      if (!declared && response.tier !== "unsupported") {
        return { status: "fail", detail: `answered ${response.tier} for a capability absent from its own tier table` };
      }
    }
    return { status: "pass" };
  }

  return { status: "fail", detail: `unknown case op ${JSON.stringify(op)}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.adapter) {
    console.log(`usage: node run.mjs --adapter "<command>" [--tags core,tiers,extended] [--cases cases.json] [--json out.json]`);
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

  const selected = corpus.cases.filter((c) => !args.tags || c.tags.some((t) => args.tags.includes(t)));
  console.log(`Capability Manifest conformance ${corpus.specVersion}`);
  console.log(`implementation: ${describe.implementation} (targets spec ${describe.specVersion}, manifest schema_version ${describe.schemaVersion})`);
  console.log(`allowlist: ${(describe.filesystemAllowlist ?? []).join(" ")}`);
  console.log(`${selected.length} of ${corpus.cases.length} cases selected${args.tags ? ` (tags: ${args.tags.join(",")})` : ""}\n`);

  const results = [];
  for (const testCase of selected) {
    let result;
    try {
      result = await runCase(adapter, testCase, describe);
    } catch (err) {
      result = { status: "fail", detail: err.message };
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
