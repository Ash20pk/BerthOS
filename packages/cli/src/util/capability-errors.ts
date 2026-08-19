import { ALLOWED_FILESYSTEM_SCOPE_PREFIXES, matchesCapability, type BerthManifest } from "@berth/manifest-schema";
import * as path from "node:path";

/**
 * What the kernel inside the app's container actually did with the declared
 * policy, as reported by `agent-init` at boot. This is the difference between
 * "the kernel refused your write" and "something refused your write and we
 * don't know what" — a distinction this repo refuses to blur, so it is a
 * parameter here rather than an assumption.
 */
export type EnforcementStatus = "enforced" | "partially-enforced" | "not-enforced" | "unknown";

export interface ExplainContext {
  appName: string;
  manifest: BerthManifest;
  /** Path to berth.yml as the *caller* would edit it — a host path, not the container's. */
  manifestPath: string;
  enforcement: EnforcementStatus;
}

/** Node's fs errors: "EACCES: permission denied, open '/etc/x.txt'" (with an optional " -> '<dest>'"). */
const FS_ERROR = /^(E[A-Z]+): ([^,]+), ([a-z0-9_]+) '([^']+)'(?: -> '([^']+)')?/;

/**
 * Syscalls that need write access to the target path. Anything not listed is
 * treated as ambiguous rather than assumed read-only: `open` is the common
 * case and it is genuinely both (writeFile and readFile both surface as
 * `open`), so guessing would produce a confidently wrong fix line.
 */
const WRITE_SYSCALLS = new Set([
  "mkdir",
  "rmdir",
  "unlink",
  "rename",
  "write",
  "truncate",
  "ftruncate",
  "symlink",
  "link",
  "copyfile",
  "chmod",
  "chown",
  "utimes",
  "futimes",
  "mkdtemp",
  "appendfile",
]);

const READ_SYSCALLS = new Set(["read", "readlink", "readdir", "scandir", "stat", "lstat", "fstat", "realpath"]);

function enforcementLine(enforcement: EnforcementStatus, appName: string): string {
  switch (enforcement) {
    case "enforced":
      return `denied-by: the kernel — a Landlock ruleset compiled from "${appName}"'s berth.yml and applied before the app's first line ran`;
    case "partially-enforced":
      return `denied-by: the kernel, but this container reported a PARTIALLY enforced ruleset — some declared paths could not be added to it, so treat the boundary as incomplete and read the container's agent-init line`;
    case "not-enforced":
      return `denied-by: NOT the Landlock policy — this container's agent-init reported that the kernel did not apply the ruleset at all, so capabilities here are recorded and not enforced. Something else refused this call (file ownership, a read-only mount, or the app's own code). Do not read this denial as enforcement; run \`berth doctor\` and see docs/mac-enforcement.md`;
    case "unknown":
      return `denied-by: unknown — this bridge could not read agent-init's enforcement line from the container, so it cannot say whether the kernel refused this or something else did. Run \`berth doctor\` before treating it as a kernel boundary`;
  }
}

function underAllowedPrefix(target: string): boolean {
  return ALLOWED_FILESYSTEM_SCOPE_PREFIXES.some((prefix) => target === prefix || target.startsWith(`${prefix}/`));
}

/** The capability scope a fix line should name: the containing directory, but never above an allowed prefix. */
function scopeFor(target: string): string {
  const dir = path.posix.dirname(target);
  const prefix = ALLOWED_FILESYSTEM_SCOPE_PREFIXES.find((p) => target === p || target.startsWith(`${p}/`));
  if (!prefix) return dir;
  return dir.length < prefix.length ? prefix : dir;
}

function declares(manifest: BerthManifest, requested: string): boolean {
  return manifest.capabilities.some((granted) => matchesCapability(granted, requested));
}

/**
 * Turns an app's raw runtime error into something an agent reading it over MCP
 * can act on without a human translating: what was denied, what denied it,
 * which capability line would grant it, and where that line goes. Launch-plan
 * item 1.5 ("docs and error messages must be machine-legible") is specifically
 * about this — the first user of Berth through the MCP bridge is another
 * agent, and `EACCES: permission denied, open '/etc/x'` tells that agent
 * nothing about berth.yml.
 *
 * Returns the raw message untouched when it isn't a recognizable capability
 * denial. Inventing a manifest fix for an ordinary application bug would be
 * worse than passing the error through: it sends the reader to edit a file
 * that was never the problem.
 */
export function explainAppError(raw: string, ctx: ExplainContext): string {
  const fs = FS_ERROR.exec(raw);
  if (!fs) return explainNonFsError(raw, ctx);

  const [, code, description, syscall, target] = fs;
  if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") return raw;

  const header = [
    `BERTH CAPABILITY DENIAL`,
    `app: ${ctx.appName}`,
    `manifest: ${ctx.manifestPath}`,
    `raw: ${raw}`,
    `denied: ${syscall}(2) on ${target} (${code}: ${description})`,
  ];

  // EROFS is not a capability decision at all, and offering a capability line
  // for it would send the reader to edit the wrong file. `berth dev` mounts
  // the workspace root read-only on purpose (see util/workspace.ts).
  if (code === "EROFS") {
    return [
      ...header,
      `denied-by: the container's VFS, not the capability policy — Berth mounts the workspace root read-only so an app cannot rewrite its own berth.yml or your repository`,
      `fix: write under the app's data directory instead (BERTH_WORKSPACE_ROOT, which is /workspace/.berth/dev-workspace under \`berth dev\`) or /tmp. Adding a capability line will NOT change this.`,
      `docs: docs/resident-apps.md, docs/kernel-enforcement.md`,
    ].join("\n");
  }

  const action = WRITE_SYSCALLS.has(syscall!) ? "write" : READ_SYSCALLS.has(syscall!) ? "read" : undefined;

  // Outside the four prefixes a filesystem scope may name, no manifest edit
  // exists that would allow this — saying "add filesystem:write:/etc" would be
  // a fix line the schema rejects.
  if (!underAllowedPrefix(target!)) {
    return [
      ...header,
      enforcementLine(ctx.enforcement, ctx.appName),
      `fix: none available — a berth.yml filesystem scope may only name ${ALLOWED_FILESYSTEM_SCOPE_PREFIXES.join(", ")}, so no declaration grants ${target}. Use a path under one of those instead.`,
      `declared: ${ctx.manifest.capabilities.join(", ") || "(none)"}`,
      `docs: docs/capability-tokens-reference.md, docs/manifest-reference.md`,
    ].join("\n");
  }

  const scope = scopeFor(target!);
  const wanted = action ? [`filesystem:${action}:${scope}`] : [`filesystem:write:${scope}`, `filesystem:read:${scope}`];
  const missing = wanted.filter((capability) => !declares(ctx.manifest, capability));

  // Already declared and still denied: the fix is not another manifest line.
  if (missing.length === 0) {
    return [
      ...header,
      enforcementLine(ctx.enforcement, ctx.appName),
      `fix: not a missing declaration — "${ctx.appName}" already declares ${wanted.join(" and ")}. Likely file ownership (apps run as their own uid, see docs/per-app-uid-design.md) or a path that exists outside the granted directory via a symlink. Check the container's agent-init line for which paths the ruleset actually got.`,
      `declared: ${ctx.manifest.capabilities.join(", ") || "(none)"}`,
      `docs: docs/capability-tokens-reference.md`,
    ].join("\n");
  }

  return [
    ...header,
    enforcementLine(ctx.enforcement, ctx.appName),
    `fix: add ${missing.length > 1 ? "one of these lines" : "this line"} to \`capabilities:\` in ${ctx.manifestPath}, then restart the app — a Landlock ruleset cannot be widened on a running process, so the change takes effect on the next boot, never live:`,
    ...missing.map((capability) => `  - ${capability}`),
    ...(action ? [] : [`note: ${syscall}(2) is used for both reading and writing, so declare whichever this export actually needs — not both.`]),
    `declared: ${ctx.manifest.capabilities.join(", ") || "(none)"}`,
    `alternative: \`berth grants\` requests the same capability with a human in the loop instead of editing the manifest (docs/capability-tokens-reference.md).`,
  ].join("\n");
}

/**
 * The non-filesystem denials worth naming. Network is the important one:
 * an app with no `network:connect:` capability gets no outbound TCP at all,
 * and the symptom (ECONNREFUSED, or a DNS failure) looks nothing like a
 * permission problem from inside the app.
 */
function explainNonFsError(raw: string, ctx: ExplainContext): string {
  // Matched on the error *code* wherever it appears rather than anchored:
  // Node writes connect failures as "connect ECONNREFUSED 127.0.0.1:8090",
  // code second, and a Landlock-refused connect surfaces as EACCES/EPERM only
  // when the message also names connect(2).
  const network = /\b(ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND)\b/.test(raw) || /\b(EACCES|EPERM)\b.*\bconnect\b/.test(raw);
  if (!network) return raw;
  const port = /:(\d{1,5})\b/.exec(raw)?.[1];

  const declaredNetwork = ctx.manifest.capabilities.filter((c) => c.startsWith("network:"));
  return [
    `BERTH CAPABILITY DENIAL (network)`,
    `app: ${ctx.appName}`,
    `manifest: ${ctx.manifestPath}`,
    `raw: ${raw}`,
    enforcementLine(ctx.enforcement, ctx.appName),
    declaredNetwork.length === 0
      ? `denied: this app declares no network capability at all, so it has no outbound TCP (Landlock) and no UDP/raw sockets (seccomp) — including DNS, which is why a hostname lookup fails here too`
      : `denied: outbound access not covered by this app's declared network capabilities`,
    `fix: add ${port ? `\`network:connect:${port}\`` : "`network:connect:<port>`"} to \`capabilities:\` in ${ctx.manifestPath} and restart the app. Scoping is by port, not hostname; for hostname scoping declare \`network:host:<pattern>\` and route through the egress broker.`,
    `declared: ${declaredNetwork.join(", ") || "(no network capabilities)"}`,
    `docs: docs/kernel-enforcement.md, docs/egress-broker-reference.md`,
  ].join("\n");
}

/**
 * Reads `agent-init`'s own statement about what the kernel did, out of the
 * container's log stream. Both branches are matched (the JSON audit event and
 * the human line) because the JSON one carries the exact RulesetStatus while
 * the human line is what an older image prints.
 */
export function enforcementFromContainerLogs(logs: string): EnforcementStatus {
  const audit = /"ruleset":"(\w+)"/.exec(logs);
  const status = audit?.[1];
  if (status === "FullyEnforced") return "enforced";
  if (status === "PartiallyEnforced") return "partially-enforced";
  if (status === "NotEnforced") return "not-enforced";
  if (/\[agent-init\] NOT RESTRICTED/.test(logs)) return "not-enforced";
  if (/\[agent-init\] restricted .*\(FullyEnforced\)/.test(logs)) return "enforced";
  return "unknown";
}
