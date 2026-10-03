#!/usr/bin/env node
// End to end for the CLI's local microVM runtime, on a real VM:
//
//   berth vm install --from <artifacts>   pinned kernel + rootfs into ~/.berth/vm, verified
//   berth doctor --sandbox vm             every VM check passes
//   berth dev --runtime vm                on a copy of apps/notes outside the repo (no
//                                         node_modules: the SDK comes from the CLI), calls
//                                         over berth rpc, a real edit reboots, a comment-only
//                                         edit doesn't, /workspace survives the reboot
//   berth mcp --runtime vm                a real MCP client: initialize, tools/list,
//                                         tools/call; time from spawn to the first answer
//   berth dev --runtime vm --env          secrets: a declared one reaches its app alone, an
//                                         undeclared one every app; neither is in /proc/cmdline,
//                                         another app's environ, a device node, a log, or the
//                                         run dir once the sandbox is ready
//   berth dev --runtime vm (python)       a runtime: python app: its exports answer, it may
//                                         write where it declared and nowhere else, and a
//                                         declared secret reaches it
//   berth dev --runtime vm (/context)     a copy of apps/filesystem: a context file written,
//                                         tagged and found by query, attributed by the kernel's
//                                         identity (fs-e2e) though the app calls itself
//                                         "filesystem"; after berth dev restarts, the file and
//                                         its tag are still there (state disk)
//   berth mcp --runtime vm --env           a declared secret reaches the app through MCP's
//                                         own boot, and an attach says --env was not applied
//   berth attest <run>                    ACTIVE, isolation microvm, and the shipped
//                                         verifier accepts the record
//
// Usage: node packages/cli/test/vm-e2e.mjs [--from DIR] [--vmm PATH] [--rounds N]
// Defaults: --from $BERTH_VMM_ARTIFACTS; --vmm whatever `berth doctor` finds.
// Nothing outside ~/.berth (or $BERTH_HOME) and a temp dir is written; the sandboxes are named
// berth-dev-notes-e2e and stopped at the end.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const repo = resolve(cliDir, "..", "..");
const berth = join(cliDir, "bin", "berth.js");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const from = arg("--from", process.env.BERTH_VMM_ARTIFACTS);
const vmmArg = arg("--vmm");
const rounds = Number(arg("--rounds", "3"));
const results = [];
const auditFile = join(mkdtempSync(join(tmpdir(), "berth-vm-e2e-audit-")), "audit.jsonl");
const timings = {};
const check = (name, pass, detail = "") => {
  results.push({ check: name, pass: !!pass, ...(detail ? { detail } : {}) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const run = (args, opts = {}) => spawnSync(process.execPath, [berth, ...args], { encoding: "utf8", ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// --- 1. install ------------------------------------------------------------
if (from) {
  const r = run(["vm", "install", "--from", from, "--no-download", ...(vmmArg ? ["--vmm", vmmArg] : [])]);
  check("berth vm install verifies kernel and rootfs", r.status === 0 && /kernel [0-9a-f]{16}… verified/.test(r.stdout) && /rootfs [0-9a-f]{16}… verified/.test(r.stdout), r.status === 0 ? "" : r.stdout + r.stderr);
}

// --- 2. doctor ---------------------------------------------------------------
{
  const r = run(["doctor", "--sandbox", "vm", "--json"]);
  let vm;
  try {
    vm = JSON.parse(r.stdout).vm;
  } catch {}
  check("berth doctor --sandbox vm: ready", r.status === 0 && vm?.ready === true, vm ? vm.checks.filter((c) => c.status !== "ok").map((c) => `${c.id}: ${c.detail}`).join("; ") : r.stderr);
  if (!vm?.ready) finish();
}

// --- 3. dev --------------------------------------------------------------------
// A copy of apps/notes outside the repo, renamed so it can't collide with a
// developer's own berth-dev-notes.
const work = mkdtempSync(join(tmpdir(), "berth-vm-e2e-"));
const app = join(work, "notes-e2e");
cpSync(join(repo, "apps", "notes", "src"), join(app, "src"), { recursive: true });
cpSync(join(repo, "apps", "notes", "package.json"), join(app, "package.json"));
writeFileSync(join(app, "berth.yml"), readFileSync(join(repo, "apps", "notes", "berth.yml"), "utf8").replace(/^name: notes$/m, "name: notes-e2e"));
const name = "notes-e2e";
const sandbox = `berth-dev-${name}`;
run(["vm", "stop", sandbox]);

let devOut = "";
const dev = spawn(process.execPath, [berth, "dev", "--runtime", "vm"], { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
dev.stdout.on("data", (d) => (devOut += d));
dev.stderr.on("data", (d) => (devOut += d));
const waitFor = async (re, ms = 30_000, after = 0) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = devOut.slice(after).match(re);
    if (m) return m;
    if (dev.exitCode !== null) return null;
    await sleep(50);
  }
  return null;
};
const t0 = Date.now();
const ready = await waitFor(/VM ready in (\d+) ms \(bundle (\d+) ms(, cached)?, boot (\d+) ms\)/, 60_000);
check("berth dev --runtime vm boots the app", ready, ready ? `ready ${ready[1]} ms (bundle ${ready[2]} ms${ready[3] ?? ""}, boot ${ready[4]} ms); ${Date.now() - t0} ms from spawn` : devOut.slice(-2000));
if (!ready) finish();
timings.devFirstBootMs = Number(ready[1]);
check("the SDK was resolved without the project's node_modules", !existsSync(join(app, "node_modules")));

const rpc = (exp, input) => {
  const r = run(["rpc", name, "--runtime", "vm", "--export", exp, ...(input ? ["--input", JSON.stringify(input)] : [])]);
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
};
const added = rpc("add_note", { text: "e2e: before reload" });
check("berth rpc --runtime vm: add_note", added.ok && /"id"/.test(added.out), added.err);
const listed = rpc("list_notes");
check("berth rpc --runtime vm: list_notes has it", listed.ok && listed.out.includes("e2e: before reload"), listed.err);

let mark = devOut.length;
appendFileSync(join(app, "src", "index.ts"), "\n// a comment changes no output\n");
const unchanged = await waitFor(/the bundle is unchanged \((\d+) ms\)/, 15_000, mark);
check("a comment-only edit doesn't reboot the VM", unchanged, unchanged ? `bundle check ${unchanged[1]} ms` : devOut.slice(mark));

const reloads = [];
for (let i = 0; i < rounds; i++) {
  mark = devOut.length;
  appendFileSync(join(app, "src", "index.ts"), `\nexport const e2eReloadMarker${i} = ${i};\n`);
  const m = await waitFor(/Reloaded in (\d+) ms \(bundle (\d+) ms, stop (\d+) ms, boot (\d+) ms\)/, 30_000, mark);
  if (!m) {
    check(`reload ${i + 1} after a real edit`, false, devOut.slice(mark));
    break;
  }
  reloads.push({ total: Number(m[1]), bundle: Number(m[2]), stop: Number(m[3]), boot: Number(m[4]) });
}
if (reloads.length === rounds) {
  timings.reload = reloads;
  check(`a real edit reboots on the new bundle (${rounds}×)`, true, `median ${median(reloads.map((r) => r.total))} ms: ${reloads.map((r) => `${r.total} (bundle ${r.bundle}, stop ${r.stop}, boot ${r.boot})`).join(", ")}`);
}
const after = rpc("list_notes");
check("/workspace survives the reboot (state disk)", after.ok && after.out.includes("e2e: before reload"), after.err);

// An MCP session while berth dev runs attaches to its VM, and leaves it running.
{
  const s = await mcpSession(`vm-e2e-attach-${Date.now()}`, "attach");
  check("berth mcp --runtime vm attaches to the running berth dev VM", s.ok && /attached to the running microVM sandbox "berth-dev-notes-e2e"/.test(s.err), s.ok ? `first tools/call ${s.firstCallMs} ms from spawn` : s.err);
  const still = run(["vm", "status", sandbox]);
  check("...and leaves it running when the client goes", still.status === 0 && /notes-e2e: ready/.test(still.stdout), still.stdout + still.stderr);
}

dev.kill("SIGINT");
await new Promise((r) => dev.once("exit", r));
const st = run(["vm", "status", sandbox]);
check("stopping berth dev stops the VM", st.status !== 0 && /no running sandbox/.test(st.stderr + st.stdout), st.stdout);

// --- 3b. secrets -------------------------------------------------------------------
// Two apps in one sandbox: vault-e2e declares E2E_VAULT_TOKEN, probe-e2e
// doesn't and looks for it everywhere it could leak inside the guest.
{
  const ws = mkdtempSync(join(tmpdir(), "berth-vm-e2e-secrets-"));
  writeFileSync(join(ws, "pnpm-workspace.yaml"), "packages:\n  - '*'\n");
  const mkApp = (dir, yml, src) => {
    mkdirSync(join(ws, dir), { recursive: true });
    cpSync(join(repo, "apps", "notes", "package.json"), join(ws, dir, "package.json"));
    writeFileSync(join(ws, dir, "berth.yml"), yml);
    mkdirSync(join(ws, dir, "src"), { recursive: true });
    writeFileSync(join(ws, dir, "src", "index.ts"), src);
  };
  const statusExport = `  app.export({
    name: "secret_status",
    input: z.object({ name: z.string() }),
    output: z.object({ set: z.boolean(), length: z.number() }),
    handler: async ({ name }) => ({ set: process.env[name] !== undefined, length: process.env[name]?.length ?? 0 }),
  });`;
  mkApp(
    "vault-e2e",
    "name: vault-e2e\nversion: 0.1.0\ndescription: holds a declared secret\ncapabilities: []\nsecrets:\n  - E2E_VAULT_TOKEN\nexports:\n  - name: secret_status\n    input: { name: string }\n    output: { set: boolean, length: number }\n",
    `import { defineApp } from "@berthos/sdk";\nimport { z } from "zod";\nexport default defineApp((app) => {\n${statusExport}\n});\n`,
  );
  mkApp(
    "probe-e2e",
    "name: probe-e2e\nversion: 0.1.0\ndescription: looks for another app's secret\ncapabilities: []\nexports:\n  - name: secret_status\n    input: { name: string }\n    output: { set: boolean, length: number }\n  - name: reach\n    input: { needle: string }\n    output: { cmdline: boolean, environs: number, unreadable: number, devices: array }\n",
    `import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
export default defineApp((app) => {
${statusExport}
  // Booleans and counts only: the needle itself never comes back.
  app.export({
    name: "reach",
    input: z.object({ needle: z.string() }),
    output: z.object({ cmdline: z.boolean(), environs: z.number(), unreadable: z.number(), devices: z.array(z.string()) }),
    handler: async ({ needle }) => {
      const has = (p) => { try { return readFileSync(p, "latin1").includes(needle) ? 1 : 0; } catch { return -1; } };
      let environs = 0, unreadable = 0;
      for (const pid of readdirSync("/proc").filter((d) => /^\\d+$/.test(d))) {
        const r = has(\`/proc/\${pid}/environ\`);
        if (r === 1 && pid !== String(process.pid)) environs++;
        if (r === -1) unreadable++;
      }
      return { cmdline: has("/proc/cmdline") === 1, environs, unreadable, devices: readdirSync("/dev").filter((d) => /^vd[a-z]$/.test(d)) };
    },
  });
});
`,
  );
  const token = `e2e-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const shared = "e2e-shared-value";
  run(["vm", "stop", "berth-dev-vault-e2e"]);
  let out = "";
  const d = spawn(process.execPath, [berth, "dev", "--runtime", "vm", "--apps", "probe-e2e", "--env", "E2E_VAULT_TOKEN", "--env", `E2E_SHARED=${shared}`], {
    cwd: join(ws, "vault-e2e"),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, E2E_VAULT_TOKEN: token },
  });
  d.stdout.on("data", (x) => (out += x));
  d.stderr.on("data", (x) => (out += x));
  const end = Date.now() + 60_000;
  while (Date.now() < end && !/VM ready in \d+ ms/.test(out) && d.exitCode === null) await sleep(50);
  const up = /VM ready in \d+ ms/.test(out);
  check("berth dev --runtime vm --env boots two apps with a secrets disk", up, up ? "" : out.slice(-2000));
  if (up) {
    const call = (appName, exp, input) => {
      const r = run(["rpc", appName, "--container", "berth-dev-vault-e2e", "--runtime", "vm", "--export", exp, "--input", JSON.stringify(input)]);
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { error: r.stdout + r.stderr };
      }
    };
    const v = call("vault-e2e", "secret_status", { name: "E2E_VAULT_TOKEN" });
    check("the app that declares a secret gets it", v.set === true && v.length === token.length, JSON.stringify(v));
    const p = call("probe-e2e", "secret_status", { name: "E2E_VAULT_TOKEN" });
    check("another app in the sandbox doesn't", p.set === false, JSON.stringify(p));
    const sv = call("vault-e2e", "secret_status", { name: "E2E_SHARED" });
    const sp = call("probe-e2e", "secret_status", { name: "E2E_SHARED" });
    check("an undeclared name reaches every app", sv.set && sp.set && sp.length === shared.length, JSON.stringify({ sv, sp }));
    const r = call("probe-e2e", "reach", { needle: token });
    check(
      "the secret is not in /proc/cmdline, any other process's environ, or a device node",
      r.cmdline === false && r.environs === 0 && Array.isArray(r.devices) && !r.devices.includes("vdc"),
      JSON.stringify(r),
    );
    // Positive control: the probe does see what is on the command line.
    const c = call("probe-e2e", "reach", { needle: "init=/sbin/berth-init" });
    check("...and the probe would have seen it on the command line (control)", c.cmdline === true && r.unreadable > 0, JSON.stringify(c));
    const runDir = join(process.env.BERTH_HOME ?? join(process.env.HOME, ".berth"), "run", "vm", "berth-dev-vault-e2e");
    check("the host's secrets file is gone once the sandbox is ready", !existsSync(join(runDir, "secrets.img")) && existsSync(join(runDir, "vm.json")), runDir);
    const logs = ["vmm.log", "guest.log", "console.log"].filter((f) => existsSync(join(runDir, f)) && readFileSync(join(runDir, f), "utf8").includes(token));
    check("the secret is in no log", logs.length === 0 && !out.includes(token), logs.join(", "));
  }
  d.kill("SIGINT");
  await new Promise((r) => (d.exitCode !== null ? r() : d.once("exit", r)));
}

// --- 3c. python -------------------------------------------------------------------
{
  const ws = mkdtempSync(join(tmpdir(), "berth-vm-e2e-py-"));
  const app = join(ws, "py-e2e");
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(
    join(app, "berth.yml"),
    "name: py-e2e\nversion: 0.1.0\ndescription: a Python app in the VM\nruntime: python\ncapabilities:\n  - filesystem:write:/workspace\nsecrets:\n  - E2E_PY_TOKEN\nexports:\n  - name: greet\n    input: { name: string }\n    output: { message: string }\n  - name: try_write\n    input: { path: string }\n    output: { ok: boolean, error: string }\n  - name: info\n    output: { python: string, token_length: number }\n",
  );
  writeFileSync(
    join(app, "src", "app.py"),
    `import os, sys
from berth_sdk import define_app
from pydantic import BaseModel
from src.helper import greeting

class GreetInput(BaseModel):
    name: str

class GreetOutput(BaseModel):
    message: str

class WriteInput(BaseModel):
    path: str

class WriteOutput(BaseModel):
    ok: bool
    error: str

class InfoOutput(BaseModel):
    python: str
    token_length: int

def _greet(i: GreetInput) -> GreetOutput:
    return GreetOutput(message=greeting(i.name))

def _try_write(i: WriteInput) -> WriteOutput:
    try:
        with open(i.path, "w") as f:
            f.write("x")
        return WriteOutput(ok=True, error="")
    except OSError as e:
        return WriteOutput(ok=False, error=e.strerror or str(e))

def _info(_input=None) -> InfoOutput:
    return InfoOutput(python=sys.version.split()[0], token_length=len(os.environ.get("E2E_PY_TOKEN", "")))

def _setup(a):
    a.export("greet", _greet, input_model=GreetInput, output_model=GreetOutput)
    a.export("try_write", _try_write, input_model=WriteInput, output_model=WriteOutput)
    a.export("info", _info, output_model=InfoOutput)

app = define_app(_setup)
`,
  );
  writeFileSync(join(app, "src", "helper.py"), 'def greeting(name):\n    return f"Hello, {name}, from Python in the VM"\n');
  run(["vm", "stop", "berth-dev-py-e2e"]);
  let out = "";
  const d = spawn(process.execPath, [berth, "dev", "--runtime", "vm", "--env", "E2E_PY_TOKEN"], {
    cwd: app,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, E2E_PY_TOKEN: "py-token-1234" },
  });
  d.stdout.on("data", (x) => (out += x));
  d.stderr.on("data", (x) => (out += x));
  const end = Date.now() + 60_000;
  while (Date.now() < end && !/VM ready in \d+ ms/.test(out) && d.exitCode === null) await sleep(50);
  const m = out.match(/VM ready in (\d+) ms \(bundle (\d+) ms(, cached)?, boot (\d+) ms\)/);
  check("berth dev --runtime vm boots a runtime: python app", m, m ? `ready ${m[1]} ms (bundle ${m[2]} ms, boot ${m[4]} ms)` : out.slice(-2000));
  if (m) {
    timings.pythonFirstBootMs = Number(m[1]);
    const call = (exp, input) => {
      const r = run(["rpc", "py-e2e", "--runtime", "vm", "--export", exp, ...(input ? ["--input", JSON.stringify(input)] : [])]);
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { error: r.stdout + r.stderr };
      }
    };
    const g = call("greet", { name: "e2e" });
    check("its export answers, importing its own module", g.message === "Hello, e2e, from Python in the VM", JSON.stringify(g));
    const info = call("info");
    check("it runs on the image's python3, and its declared secret reached it", /^3\.\d+/.test(info.python ?? "") && info.token_length === "py-token-1234".length, JSON.stringify(info));
    const ok = call("try_write", { path: "/workspace/py-e2e.txt" });
    const denied = call("try_write", { path: "/tmp/py-e2e-elsewhere.txt" });
    check("Landlock: it may write /workspace, which it declared, and not /tmp", ok.ok === true && denied.ok === false && /denied/i.test(denied.error), JSON.stringify({ ok, denied }));
    let mark = out.length;
    writeFileSync(join(app, "src", "helper.py"), 'def greeting(name):\n    return f"Hi again, {name}"\n');
    const end2 = Date.now() + 30_000;
    while (Date.now() < end2 && !/Reloaded in \d+ ms/.test(out.slice(mark))) await sleep(50);
    const again = call("greet", { name: "e2e" });
    check("editing a .py file reboots the VM on the new code", again.message === "Hi again, e2e", JSON.stringify(again) + out.slice(mark, mark + 400));
  }
  d.kill("SIGINT");
  await new Promise((r) => (d.exitCode !== null ? r() : d.once("exit", r)));
}

// --- 3d. /context -------------------------------------------------------------------
// semantic-fs in the guest (docs/design/microvm-semantic-fs.md), through the CLI.
{
  const ws = mkdtempSync(join(tmpdir(), "berth-vm-e2e-ctx-"));
  const app = join(ws, "fs-e2e");
  cpSync(join(repo, "apps", "filesystem", "src"), join(app, "src"), { recursive: true });
  cpSync(join(repo, "apps", "filesystem", "package.json"), join(app, "package.json"));
  writeFileSync(join(app, "berth.yml"), readFileSync(join(repo, "apps", "filesystem", "berth.yml"), "utf8").replace(/^name: filesystem$/m, "name: fs-e2e"));
  const box = "berth-dev-fs-e2e";
  run(["vm", "stop", box]);
  // Its state disk too, so the first boot starts with an empty /context.
  rmSync(join(process.env.BERTH_HOME ?? join(process.env.HOME, ".berth"), "vm", "state", "fs-e2e.img"), { force: true });
  const boot = async () => {
    let out = "";
    const d = spawn(process.execPath, [berth, "dev", "--runtime", "vm"], { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
    d.stdout.on("data", (x) => (out += x));
    d.stderr.on("data", (x) => (out += x));
    const end = Date.now() + 60_000;
    while (Date.now() < end && !/VM ready in \d+ ms/.test(out) && d.exitCode === null) await sleep(50);
    return { d, up: /VM ready in \d+ ms/.test(out), out: () => out };
  };
  const stop = async (d) => {
    d.kill("SIGINT");
    await new Promise((r) => (d.exitCode !== null ? r() : d.once("exit", r)));
  };
  const call = (exp, input) => {
    const r = run(["rpc", "fs-e2e", "--runtime", "vm", "--export", exp, "--input", JSON.stringify(input)]);
    try {
      if (r.status !== 0) return { error: r.stdout + r.stderr };
      // An export with no output answers null.
      return (r.stdout.trim() ? JSON.parse(r.stdout) : null) ?? {};
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  let b = await boot();
  check("berth dev --runtime vm boots an app that declares /context", b.up, b.up ? "" : b.out().slice(-2000));
  if (b.up) {
    const w = call("write_context_file", { path: "plans/q4.md", content: "ship attestation in Q4" });
    const t = call("tag_context_file", { path: "plans/q4.md", task: "release planning", relatedApps: ["notes"] });
    const q = call("query_context", { text: "release planning" });
    const hit = (q.results ?? []).find((x) => x.path === "plans/q4.md");
    check("write_context_file and tag_context_file answer", !w.error && !t.error, JSON.stringify({ w, t }));
    check("query_context finds it, written by fs-e2e: the kernel's name for the caller, not the one it claims", hit?.createdBy === "fs-e2e" && hit.task === "release planning", JSON.stringify(q));
    await stop(b.d);
    b = await boot();
    const r = b.up ? call("read_context_file", { path: "plans/q4.md" }) : {};
    const q2 = b.up ? call("query_context", { text: "release planning" }) : {};
    check(
      "after berth dev restarts, the context file and its tag are still there",
      r.content === "ship attestation in Q4" && (q2.results ?? []).some((x) => x.path === "plans/q4.md" && x.task === "release planning"),
      JSON.stringify({ r, q2 }) + (b.up ? "" : b.out().slice(-1000)),
    );
  }
  await stop(b.d);
}

// --- 4. mcp ---------------------------------------------------------------------
const mcpRuns = [];
let lastRunId;
for (let i = 0; i < rounds; i++) {
  const runId = `vm-e2e-${Date.now()}-${i}`;
  const r = await mcpSession(runId, String(i));
  mcpRuns.push(r);
  lastRunId = runId;
  if (!r.ok) console.log(r.err);
}

timings.mcp = mcpRuns.map(({ initMs, firstCallMs }) => ({ initMs, firstCallMs }));
check(
  `berth mcp --runtime vm: initialize, tools/list, tools/call (${rounds}×)`,
  mcpRuns.every((r) => r.ok),
  `spawn → first tools/call answered: ${mcpRuns.map((r) => r.firstCallMs).join(", ")} ms (median ${median(mcpRuns.map((r) => r.firstCallMs))}); initialize: median ${median(mcpRuns.map((r) => r.initMs))} ms`,
);
check("each MCP session recorded its boot evidence", mcpRuns.every((r) => r.evidence));
const leftover = run(["vm", "status", sandbox]);
check("a VM the MCP session booted is stopped when the client leaves", leftover.status !== 0, leftover.stdout);

// --- 4b. mcp --env ------------------------------------------------------------------
{
  const ws = mkdtempSync(join(tmpdir(), "berth-vm-e2e-mcpenv-"));
  const app = join(ws, "mcpenv-e2e");
  mkdirSync(join(app, "src"), { recursive: true });
  cpSync(join(repo, "apps", "notes", "package.json"), join(app, "package.json"));
  writeFileSync(join(app, "berth.yml"), "name: mcpenv-e2e\nversion: 0.1.0\ndescription: a secret through berth mcp\ncapabilities: []\nsecrets:\n  - E2E_MCP_TOKEN\nexports:\n  - name: secret_status\n    input: { name: string }\n    output: { set: boolean, length: number }\n");
  writeFileSync(
    join(app, "src", "index.ts"),
    `import { defineApp } from "@berthos/sdk";\nimport { z } from "zod";\nexport default defineApp((app) => {\n  app.export({\n    name: "secret_status",\n    input: z.object({ name: z.string() }),\n    output: z.object({ set: z.boolean(), length: z.number() }),\n    handler: async ({ name }) => ({ set: process.env[name] !== undefined, length: process.env[name]?.length ?? 0 }),\n  });\n});\n`,
  );
  const token = `mcp-${Math.random().toString(36).slice(2)}`;
  run(["vm", "stop", "berth-dev-mcpenv-e2e"]);
  const { Client } = await import(join(cliDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js"));
  const { StdioClientTransport } = await import(join(cliDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "stdio.js"));
  const session = async (extra) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [berth, "mcp", "--runtime", "vm", "--app", "mcpenv-e2e", "--app-dir", app, "--no-audit", ...extra],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)), E2E_MCP_TOKEN: token },
      stderr: "pipe",
    });
    let err = "";
    transport.stderr?.on("data", (d) => (err += d));
    const client = new Client({ name: "berth-vm-e2e-env", version: "0.0.1" });
    await client.connect(transport);
    return { client, err: () => err };
  };
  const a = await session(["--env", "E2E_MCP_TOKEN"]);
  const r = await a.client.callTool({ name: "secret_status", arguments: { name: "E2E_MCP_TOKEN" } });
  let got;
  try {
    got = JSON.parse(r.content?.[0]?.text ?? "");
  } catch {}
  check("berth mcp --runtime vm --env NAME: the app that declares it gets it", got?.set === true && got.length === token.length, JSON.stringify(got) + a.err().slice(-600));
  check("...and the value is not in berth mcp's output", !a.err().includes(token));
  // A second session attaches to the first one's VM.
  const b = await session(["--env", "E2E_MCP_TOKEN"]);
  await b.client.callTool({ name: "secret_status", arguments: { name: "E2E_MCP_TOKEN" } });
  check("a session that attaches says its --env was not applied", /--env\/--env-file were not applied/.test(b.err()), b.err().slice(-400));
  await b.client.close();
  await a.client.close();
  await sleep(500);
  run(["vm", "stop", "berth-dev-mcpenv-e2e"]);
}

// --- 5. attest ---------------------------------------------------------------------
{
  const out = join(work, "attestation.json");
  const r = run(["attest", lastRunId, "--file", auditFile, "--out", out]);
  let rec;
  try {
    rec = JSON.parse(readFileSync(out, "utf8"));
  } catch {}
  const iso = rec?.boot?.isolation;
  check("berth attest on the MCP run: ACTIVE", r.status === 0 && rec?.enforcement?.status === "ACTIVE", r.stderr + (rec ? JSON.stringify(rec.enforcement) : ""));
  check(
    "the record says microvm: pinned kernel and rootfs, tsi false, nics 0",
    iso?.kind === "microvm" && iso.kernel?.pinned && iso.rootfs?.pinned && iso.tsi === false && iso.nics === 0,
    iso ? `kernel ${iso.kernel.sha256.slice(0, 12)}…, rootfs ${iso.rootfs.sha256.slice(0, 12)}…, image ${rec.boot.imageDigest.slice(0, 19)}…` : "",
  );
  check(
    "...and that berth-vmm confined itself on the host (Seatbelt)",
    process.platform !== "darwin" || (iso?.hostSandbox?.applied === true && iso.hostSandbox.kind === "seatbelt"),
    JSON.stringify(iso?.hostSandbox),
  );
  const v = spawnSync(process.execPath, [join(repo, "scripts", "verify-attestation.mjs"), out], { encoding: "utf8" });
  check("scripts/verify-attestation.mjs accepts it", v.status === 0 && /^OK/.test(v.stdout), v.stdout + v.stderr);
}

finish();

async function mcpSession(runId, tag) {
  const { Client } = await import(join(cliDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js"));
  const { StdioClientTransport } = await import(join(cliDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "stdio.js"));
  const start = Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [berth, "mcp", "--runtime", "vm", "--app", name, "--app-dir", app, "--audit-file", auditFile, "--run-id", runId],
    // The SDK passes only a default allowlist (HOME, PATH, ...) unless told;
    // BERTH_HOME must reach the bridge, or it uses the real ~/.berth.
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d) => (err += d));
  const client = new Client({ name: "berth-vm-e2e", version: "0.0.1" });
  await client.connect(transport);
  const initMs = Date.now() - start;
  const tools = await client.listTools();
  const call = await client.callTool({ name: "add_note", arguments: { text: `via MCP ${tag}` } });
  const firstCallMs = Date.now() - start;
  const list = await client.callTool({ name: "list_notes", arguments: {} });
  const ok =
    !call.isError &&
    /"id"/.test(call.content?.[0]?.text ?? "") &&
    (list.content?.[0]?.text ?? "").includes(`via MCP ${tag}`) &&
    tools.tools.map((t) => t.name).join(",") === "add_note,list_notes,complete_note";
  // Give the session a moment to write its boot evidence before it is told to go.
  for (let w = 0; w < 50 && !err.includes("recorded boot evidence"); w++) await sleep(50);
  await client.close();
  await sleep(500);
  return { initMs, firstCallMs, ok, evidence: err.includes("recorded boot evidence"), err };
}

function finish() {
  run(["vm", "stop", sandbox]);
  const failed = results.filter((r) => !r.pass).length;
  const summary = { when: new Date().toISOString(), passed: results.length - failed, failed, results, timings };
  const outFile = join(tmpdir(), "berth-vm-e2e.json");
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\n${results.length - failed}/${results.length} passed; results in ${outFile}`);
  process.exit(failed === 0 ? 0 : 1);
}
