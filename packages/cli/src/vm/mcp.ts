import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquireFileLock } from "@berthos/audit";
import { envNotApplied } from "../util/env-args.js";
import type { BootEvidence, StdioRpcClient } from "@berthos/docker-orchestrator";
import type { BerthManifest } from "@berthos/manifest-schema";
import type { EnforcementStatus } from "../util/capability-errors.js";
import type { SandboxSteps } from "../util/mcp-sandbox.js";
import { vmBootEvidence, vmRulesetReports, consoleLines } from "./evidence.js";
import { berthHome } from "./paths.js";
import { assertSupported, bootVm, ensureArtifacts, requireHost } from "./runtime.js";
import { readGuestLog, VmSandbox } from "./sandbox.js";

/**
 * `berth mcp --runtime vm`: the same background-sandbox state machine as the
 * Docker path (util/mcp-sandbox.ts), with a microVM behind SandboxSteps. A
 * running `berth dev --runtime vm` sandbox of the same name is attached to;
 * otherwise this session boots its own, and stops it when it ends.
 */

export interface ConnectedVm {
  enforcement: EnforcementStatus;
  rpc?: StdioRpcClient;
  evidence(): Promise<BootEvidence>;
  sandbox: VmSandbox;
}

/** What agent-init reported for the app at this boot, in capability-errors.ts's terms. */
export function enforcementOf(sandbox: VmSandbox, app: string): EnforcementStatus {
  const bootId = sandbox.bootId;
  if (!bootId) return "unknown";
  let lines: { src: string; line: string }[] = readGuestLog(sandbox.runDir);
  if (!lines.some((l) => l.src === app)) lines = consoleLines(readText(join(sandbox.runDir, "console.log")));
  const report = vmRulesetReports(lines, bootId).find((r) => r.app === app);
  if (!report) return "unknown";
  return report.ruleset === "FullyEnforced" ? "enforced" : report.ruleset === "PartiallyEnforced" ? "partially-enforced" : "not-enforced";
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function vmEvidence(sandbox: VmSandbox): BootEvidence {
  if (!sandbox.bootId) throw new Error(`"${sandbox.name}" has no control connection, so its boot id is unknown`);
  return vmBootEvidence({
    record: sandbox.record,
    bootId: sandbox.bootId,
    controlEvents: sandbox.controlEvents(),
    logLines: readGuestLog(sandbox.runDir),
    consoleText: readText(join(sandbox.runDir, "console.log")),
  });
}

export function vmSandboxSteps(options: {
  name: string;
  appName: string;
  appDir: string;
  manifest: BerthManifest;
  readyTimeoutMs: number;
  attachRpc: boolean;
  /** --env/--env-file: onto the secrets disk when this session boots the VM. */
  env?: Record<string, string>;
  log: (message: string) => void;
}): SandboxSteps<VmSandbox, ConnectedVm> {
  const { name, log } = options;
  let toldWaiting = false;
  return {
    find: async () => {
      const found = await VmSandbox.find(name, { onStale: (why) => log(`a stale "${name}" was left behind (${why}); cleaned it up`) });
      if (found) log(`attached to the running microVM sandbox "${name}" (berth-vmm pid ${found.pid})`);
      if (found && Object.keys(options.env ?? {}).length > 0) log(envNotApplied(name));
      return found;
    },
    claimBoot: () => {
      const dir = join(berthHome(), "run");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const claim = tryAcquireFileLock(join(dir, `${name}.vm.boot.lock`));
      if (!claim && !toldWaiting) log(`another berth session is booting "${name}" — waiting for it`);
      toldWaiting ||= !claim;
      return claim && (() => claim.release());
    },
    boot: async (signal) => {
      log(`no microVM sandbox named "${name}" — booting one for "${options.manifest.name}"`);
      const vmm = requireHost();
      await ensureArtifacts(log, vmm);
      const apps = [{ name: options.manifest.name, appDir: options.appDir, manifest: options.manifest }];
      assertSupported(apps, vmm);
      const { sandbox, timings } = await bootVm({ name, apps, vmm, log, readyTimeoutMs: options.readyTimeoutMs, signal, ...(options.env ? { env: options.env } : {}) });
      log(`"${options.manifest.name}" is ready in the VM (${timings.bundleMs + timings.readyMs} ms: bundle ${timings.bundleMs} ms, boot ${timings.readyMs} ms)`);
      return sandbox;
    },
    // A sandbox this session booted is ready when boot() returns; one another
    // session was still booting is waited for here.
    waitReady: async (sandbox, signal) => {
      await sandbox.waitReady(options.readyTimeoutMs, signal);
    },
    connect: async (sandbox) => {
      const enforcement = enforcementOf(sandbox, options.manifest.name);
      log(`kernel enforcement in this VM: ${enforcement}${enforcement === "enforced" ? "" : " — run `berth doctor --sandbox vm`"}`);
      const index = sandbox.appIndex(options.appName) ?? sandbox.appIndex(options.manifest.name) ?? 0;
      return {
        sandbox,
        enforcement,
        evidence: async () => vmEvidence(sandbox),
        ...(options.attachRpc ? { rpc: await sandbox.rpc(index) } : {}),
      };
    },
    stopByName: async () => {
      log(`stopping the microVM sandbox this session booted ("${name}")`);
      await VmSandbox.stopByName(name);
    },
  };
}
