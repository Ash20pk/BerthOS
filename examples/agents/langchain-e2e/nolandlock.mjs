/**
 * Berth on a host that can't enforce Landlock.
 *
 * Docker Desktop's VM is the usual example; here the same condition is made
 * on an enforcing host the way CI's attestation milestone does it: a seccomp
 * profile under which the three landlock_* syscalls return ENOSYS, exactly
 * what agent-init sees on a kernel without Landlock. Everything else is
 * untouched.
 *
 *   node examples/agents/langchain-e2e/nolandlock.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const REPO = resolve(new URL("../../..", import.meta.url).pathname);
// This folder doesn't depend on the orchestrator packages; load them from the checkout.
const Docker = createRequire(join(REPO, "packages/docker-orchestrator/package.json"))("dockerode");
const { loadManifest } = await import(join(REPO, "packages/manifest-schema/dist/index.js"));
const { buildImage, startContainer, stopContainer } = await import(join(REPO, "packages/docker-orchestrator/dist/index.js"));
const OUT_DIR = process.env.E2E_OUT_DIR ?? join(homedir(), "berth-agent-e2e");
const BERTH = join(REPO, "packages/cli/bin/berth.js");
const APP_DIR = join(REPO, "apps/filesystem");
const NO_LANDLOCK = JSON.stringify({
  defaultAction: "SCMP_ACT_ALLOW",
  syscalls: [{ names: ["landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self"], action: "SCMP_ACT_ERRNO", errnoRet: 38 }],
});
const docker = new Docker();
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const G = "No Landlock (seccomp control)";
async function scenario(s, run) {
  const started = Date.now();
  let verdict;
  try {
    verdict = await run();
  } catch (err) {
    verdict = { status: "Fail", actual: `Scenario errored: ${err instanceof Error ? err.message : String(err)}` };
  }
  const status = verdict.status ?? (verdict.pass ? "Pass" : "Fail");
  results.push({ id: s.id, group: G, name: s.name, steps: s.steps, expected: s.expected, status, actual: verdict.actual, note: verdict.note, toolCalls: [], toolOutputs: [], answer: "", ms: Date.now() - started });
  console.log(`${status.padEnd(4)}  ${s.id}. ${s.name}\n        ${verdict.actual}`);
  writeFileSync(join(OUT_DIR, "nolandlock-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}
const clip = (s, n = 220) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const logsOf = async (container) => {
  const buf = await container.logs({ stdout: true, stderr: true });
  return buf.toString("utf-8").replace(/[^\x09\x0a\x20-\x7e]/g, "");
};
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const manifest = await loadManifest(join(APP_DIR, "berth.yml"));

// --- 1. A production image refuses to run unenforced ------------------------
await scenario(
  {
    id: 701,
    name: "A production sandbox refuses to run where the kernel can't enforce",
    steps: "Build apps/filesystem's production image and boot it with the landlock syscalls ENOSYSed.",
    expected: "agent-init refuses to exec the app (capability_enforcement_refused) and the container exits non-zero: no unrestricted run.",
  },
  async () => {
    await buildImage({ appDir: APP_DIR, tag: "berth/filesystem:nolandlock-prod", target: "production", docker });
    const running = await startContainer({ image: "berth/filesystem:nolandlock-prod", name: "berth-nolandlock-prod", manifest, workingDir: "/app", extraSecurityOpt: [`seccomp=${NO_LANDLOCK}`], docker });
    try {
      await waitFor(async () => !(await running.container.inspect()).State.Running, 30_000);
      const state = (await running.container.inspect()).State;
      const log = await logsOf(running.container);
      const refused = /capability_enforcement_refused/.test(log);
      const ran = /"filesystem" ready/.test(log);
      return { pass: refused && !ran && state.ExitCode !== 0, actual: `exit code ${state.ExitCode}; refusal logged: ${refused}; app reached ready: ${ran}. ${clip(log.split("\n").find((l) => /FATAL|refus/.test(l)) ?? "", 200)}` };
    } finally {
      await stopContainer(running.container).catch(() => {});
    }
  },
);

// --- 2-4. A dev sandbox runs, says so, and attests NOT_ENFORCED -------------
const CONTAINER = "berth-dev-nolandlock";
const DEV_WS = join(REPO, ".berth", "dev-workspace");
mkdirSync(DEV_WS, { recursive: true });
await buildImage({ appDir: APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });
await docker.getContainer(CONTAINER).remove({ force: true }).catch(() => {});
const dev = await startContainer({
  image: "berth/filesystem:dev",
  name: CONTAINER,
  manifest,
  bindMount: { hostPath: REPO, containerPath: "/workspace" },
  extraBinds: [`${DEV_WS}:/workspace/.berth/dev-workspace`],
  workingDir: "/workspace/apps/filesystem",
  env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" },
  extraSecurityOpt: [`seccomp=${NO_LANDLOCK}`],
  docker,
});
try {
  await waitFor(async () => /"filesystem" ready/.test(await logsOf(dev.container)), 60_000);

  await scenario(
    {
      id: 702,
      name: "A dev sandbox runs, and says it isn't enforcing",
      steps: "Boot the dev image the same way (dev images don't set BERTH_REQUIRE_ENFORCEMENT). Check the container log.",
      expected: "The app runs; agent-init reports the ruleset as NotEnforced and warns that it runs unrestricted.",
    },
    async () => {
      const log = await logsOf(dev.container);
      const line = log.split("\n").find((l) => /agent-init\].*(NotEnforced|not enforced|unrestricted|WARNING)/i.test(l));
      const ready = /"filesystem" ready/.test(log);
      return { pass: ready && Boolean(line), actual: `ready: ${ready}; ${clip(line ?? "no warning found", 220)}` };
    },
  );

  // berth mcp attached to that container, with an audit trail.
  const auditFile = join(OUT_DIR, "nolandlock-audit.jsonl");
  rmSync(auditFile, { force: true });
  const runId = `nolandlock-${Date.now()}`;
  const mcp = spawn("node", [BERTH, "mcp", "--app", "filesystem", "--app-dir", APP_DIR, "--container", CONTAINER, "--no-boot", "--audit-file", auditFile, "--run-id", runId], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  mcp.stderr.on("data", (d) => (stderr += d));
  let buffered = "";
  const pending = new Map();
  mcp.stdout.on("data", (d) => {
    buffered += d;
    let i;
    while ((i = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, i);
      buffered = buffered.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      } catch {}
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nolandlock-check", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  await scenario(
    {
      id: 703,
      name: "A refusal on an unenforcing host isn't passed off as the kernel's",
      steps: "Over berth mcp, write ../../../etc/berth-nolandlock.txt. Check the explanation's denied-by line and berth mcp's own enforcement line.",
      expected: "berth mcp reports kernel enforcement as not enforced; whatever stops the write, the explanation doesn't claim Landlock did.",
    },
    async () => {
      const res = await rpc("tools/call", { name: "write_file", arguments: { path: "../../../etc/berth-nolandlock.txt", content: "x" } });
      const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
      const exists = execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "test -e /etc/berth-nolandlock.txt && echo yes || echo no"], { encoding: "utf-8" }).trim();
      const enforcementLine = stderr.split("\n").find((l) => /kernel enforcement in this container/.test(l)) ?? "";
      const deniedBy = text.split("\n").find((l) => /^denied-by:/.test(l)) ?? "";
      const claimsKernel = /denied-by: the kernel/.test(text);
      return {
        pass: /not-enforced|partially/.test(enforcementLine) && !claimsKernel,
        actual: `${clip(enforcementLine, 100)} | file written: ${exists} | ${clip(deniedBy || text.split("\n")[0], 180)}`,
        note: exists === "no" ? "The write was still refused, by ordinary file permissions: the app runs as its own uid, which doesn't own /etc. Only Landlock stops writes to paths that uid can write." : "The write outside the workspace succeeded: without Landlock, only file ownership stands in the way.",
      };
    },
  );
  mcp.stdin.end();
  await new Promise((r) => mcp.once("exit", r));

  await scenario(
    {
      id: 704,
      name: "berth attest on that session says NOT_ENFORCED",
      steps: "berth attest <runId> --file <audit>, then scripts/verify-attestation.mjs on the record.",
      expected: "The record is emitted with enforcement NOT_ENFORCED and a reason, and the standalone verifier accepts it as internally consistent.",
    },
    async () => {
      const out = join(OUT_DIR, "nolandlock.attestation.json");
      rmSync(out, { force: true });
      let attestOut = "";
      try {
        attestOut = execFileSync("node", [BERTH, "attest", runId, "--file", auditFile, "--out", out], { cwd: REPO, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        attestOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
      if (!existsSync(out)) return { pass: false, actual: `no record: ${clip(attestOut, 200)}` };
      const record = JSON.parse(readFileSync(out, "utf-8"));
      let verify = "";
      try {
        verify = execFileSync("node", ["scripts/verify-attestation.mjs", out], { cwd: REPO, encoding: "utf-8" });
      } catch (err) {
        verify = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
      return {
        pass: record.enforcement?.status === "NOT_ENFORCED" && /^OK/.test(verify),
        actual: `status ${record.enforcement?.status}; reasons: ${clip(JSON.stringify(record.enforcement?.reasons), 160)}; verifier: ${clip(verify.split("\n")[0], 90)}`,
      };
    },
  );
} finally {
  await stopContainer(dev.container).catch(() => {});
}

const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count("Pass")} passed, ${count("Fail")} failed, of ${results.length}.`);
process.exit(0);
