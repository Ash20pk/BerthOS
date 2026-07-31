import { z } from "zod";
import type { BerthManifest } from "@berth/manifest-schema";
import type { ContextBusClient } from "./context-bus/client.js";
import type { SemanticFsClient } from "./semantic-fs/client.js";

export interface ExportDefinition<In = unknown, Out = unknown> {
  name: string;
  input?: z.ZodType<In>;
  output?: z.ZodType<Out>;
  handler: (input: In) => Promise<Out> | Out;
}

export interface AppContext {
  contextBus: ContextBusClient;
  semanticFs: SemanticFsClient;
  manifest: BerthManifest;
}

export interface BerthApp {
  export<In, Out>(def: ExportDefinition<In, Out>): void;
  onInstall(fn: () => Promise<void> | void): void;
  onAgentReady(fn: (ctx: AppContext) => Promise<void> | void): void;
  /** Internal accessors used by runtime.ts — not part of the authoring API. */
  readonly _exports: Map<string, ExportDefinition<unknown, unknown>>;
  readonly _onInstallHooks: Array<() => Promise<void> | void>;
  readonly _onAgentReadyHooks: Array<(ctx: AppContext) => Promise<void> | void>;
}

export function defineApp(setup: (app: BerthApp) => void): BerthApp {
  const exports = new Map<string, ExportDefinition<unknown, unknown>>();
  const onInstallHooks: Array<() => Promise<void> | void> = [];
  const onAgentReadyHooks: Array<(ctx: AppContext) => Promise<void> | void> = [];

  const app: BerthApp = {
    export(def) {
      if (exports.has(def.name)) {
        throw new Error(`export "${def.name}" is already registered`);
      }
      exports.set(def.name, def as ExportDefinition<unknown, unknown>);
    },
    onInstall(fn) {
      onInstallHooks.push(fn);
    },
    onAgentReady(fn) {
      onAgentReadyHooks.push(fn);
    },
    _exports: exports,
    _onInstallHooks: onInstallHooks,
    _onAgentReadyHooks: onAgentReadyHooks,
  };

  setup(app);
  return app;
}
