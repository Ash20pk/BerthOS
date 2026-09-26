import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which Docker daemon Berth talks to, resolved the way the `docker` CLI does.
 *
 * dockerode only reads DOCKER_HOST and otherwise dials /var/run/docker.sock,
 * so `docker context use colima` used to be invisible to every Berth command:
 * `docker ps` showed Colima while `berth doctor` checked Docker Desktop. On a
 * Mac that is exactly the wrong way round — Colima is the host that enforces
 * Landlock, and Docker Desktop is the one that can't.
 *
 * Order, same as the CLI: DOCKER_HOST, then DOCKER_CONTEXT, then
 * `currentContext` in $DOCKER_CONFIG/config.json (default ~/.docker).
 * A context's metadata lives at contexts/meta/<sha256(name)>/meta.json.
 */
export interface DockerHostResolution {
  /** The endpoint, e.g. unix:///Users/me/.colima/default/docker.sock. Undefined means dockerode's default. */
  host?: string;
  /** Where it came from, for doctor's output. */
  source: "DOCKER_HOST" | "DOCKER_CONTEXT" | "docker context" | "default";
  /** The context name, when one was consulted. */
  context?: string;
  /** Why a named context could not be used, when it couldn't. */
  problem?: string;
}

export function resolveDockerHost(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): DockerHostResolution {
  if (env.DOCKER_HOST) return { host: env.DOCKER_HOST, source: "DOCKER_HOST" };

  const configDir = env.DOCKER_CONFIG || join(home, ".docker");
  let context = env.DOCKER_CONTEXT;
  const source: DockerHostResolution["source"] = context ? "DOCKER_CONTEXT" : "docker context";
  if (!context) {
    try {
      const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8")) as { currentContext?: string };
      context = config.currentContext;
    } catch {
      // No config.json, or unreadable: the CLI treats that as the default context too.
    }
  }
  if (!context || context === "default") return { source: "default" };

  const metaPath = join(configDir, "contexts", "meta", createHash("sha256").update(context).digest("hex"), "meta.json");
  let host: string | undefined;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { Endpoints?: { docker?: { Host?: string } } };
    host = meta.Endpoints?.docker?.Host;
  } catch {
    // Colima, for one, deletes its context on `colima stop`.
    return { source, context, problem: `Docker context "${context}" is selected but not found (is it stopped?)` };
  }
  if (!host) return { source, context, problem: `Docker context "${context}" has no docker endpoint` };
  // A tcp:// context usually carries TLS material under contexts/tls/, which
  // DOCKER_HOST alone can't express. Say so rather than dial it without TLS.
  if (!host.startsWith("unix://") && !host.startsWith("npipe://")) {
    return {
      source,
      context,
      problem: `Docker context "${context}" points at ${host}; only unix:// and npipe:// contexts are followed — set DOCKER_HOST (and DOCKER_TLS_VERIFY/DOCKER_CERT_PATH) instead`,
    };
  }
  return { host, source, context };
}

let applied: DockerHostResolution | undefined;

/**
 * Resolve once and, when a context supplied the host, export it as
 * DOCKER_HOST so every `new Docker()` in this process — and every `docker`
 * child process — reaches the same daemon. Never overrides an explicit
 * DOCKER_HOST. Runs when this package is first imported.
 */
export function applyDockerContext(): DockerHostResolution {
  if (applied) return applied;
  applied = resolveDockerHost();
  if (applied.host && applied.source !== "DOCKER_HOST") process.env.DOCKER_HOST = applied.host;
  if (applied.problem) {
    console.warn(`[berth] WARNING: ${applied.problem}; falling back to the default Docker socket, which may be a different daemon.`);
  }
  return applied;
}

/** A one-line account of the daemon choice, for doctor and error messages. */
export function describeDockerHost(resolution: DockerHostResolution): string {
  if (resolution.problem) return resolution.problem;
  switch (resolution.source) {
    case "DOCKER_HOST":
      return `${resolution.host} (from DOCKER_HOST)`;
    case "DOCKER_CONTEXT":
      return `${resolution.host} (Docker context "${resolution.context}", from DOCKER_CONTEXT)`;
    case "docker context":
      return `${resolution.host} (current Docker context "${resolution.context}")`;
    default:
      return "the default socket, /var/run/docker.sock (no DOCKER_HOST, default Docker context)";
  }
}
