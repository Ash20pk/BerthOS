import { mkdir, writeFile, chmod, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a container reads its secret environment from — a host file bind-
 * mounted read-only at this path and sourced by entrypoint.sh before any
 * daemon or app starts (REMEDIATION.md 5.5).
 *
 * The whole point is that it is *not* `Env` on createContainer. Docker's
 * `Env` is permanent, immutable container configuration: it survives in
 * `docker inspect` for the life of the container, is copied verbatim into
 * every `docker commit` of it, and is what `berth snapshot create` reads to
 * build a snapshot's `env.json`. A bind-mounted file is none of those — the
 * mount shows up in `inspect` as a *path*, commit excludes mount points by
 * construction, and a snapshot restored on another machine finds nothing at
 * that path.
 *
 * Under /run deliberately: it's the FHS location for runtime state that
 * doesn't outlive a boot, it's not on any path an app declares a filesystem
 * capability for, and it's not inside /workspace or /app, so no bind mount
 * or image layer can shadow it.
 */
export const CONTAINER_SECRETS_PATH = "/run/berth/secrets.env";

/** Per-boot host state for running containers — a sibling of ~/.berth/os and ~/.berth/snapshots, but for things that must not outlive the container. */
const DEFAULT_RUN_DIR = join(homedir(), ".berth", "run");

/**
 * Env var names whose *values* are credentials, matched case-insensitively
 * against the whole name. Deliberately broad and deliberately dumb: the cost
 * of a false positive is that a non-secret value travels through a file
 * instead of through `Env` (invisible to everyone, since entrypoint.sh
 * exports it either way), and the cost of a false negative is a credential
 * in `docker inspect` forever. Those costs are not symmetric.
 *
 * Substring rather than suffix matching, because the real names in the wild
 * are not consistently suffixed — `ANTHROPIC_API_KEY` and `AWS_SECRET_ACCESS_KEY`
 * both have to match, and only one of them ends in the interesting word. (A
 * small suffix rule follows, for the one case a fragment can't express.)
 */
const SECRET_NAME_FRAGMENTS = [
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "API_KEY",
  "APIKEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
  "SESSION_KEY",
  "AUTH",
] as const;

/**
 * Suffix rules, for the two cases a substring can't express safely.
 *
 * `_KEY`: `AZURE_OPENAI_KEY` and `DEEPSEEK_KEY` are real provider variable
 * names and neither contains "API_KEY", but `KEY` as a substring appears in
 * far too many innocent names — `BERTH_MESH_KEY_PATH` is a path.
 *
 * `_PAT`: GitHub personal access tokens are conventionally `*_PAT`. This was
 * a fragment first, which quietly classified `BERTH_MESH_KEY_PATH` as a
 * secret via the "_PAT" in "KEY_PATH" — caught by the test asserting Berth's
 * own non-credential names stay in `Env`.
 */
const SECRET_NAME_SUFFIXES = ["_KEY", "_PAT"] as const;

/**
 * Credentials whose names give nothing away, and so cannot be pattern-
 * matched at all. Empty today — every credential Berth itself sets
 * (`BERTH_HTTP_RPC_TOKEN`, `BERTH_TERMINAL_CREDENTIAL`, `BERTH_VNC_PASSWORD`,
 * `BERTH_GRANTS_TOKEN`, `BERTH_REGISTRY_TOKEN`) is caught by a fragment. It
 * exists because the alternative, when the first such name shows up, is
 * broadening a fragment until it catches that one name and a hundred others.
 */
const EXPLICIT_SECRET_NAMES = new Set<string>([]);

/**
 * Names that *would* match a rule above but must stay in `Env` — nothing is
 * exempt today, and the list exists so that a future exemption has to be
 * written down next to the reason for it rather than being achieved by
 * quietly weakening a rule. Note that `*_TLS_CERT`/`_KEY` are paths, not
 * PEMs (5.3), so routing them through the secrets file is harmless and they
 * are not exempted.
 */
const NEVER_SECRET_NAMES = new Set<string>([]);

export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (NEVER_SECRET_NAMES.has(upper)) return false;
  if (EXPLICIT_SECRET_NAMES.has(upper)) return true;
  if (SECRET_NAME_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return true;
  return SECRET_NAME_FRAGMENTS.some((fragment) => upper.includes(fragment));
}

export interface PartitionedEnv {
  /** Safe to hand to Docker as `Env` — visible in `docker inspect` forever. */
  plain: Record<string, string>;
  /** Delivered through the bind-mounted secrets file instead. */
  secret: Record<string, string>;
}

/**
 * Splits a container's environment by whether each name's value is a
 * credential. Both halves reach the app's process environment identically
 * (entrypoint.sh sources the file before anything starts, so every child
 * inherits it) — what differs is where the value is durably recorded.
 */
export function partitionSecretEnv(env: Record<string, string>): PartitionedEnv {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnvName(name)) secret[name] = value;
    else plain[name] = value;
  }
  return { plain, secret };
}

