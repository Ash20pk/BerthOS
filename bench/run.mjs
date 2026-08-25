#!/usr/bin/env node
// BUILD_PLAN M2.2 — the containment benchmark runner.
//
//   node bench/run.mjs                              every locally runnable harness
//   node bench/run.mjs --harness docker,berth       just these
//   node bench/run.mjs --out results.json --md table.md
//
// Each harness gets the same probe (bench/probe/probe.mjs), the same
// environment contract, and the same host listener to try to reach. What
// differs between columns is only the sandbox.
//
// Two things this runner does on purpose:
//
//   1. It opens a real TCP listener on the host for the duration of the run,
//      so "can the workload reach your machine" is a deterministic question
//      rather than one that depends on what happens to be listening.
//   2. It never converts a failure to measure into a pass. A harness that
//      throws is recorded as failed, with the error in the results file and
//      NOT RUN in its column.

import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { CHECKS, PROBE_CHECK_IDS } from "./checks.mjs";
import { renderMarkdown, scoreHarness } from "./score.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PROBE_DIR = join(__dirname, "probe");

function parseArgs(argv) {
  const args = { harnesses: undefined, out: join(__dirname, "results", "results.json"), md: join(__dirname, "results", "table.md") };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--harness") args.harnesses = argv[++i].split(",").map((s) => s.trim());
    else if (arg === "--out") args.out = resolve(argv[++i]);
    else if (arg === "--md") args.md = resolve(argv[++i]);
    else if (arg === "--help") args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/**
 * A listener on the host, for the host-reach row. Bound on 0.0.0.0 because
 * the sandbox reaches it through the docker gateway, not through loopback.
 */
function startHostListener() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((socket) => {
      socket.end("the benchmark's host listener\n");
    });
    server.on("error", reject);
    server.listen(0, "0.0.0.0", () => resolvePromise({ server, port: server.address().port }));
  });
}

async function loadHarnesses(ids) {
  const { harness: docker } = await import("./harnesses/docker.mjs");
  const { harness: berth, weakenedHarness } = await import("./harnesses/berth.mjs");
  const { harness: e2b } = await import("./harnesses/e2b.mjs");
  const all = [docker, berth, weakenedHarness, e2b];
  if (!ids) return all;
  return ids.map((id) => {
    const found = all.find((h) => h.id === id);
    if (!found) throw new Error(`unknown harness "${id}" — known: ${all.map((h) => h.id).join(", ")}`);
    return found;
  });
}

/**
 * Rows a harness has no surface for come back from the probe as unmeasured
 * with a "this harness runs one workload per sandbox"-shaped reason. Those
 * are not-applicable, which is scored differently from "we tried and could
 * not tell" — conflating them would let a single-tenant harness bank the
 * co-tenancy rows it never faced.
 */
const NOT_APPLICABLE_HINTS = [/no BENCH_SIBLING_DIR/, /no BENCH_SIBLING_SOCKET/, /no BENCH_FOREIGN_SECRET_PATH/];

function normalizeResults(probeResults, observations) {
  const merged = { ...(probeResults ?? {}), ...(observations ?? {}) };
  for (const [id, result] of Object.entries(merged)) {
    if (result?.outcome === "unmeasured" && NOT_APPLICABLE_HINTS.some((re) => re.test(result.detail ?? ""))) {
      merged[id] = { ...result, outcome: "not-applicable" };
    }
  }
  return merged;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("usage: node bench/run.mjs [--harness docker,berth,berth-weakened,e2b] [--out results.json] [--md table.md]");
    return;
  }

  const harnesses = await loadHarnesses(args.harnesses);
  const secretValue = `bench-canary-${randomBytes(12).toString("hex")}`;
  const { server, port } = await startHostListener();
  // The name every harness's sandbox can resolve back to this machine.
  const hostEndpoint = `host.docker.internal:${port}`;
  console.log(`Host listener for the host-reach row: ${hostEndpoint}`);

  let hostInfo = {};
  try {
    const info = await new Docker().info();
    hostInfo = { kernelVersion: info.KernelVersion, operatingSystem: info.OperatingSystem, serverVersion: info.ServerVersion };
  } catch {
    // A run with no Docker can still produce an honest NOT RUN table.
  }

  const results = [];
  try {
    for (const harness of harnesses) {
      const unavailable = harness.unavailableReason?.();
      if (unavailable) {
        console.log(`\n=== ${harness.title} — SKIPPED: ${unavailable} ===`);
        results.push({ id: harness.id, title: harness.title, description: harness.description, skipped: unavailable, results: {} });
        continue;
      }

      console.log(`\n=== ${harness.title} ===`);
      const log = (message) => console.log(`  [${harness.id}] ${message}`);
      try {
        const outcome = await harness.run({ repoRoot: REPO_ROOT, probeDir: PROBE_DIR, hostEndpoint, secretValue, log });
        const normalized = normalizeResults(outcome.probeResults, outcome.observations);
        results.push({ id: harness.id, title: harness.title, description: harness.description, meta: outcome.meta, results: normalized });
        const score = scoreHarness({ results: normalized });
        console.log(`  → ${score.contained} contained, ${score.escaped} escaped, ${score.unmeasured} unmeasured, ${score.notApplicable} n/a`);
      } catch (err) {
        console.error(`  → FAILED: ${err.message}`);
        results.push({ id: harness.id, title: harness.title, description: harness.description, error: err.message, results: {} });
      }
    }
  } finally {
    server.close();
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, ...hostInfo },
    checks: CHECKS.map(({ id, title, kind, question }) => ({ id, title, kind, question })),
    harnesses: results,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  mkdirSync(dirname(args.md), { recursive: true });
  writeFileSync(args.md, renderMarkdown(report));
  console.log(`\nWrote ${args.out} and ${args.md}`);

  // The positive control is an assertion, not a note: if switching Berth's
  // kernel tier off does not make it score worse, the benchmark is not
  // measuring what it claims to.
  const berth = results.find((r) => r.id === "berth");
  const weakened = results.find((r) => r.id === "berth-weakened");
  if (berth && weakened && !berth.error && !weakened.error && !berth.skipped && !weakened.skipped) {
    const strong = scoreHarness(berth);
    const weak = scoreHarness(weakened);
    if (weak.contained >= strong.contained) {
      console.error(
        `\nPOSITIVE CONTROL FAILED: the weakened Berth config contained ${weak.contained} rows, the shipped one ${strong.contained}. ` +
          `Switching the kernel tier off must lose rows — either the weakening did not take effect, or these rows never depended on it.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Positive control OK: weakening Berth dropped it from ${strong.contained} contained rows to ${weak.contained}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
