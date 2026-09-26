#!/usr/bin/env node
// A DELIBERATELY NON-CONFORMING adapter. It exists so the conformance suite can
// be shown to be falsifiable (SPEC 7.5): a suite no implementation can fail
// proves nothing about the ones that pass it.
//
// It is a plausible-looking implementation written from a skim of the spec,
// carrying five defects that are exactly the ones a real implementation makes:
//
//   1. filesystem scopes are only checked for being absolute, so
//      `filesystem:write:/` — the whole filesystem — is accepted, as are
//      `..` traversal and paths outside any allowlist.
//   2. the scope glob is compiled without escaping, so `.` matches any
//      character and `*.github.com` matches `axgithubxcom`.
//   3. `expose.preview` defaults to true, publishing an interactive URL for a
//      deployed app that only ever declared a capability.
//   4. `browser:navigate` is reported as kernel tier, which no proxy can be.
//      The suite does NOT catch this one, and that is the point: a tier claim
//      is not mechanically checkable from outside, which is why SPEC 7.1 says
//      passing the suite is necessary and not sufficient, and why the tier
//      table has to be backed by the implementation's own denial tests with
//      controls. Left in as the standing reminder.
//   5. errors are reported without a path, so a reader is told "invalid" and
//      left to find the line themselves.
//
// If a change to cases.json makes this adapter pass, the case is not testing
// what it claims to test. Extend the defects rather than weakening the case.

import { createInterface } from "node:readline";

const DESCRIBE = {
  implementation: "broken-by-design (negative control, not an implementation)",
  specVersion: "1.0.0",
  filesystemAllowlist: ["/workspace", "/context", "/tmp", "/app"],
  schemaVersion: 1,
  tiers: [
    { namespace: "filesystem", action: "write", tier: "kernel" },
    { namespace: "filesystem", action: "read", tier: "kernel" },
    { namespace: "network", action: "connect", tier: "kernel" },
    { namespace: "browser", action: "navigate", tier: "kernel" }, // defect 4
  ],
};

const CAPABILITY = /^[a-z0-9_-]+:[a-z0-9_-]+:.+$/;

function parse(capability) {
  const parts = String(capability).split(":");
  if (parts.length < 3) return null;
  return { namespace: parts[0], action: parts[1], scope: parts.slice(2).join(":") };
}

function validate(manifest) {
  const errors = [];
  const fail = (message) => errors.push({ message }); // defect 5: no path
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { valid: false, errors: [{ message: "not a mapping" }] };
  }
  if (typeof manifest.name !== "string" || !/^[a-z0-9-]+$/.test(manifest.name)) fail("bad name");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) fail("bad version");

  const capabilities = manifest.capabilities ?? [];
  if (!Array.isArray(capabilities)) fail("capabilities must be a list");
  else {
    for (const capability of capabilities) {
      if (typeof capability !== "string" || !CAPABILITY.test(capability)) { fail(`bad capability ${capability}`); continue; }
      const parsed = parse(capability);
      // defect 1: absolute is the only filesystem rule
      if (parsed.namespace === "filesystem" && !parsed.scope.startsWith("/")) fail("filesystem path must be absolute");
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    normalized: {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? "",
      capabilities,
      exports: manifest.exports ?? [],
      // defect 3: preview defaults on
      expose: { browser: true, terminal: true, preview: true, ...(manifest.expose ?? {}) },
      governs: manifest.governs ?? false,
      governance: { exempt: false, ...(manifest.governance ?? {}) },
      resources: manifest.resources ?? {},
    },
  };
}

function matches(granted, requested) {
  const g = parse(granted);
  const r = parse(requested);
  if (!g || !r) return false;
  if (g.namespace !== r.namespace || g.action !== r.action) return false;
  // defect 2: the scope is interpolated into a regex unescaped
  return new RegExp(`^${g.scope.replace(/\*/g, ".*")}$`).test(r.scope);
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line);
  let response;
  if (request.op === "describe") response = DESCRIBE;
  else if (request.op === "match") response = { matches: matches(request.granted, request.requested) };
  else if (request.op === "validate") response = validate(request.manifest);
  else if (request.op === "tier") {
    const row = DESCRIBE.tiers.find((t) => t.namespace === request.namespace && t.action === request.action);
    response = { tier: row ? row.tier : "unsupported" };
  } else response = { error: "unknown op" };
  process.stdout.write(JSON.stringify({ id: request.id, ...response }) + "\n");
});
