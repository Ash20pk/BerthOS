import { existsSync } from "node:fs";
import type { BerthManifest } from "@berthos/manifest-schema";
import { artifactsPresent, installArtifacts } from "./artifacts.js";
import { bundleApp, type BundledApp } from "./bundle.js";
import { readConfigFile, resolveArtifactsDir, resolveArtifactsUrl } from "./config.js";
import { activePins, checkHost, vmmFeatures, vmmLayerPins } from "./host.js";
import { releasePair } from "./artifacts.js";
import { vmHome, vmStateDisk } from "./paths.js";
import { VmSandbox, type StartTimings } from "./sandbox.js";
import type { ReadyResult } from "./control.js";
import type { GuestLogLine } from "./guest-lines.js";
import { dialerAllowList, egressAllowList, layersFor, vmUnsupported, vmUnsupportedMessage } from "./support.js";
import { vmSecrets, type VmSecrets } from "./secrets.js";

/**
 * The steps `berth dev --runtime vm` and `berth mcp --runtime vm` share:
 * check the host, make sure the pinned artifacts are installed (installing
 * them on first use from a configured build directory or download URL),
 * bundle each app, and start the sandbox.
 */

export interface VmAppInput {
  name: string;
  appDir: string;
  manifest: BerthManifest;
}

export class VmHostError extends Error {}

/** The berth-vmm to use, or a VmHostError naming every failed check and its fix. */
export function requireHost(): string {
  const config = readConfigFile();
  const host = checkHost(config.vm?.vmm ? { configuredVmm: config.vm.vmm } : {});
  const failed = host.checks.filter((c) => c.status === "fail");
  if (failed.length > 0 || !host.vmm) {
    throw new VmHostError(
      `the microVM runtime can't run on this host yet:\n${failed.map((c) => `  ✘ ${c.title}: ${c.detail}${c.remedy ? `\n      → ${c.remedy}` : ""}`).join("\n")}\nRun \`berth doctor --sandbox vm\` for the full picture, or use --runtime docker.`,
    );
  }
  return host.vmm;
}

/** Installs the pinned kernel and rootfs if they aren't in ~/.berth/vm yet. */
export async function ensureArtifacts(log: (message: string) => void, vmm: string): Promise<void> {
  const pins = activePins(vmm);
  if (artifactsPresent(undefined, pins)) return;
  const config = readConfigFile();
  const from = resolveArtifactsDir(undefined, process.env, config);
  const urlTemplate = resolveArtifactsUrl(undefined, process.env, config);
  log(`installing the pinned VM kernel and rootfs into ${vmHome()} (first use)${from ? ` from ${from}` : ""}...`);
  try {
    const results = await installArtifacts({ ...(from && existsSync(from) ? { from } : {}), urlTemplate, log, pins });
    for (const r of results) log(`  ${r.kind}: ${r.source} ${r.sha256.slice(0, 12)}… in ${r.ms} ms`);
  } catch (err) {
    throw new VmHostError(`${err instanceof Error ? err.message : String(err)}\nInstall them with \`berth vm install --from <dir>\` (a packages/vmm build's artifacts directory).`);
  }
}

/**
 * Installs the optional layers `names` this berth-vmm pins, when they aren't
 * yet: downloaded once, from the same release as the kernel and rootfs, and
 * checked like them. Says what and how big first; the browser is hundreds of MB.
 */
export async function ensureLayers(names: string[], vmm: string, log: (message: string) => void, needer = "this sandbox"): Promise<void> {
  const pins = vmmLayerPins(vmm);
  for (const name of names) {
    const pin = pins[name];
    if (!pin) throw new VmHostError(`this berth-vmm pins no ${name} layer; update it with \`berth vm install\``);
    if (artifactsPresent(undefined, [pin])) continue;
    const config = readConfigFile();
    const from = resolveArtifactsDir(undefined, process.env, config);
    log(`the ${name} layer (${Math.round(pin.size / 1048576)} MB) is needed by ${needer}; installing it once into ${vmHome()}...`);
    try {
      const [r] = await installArtifacts({
        ...(from && existsSync(from) ? { from } : {}),
        urlTemplate: resolveArtifactsUrl(undefined, process.env, config),
        release: releasePair(activePins(vmm)),
        pins: [pin],
        log,
      });
      log(`  layer ${name}: ${r!.source} ${r!.sha256.slice(0, 12)}… in ${r!.ms} ms`);
    } catch (err) {
      throw new VmHostError(`${err instanceof Error ? err.message : String(err)}\nInstall it with \`berth vm install --layer ${name}\`.`);
    }
  }
}

