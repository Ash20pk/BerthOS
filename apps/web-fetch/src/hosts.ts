import { loadManifest } from "@berthos/manifest-schema";

/**
 * The hosts this app may reach, from its own berth.yml. The egress proxy is
 * what enforces them; this copy exists so a refused host comes back to the
 * agent as a sentence naming the line to add, instead of "fetch failed". The
 * matching mirrors packages/docker-orchestrator/docker/egress-broker.cjs:
 * a host glob where only * is a wildcard, and an optional port, where no port
 * means 80 and 443.
 */
export interface HostPattern {
  /** The capability scope as written, e.g. "*.example.com" or "api.example.com:8443". */
  scope: string;
  host: string;
  port: "*" | number | null;
}

export function parseHostScope(scope: string): HostPattern {
  const lastColon = scope.lastIndexOf(":");
  if (lastColon > 0) {
    const suffix = scope.slice(lastColon + 1);
    if (suffix === "*") return { scope, host: scope.slice(0, lastColon), port: "*" };
    if (/^\d+$/.test(suffix)) return { scope, host: scope.slice(0, lastColon), port: Number(suffix) };
  }
  return { scope, host: scope, port: null };
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

export function isAllowed(patterns: HostPattern[], host: string, port: number): boolean {
  return patterns.some((p) => {
    if (!globToRegExp(p.host).test(host)) return false;
    if (p.port === null) return port === 80 || port === 443;
    return p.port === "*" || p.port === port;
  });
}

export function patternsFrom(capabilities: string[]): HostPattern[] {
  return capabilities
    .filter((c) => c.startsWith("network:host:"))
    .map((c) => parseHostScope(c.slice("network:host:".length)));
}

let cached: Promise<HostPattern[]> | undefined;
/** This app's own patterns. Read at call time, so a test can point BERTH_MANIFEST_PATH elsewhere first. */
export function allowedPatterns(): Promise<HostPattern[]> {
  cached ??= loadManifest(process.env.BERTH_MANIFEST_PATH ?? "berth.yml").then((m) => patternsFrom(m.capabilities));
  return cached;
}

/** For tests: forget the cached manifest. */
export function resetAllowedPatterns(): void {
  cached = undefined;
}
