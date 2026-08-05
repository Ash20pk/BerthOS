import { z } from "zod";
import { defineApp, type BerthApp } from "./app.js";
import { configureEgressProxy } from "./egress-proxy.js";

export interface ConnectorAuth {
  /** "none" makes every request unauthenticated; "bearer" and "header" both read a credential from `envVar` at request time, never baked into the config. */
  type: "none" | "bearer" | "header";
  /** Required for "bearer"/"header" — the env var this app's own container has the credential in. */
  envVar?: string;
  /** Required for "header" — which header name carries the credential (e.g. "X-Api-Key"). */
  headerName?: string;
}

export interface ConnectorParam {
  /** Where this input field goes on the actual HTTP request. */
  in: "path" | "query" | "body";
  type: "string" | "number" | "boolean";
  /** Defaults to true. */
  required?: boolean;
  description?: string;
}

export interface ConnectorOperation {
  /** The export name an agent calls — becomes a Tool name exactly like any hand-written app.export(). */
  export: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** e.g. "/repos/{owner}/{repo}/issues" — {name} placeholders are filled from whichever params have `in: "path"`. */
  path: string;
  params?: Record<string, ConnectorParam>;
  description?: string;
}

export interface ConnectorConfig {
  baseUrl: string;
  auth?: ConnectorAuth;
  operations: ConnectorOperation[];
}

export type ConnectorResult = { status: number; data: unknown } | { stub: true; note: string };

function buildInputSchema(params: Record<string, ConnectorParam> = {}): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, param] of Object.entries(params)) {
    let field: z.ZodTypeAny = param.type === "number" ? z.number() : param.type === "boolean" ? z.boolean() : z.string();
    if (param.description) field = field.describe(param.description);
    if (param.required === false) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}

async function invokeOperation(
  config: ConnectorConfig,
  operation: ConnectorOperation,
  input: Record<string, unknown>,
): Promise<ConnectorResult> {
  const auth = config.auth ?? { type: "none" as const };
  const token = auth.envVar ? process.env[auth.envVar] : undefined;

  // Same "no live credentials → stub, don't crash, don't call a real API
  // with junk" posture apps/github-assistant already hand-wrote per export —
  // generalized here so it applies to every operation of every connector for
  // free, including whatever runs during `berth test`'s automatic
  // stub-invocation of every declared export.
  if (auth.type !== "none" && !token) {
    return { stub: true, note: `set ${auth.envVar} for live data — this operation is a no-op stub without it` };
  }

  let path = operation.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};

  for (const [key, param] of Object.entries(operation.params ?? {})) {
    const value = input[key];
    if (value === undefined) continue;
    if (param.in === "path") path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    else if (param.in === "query") query.set(key, String(value));
    else body[key] = value;
  }

  const url = new URL(path, config.baseUrl);
  for (const [key, value] of query) url.searchParams.set(key, value);

  const headers: Record<string, string> = {};
  if (auth.type === "bearer" && token) headers.Authorization = `Bearer ${token}`;
  else if (auth.type === "header" && token && auth.headerName) headers[auth.headerName] = token;

  const hasBody = Object.keys(body).length > 0 && operation.method !== "GET" && operation.method !== "DELETE";
  if (hasBody) headers["Content-Type"] = "application/json";

  const res = await fetch(url, { method: operation.method, headers, body: hasBody ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => res.text());
  return { status: res.status, data };
}

/**
 * Turns a declarative REST API description into a working resident app —
 * the point being that wiring in the next integration (Slack, Jira, a
 * weather API, whatever) becomes "write a ConnectorConfig," not "write a new
 * app's TypeScript by hand" the way apps/github-assistant's two hand-written
 * exports are. Sits directly on network:host:<pattern>'s already-generic
 * egress broker (configureEgressProxy(), called here so a connector author
 * never has to remember to) — one implementation serves every connector
 * declared this way, not one bespoke broker per integration the way
 * apps/github-assistant's own github-api-broker.cjs is for its harder,
 * verb-scoping-specific problem (see docs/github-api-scoping-reference.md;
 * this function deliberately doesn't attempt that level of scoping).
 */
export function defineConnectorApp(config: ConnectorConfig): BerthApp {
  configureEgressProxy();

  return defineApp((app) => {
    for (const operation of config.operations) {
      app.export({
        name: operation.export,
        input: buildInputSchema(operation.params),
        handler: (input) => invokeOperation(config, operation, input as Record<string, unknown>),
      });
    }

    app.onAgentReady(async (ctx) => {
      await ctx.contextBus.register({ app: ctx.manifest.name });
    });
  });
}