export function assertSupported(apps: VmAppInput[], vmm: string): void {
  const features = vmmFeatures(vmm);
  // The guest's egress broker is one app's, as in a container.
  const egressApps = apps.filter((a) => egressAllowList([a.manifest]).length > 0);
  if (egressApps.length > 1) {
    throw new VmHostError(
      `at most one app may declare a browser:navigate:*/network:host:* capability when running multiple apps together — found ${egressApps.length}: ${egressApps.map((a) => a.name).join(", ")}`,
    );
  }
  for (const app of apps) {
    const reasons = vmUnsupported(app.manifest, features);
    if (reasons.length > 0) throw new VmHostError(vmUnsupportedMessage(app.name, reasons));
  }
}

export async function bundleApps(apps: VmAppInput[]): Promise<BundledApp[]> {
  return Promise.all(apps.map((a) => bundleApp(a.appDir, a.name, { runtime: a.manifest.runtime })));
}

export interface BootVmOptions {
  name: string;
  apps: VmAppInput[];
  vmm: string;
  log: (message: string) => void;
  onLog?: (line: GuestLogLine) => void;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
  /** Already bundled (the dev loop bundles before it stops the old VM). */
  bundles?: BundledApp[];
  /** A state disk per primary app (default), so /workspace survives restarts like the Docker path's named volume. */
  state?: boolean;
  /**
   * Variables for the apps (`--env`, `--env-file`). A name an app declares
   * under `secrets:` reaches that app alone; any other reaches every app.
   * All of it travels on the secrets disk, none on the kernel command line.
   */
  env?: Record<string, string>;
  /**
   * ttyd's `user:password` for the sandbox's terminal:* app, when it publishes
   * its web view: onto the secrets disk for that app alone, as the container
   * path puts it in that container's environment.
   */
  terminalCredential?: string;
  /**
   * The VNC password for the sandbox's browser app, when the browser layer is
   * attached: onto the secrets disk for that app (berth-init gives it to
   * x11vnc), and noVNC's port published, as the container path does.
   */
  vncPassword?: string;
}

/** noVNC's port in the guest (berth-init's plan::NOVNC_PORT, the container's 6080). */
export const NOVNC_PORT = 6080;

/** The terminal:* app whose ttyd the host may reach: the container path's needsTerminalPort rule. */
export function terminalApp(apps: VmAppInput[]): VmAppInput | undefined {
  return apps.find((a) => a.manifest.capabilities.some((c) => c.startsWith("terminal:")) && (a.manifest as { expose?: { terminal?: boolean } }).expose?.terminal !== false);
}

/** apps/terminal's ttyd port (tmux-controller.ts's default, docker-orchestrator's TERMINAL_PORT). */
export const TERMINAL_PORT = 7681;