/**
 * Names that are valid only for the boot that set them, and so must never be
 * replayed into a later one. `BERTH_SECRETS_FILE` points at a bind mount that
 * exists only while this container is running: captured into a snapshot and
 * passed to a restore on another machine, the path resolves to nothing and
 * entrypoint.sh — which fails closed on an unreadable secrets file, on purpose
 * — refuses to boot the restored sandbox at all.
 *
 * Dropped silently rather than reported alongside the withheld credentials:
 * telling an operator that a restored snapshot is "missing BERTH_SECRETS_FILE"
 * would send them looking for a credential that does not exist.
 */
const BOOT_SCOPED_ENV_NAMES = new Set(["BERTH_SECRETS_FILE"]);

/**
 * Drops every secret value from a map, returning the non-secret entries plus
 * the *names* that were dropped. Used by anything that persists a captured
 * environment (`berth snapshot create`'s env.json): the names are worth
 * keeping — a restore has to tell the operator which credentials to supply
 * again — and the values are precisely what must not be written to a file
 * that gets copied to another machine.
 */
export function stripSecretEnv(env: Record<string, string>): { env: Record<string, string>; strippedNames: string[] } {
  const { plain, secret } = partitionSecretEnv(env);
  for (const name of BOOT_SCOPED_ENV_NAMES) delete plain[name];
  return {
    env: plain,
    strippedNames: Object.keys(secret)
      .filter((name) => !BOOT_SCOPED_ENV_NAMES.has(name))
      .sort(),
  };
}

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Renders the file entrypoint.sh sources. Single-quoted with `'` escaped as
 * `'\''`, which is the only POSIX-shell quoting that is safe for an
 * arbitrary value — a double-quoted value would let `$`, backtick and `\`
 * inside an API key execute as shell, and an unquoted one would break on the
 * first space. Values are otherwise passed through byte-for-byte, newlines
 * included (a PEM in an env var is a real case).
 *
 * A name the shell cannot represent is rejected rather than silently
 * dropped: dropping it would mean an app booting without a credential it
 * asked for, failing later somewhere unrelated.
 */
export function serializeSecretsEnvFile(secrets: Record<string, string>): string {
  const lines = [
    "# Generated by @berth/docker-orchestrator, sourced by docker/entrypoint.sh.",
    "# One container boot's credentials. Not in `docker inspect`, not in any",
    "# image layer, not in a snapshot — see docs/secrets-reference.md.",
  ];
  for (const [name, value] of Object.entries(secrets)) {
    if (!VALID_ENV_NAME.test(name)) {
      throw new Error(`cannot pass "${name}" to a container as a secret: not a valid shell environment variable name`);
    }
    lines.push(`export ${name}='${value.replaceAll("'", `'\\''`)}'`);
  }
  return lines.join("\n") + "\n";
}

/** Per-container host directory holding that container's secrets file. */
export function containerSecretsDir(containerName: string, runDir: string = DEFAULT_RUN_DIR): string {
  return join(runDir, containerName);
}

/**
 * Writes one container's secrets to a host file at mode 0600 inside a 0700
 * directory — the same shape grants-server's operator token has always used
 * (`operator-token.ts`), applied here rather than left at whatever the
 * process umask happened to be.
 *
 * `chmod` after `writeFile` rather than trusting `writeFile`'s `mode`, which
 * is masked by the umask on creation and ignored entirely for a file that
 * already exists — and this file does already exist on the second `berth
 * dev` boot of the same app.
 */
export async function writeContainerSecretsFile(
  containerName: string,
  secrets: Record<string, string>,
  runDir = DEFAULT_RUN_DIR,
): Promise<string> {
  const dir = containerSecretsDir(containerName, runDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, "secrets.env");
  await writeFile(path, serializeSecretsEnvFile(secrets), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/**
 * Removes a container's secrets directory. Best-effort by design: called
 * from `stopContainer()`, where a failure to unlink a file must not turn a
 * successful teardown into a thrown error. A leftover directory is
 * overwritten by the next boot of the same container name anyway.
 */
export async function removeContainerSecretsDir(containerName: string, runDir: string = DEFAULT_RUN_DIR): Promise<void> {
  await rm(containerSecretsDir(containerName, runDir), { recursive: true, force: true }).catch(() => {});
}

/**
 * Whether a path is readable by anyone other than its owner. Used to warn
 * about credential files Berth did not create and will not silently chmod —
 * `~/.berthrc` is the developer's own file, and rewriting its mode without
 * being asked is a surprise in the other direction.
 */
export async function isGroupOrWorldReadable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return (info.mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