export async function bootVm(options: BootVmOptions): Promise<{ sandbox: VmSandbox; ready: ReadyResult; timings: StartTimings & { bundleMs: number }; bundles: BundledApp[] }> {
  const t0 = Date.now();
  const bundles = options.bundles ?? (await bundleApps(options.apps));
  const bundleMs = Date.now() - t0;
  options.signal?.throwIfAborted();
  const primary = options.apps[0]!;
  let secrets = sandboxSecrets(options.apps, options.env ?? {}, options.vmm, options.log);
  // The terminal's web view: its port published, its credential to it alone.
  const term = options.terminalCredential ? terminalApp(options.apps) : undefined;
  const features = vmmFeatures(options.vmm);
  const publishTerminal = Boolean(term && features.publish && features.secrets);
  if (term && !publishTerminal) options.log(`"${term.name}"'s web terminal isn't published: this berth-vmm has no \`run --publish\` (update it with \`berth vm install\`); the app runs without it`);
  if (publishTerminal && term) {
    secrets ??= { shared: {}, perApp: {} };
    secrets.perApp[term.name] = { ...(secrets.perApp[term.name] ?? {}), BERTH_TERMINAL_CREDENTIAL: options.terminalCredential! };
  }
  const egress = egressArgs(options.apps.map((a) => a.manifest), options.vmm);
  const layers = layersFor(options.apps.map((a) => a.manifest));
  // The browser's VNC view: the password to the browser app alone, its port published.
  const browserApp = layers.includes("browser") ? options.apps.find((a) => layersFor([a.manifest]).includes("browser")) : undefined;
  const publishVnc = Boolean(browserApp && options.vncPassword && features.publish && features.secrets);
  if (publishVnc && browserApp) {
    secrets ??= { shared: {}, perApp: {} };
    secrets.perApp[browserApp.name] = { ...(secrets.perApp[browserApp.name] ?? {}), BERTH_VNC_PASSWORD: options.vncPassword! };
  }
  await ensureLayers(layers, options.vmm, options.log, options.apps.filter((a) => layersFor([a.manifest]).length > 0).map((a) => a.name).join(", "));
  const extraArgs = [...(egress.extraArgs ?? []), ...(publishTerminal ? ["--publish", String(TERMINAL_PORT)] : []), ...layers.flatMap((l) => ["--layer", l]), ...(publishVnc ? ["--publish", String(NOVNC_PORT)] : [])];
  const { sandbox, ready, timings } = await VmSandbox.start({
    name: options.name,
    vmm: options.vmm,
    apps: bundles.map((b, i) => ({ name: b.name, share: b.shareDir, appDir: options.apps[i]!.appDir })),
    // Where ensureArtifacts installed them. berth-vmm's own default is
    // $HOME/.berth/vm, which is not this when BERTH_HOME moves ~/.berth.
    artifactsDir: vmHome(),
    ...(options.state === false ? {} : { state: vmStateDisk(primary.name) }),
    ...(secrets ? { secrets } : {}),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
    ...(vmMemMiB(options.apps.map((a) => a.manifest)) ? { memMiB: vmMemMiB(options.apps.map((a) => a.manifest)) } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { sandbox, ready, timings: { ...timings, bundleMs }, bundles };
}

/**
 * Guest RAM, when berth-vmm's default (512 MiB for one app, 1024 for more)
 * is too little: an app that declares /context gets the sandbox's embeddings
 * daemon, whose model takes about 250 MiB once loaded, and 512 MiB less
 * berth-init's daemon reserve leaves too little for it and the app together.
 */
export function vmMemMiB(manifests: BerthManifest[]): number | undefined {
  // Chromium, Xvfb and the app together: the container path's experience is
  // that less than 2 GiB stalls renderers.
  if (layersFor(manifests).includes("browser")) return 2048;
  const context = manifests.some((m) => m.capabilities.some((c) => /^filesystem:(read|write):\/context(\/|$)/.test(c)));
  return context && manifests.length === 1 ? 768 : undefined;
}

/**
 * The sandbox's secrets disk, if it has anything to carry. Warns, by name
 * only, about a declared secret with no value, as the container path does.
 */
function sandboxSecrets(apps: VmAppInput[], env: Record<string, string>, vmm: string, log: (message: string) => void): VmSecrets | undefined {
  const { shared, perApp, missing } = vmSecrets(env, apps);
  for (const { app, name } of missing) log(`warning: app "${app}" declares secret ${name} in berth.yml, but no value was provided for this boot`);
  if (Object.keys(env).length === 0) return undefined;
  if (!vmmFeatures(vmm).secrets) {
    throw new VmHostError(`this berth-vmm can't take variables for the apps (it has no \`run --secrets\`); update it with \`berth vm install\`, or use --runtime docker`);
  }
  return { shared, perApp };
}

/** `--egress-allow` for the sandbox, when its apps declare egress and this berth-vmm has the dialer. */
function egressArgs(manifests: BerthManifest[], vmm: string): { extraArgs?: string[] } {
  const allow = dialerAllowList(manifests);
  if (allow.length === 0 || !vmmFeatures(vmm).egress) return {};
  return { extraArgs: ["--egress-allow", allow.join(",")] };
}
