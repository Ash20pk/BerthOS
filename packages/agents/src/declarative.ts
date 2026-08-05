import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createAgent, type Agent, type CreateAgentOptions } from "./agent.js";
import { Crew, type CrewRun } from "./crew.js";
import type { Computer } from "./computer.js";

/**
 * `berth.yml` describes resident apps, not agents/crews — CrewAI's own
 * `agents.yaml`/`tasks.yaml` and ADK's config are the thing this was
 * missing (gap #23). Deliberately covers only what plain YAML data can
 * actually express: `Crew.route`/`loopUntil`/`pipeline`/`networked` all
 * take a real function as configuration (a router, an until predicate, a
 * typed pipeline step) — no scripting/expression language is added here to
 * fake that in YAML, so those three shapes stay code-only. `sequential`,
 * `parallel`, and `withManager` take pure data and are the ones covered.
 */

const ENV_VAR_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** `${SOME_VAR}` resolves to process.env.SOME_VAR; unset resolves to undefined (dropping the field) rather than throwing — the same "absent, not a fabricated value" posture the rest of this package takes. Anything not matching the whole-string `${...}` shape passes through unchanged, so a real literal value still works. */
function interpolateEnv(value: string): string | undefined {
  const match = value.match(ENV_VAR_PATTERN);
  if (!match) return value;
  return process.env[match[1]!];
}

const llmConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google", "ollama"]),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
});

const baseAgentConfigSchema = z.object({
  name: z.string().optional(),
  systemPrompt: z.string().optional(),
  apps: z.union([z.string(), z.array(z.string())]).optional(),
  connect: z.union([z.string(), z.object({ name: z.string(), apps: z.array(z.string()).optional() })]).optional(),
  llm: llmConfigSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  checkpoint: z.literal("semantic-fs").optional(),
  trace: z.enum(["full", "otel"]).optional(),
});

export type AgentConfig = z.infer<typeof baseAgentConfigSchema>;

const namedAgentConfigSchema = baseAgentConfigSchema.extend({ name: z.string() });
type NamedAgentConfig = z.infer<typeof namedAgentConfigSchema>;

const crewConfigSchema = z.object({
  name: z.string().optional(),
  kind: z.enum(["sequential", "parallel", "withManager"]),
  agents: z.array(namedAgentConfigSchema).min(1),
  /** Required (and only used) when kind is "withManager". */
  manager: namedAgentConfigSchema.optional(),
});

export type CrewConfig = z.infer<typeof crewConfigSchema>;

function resolveLlmConfig(config: AgentConfig["llm"]): CreateAgentOptions["llm"] {
  if (!config) return undefined;
  return {
    provider: config.provider,
    apiKey: config.apiKey ? interpolateEnv(config.apiKey) : undefined,
    baseURL: config.baseURL ? interpolateEnv(config.baseURL) : undefined,
    model: config.model,
  };
}

/** Parses and validates a single agent's YAML config — no Docker, no network, just file + schema. Real Docker boot happens in createAgentFromYaml(). */
export async function loadAgentConfig(path: string): Promise<AgentConfig> {
  const raw = await readFile(path, "utf-8");
  return baseAgentConfigSchema.parse(parseYaml(raw));
}

/** Parses and validates a crew's YAML config — same no-Docker split as loadAgentConfig(). */
export async function loadCrewConfig(path: string): Promise<CrewConfig> {
  const raw = await readFile(path, "utf-8");
  return crewConfigSchema.parse(parseYaml(raw));
}

function toCreateAgentOptions(config: AgentConfig): CreateAgentOptions {
  return {
    name: config.name,
    systemPrompt: config.systemPrompt,
    apps: config.apps,
    connect: config.connect,
    llm: resolveLlmConfig(config.llm),
    maxTurns: config.maxTurns,
    checkpoint: config.checkpoint,
    trace: config.trace,
  };
}

/**
 * Builds a real Agent (and boots/connects its Computer) from a YAML config
 * file — the declarative-config half of gap #23's closure; `createAgent()`
 * itself is unchanged, this just maps validated YAML onto its existing
 * options. Neither `apps` nor `connect` required here specifically:
 * createAgent()'s own existing validation (normalizeApps()) already throws
 * a clear error if the config gave it neither, so this doesn't duplicate
 * that check.
 */
export async function createAgentFromYaml(
  path: string,
): Promise<{ agent: Agent; computer: Computer; config: AgentConfig }> {
  const config = await loadAgentConfig(path);
  const { agent, computer } = await createAgent(toCreateAgentOptions(config));
  return { agent, computer, config };
}

async function buildNamedAgent(config: NamedAgentConfig): Promise<{ agent: Agent; computer: Computer }> {
  return createAgent(toCreateAgentOptions(config));
}

/**
 * Builds a real Crew from a YAML config file — one createAgent() call (one
 * real Computer) per named agent listed, composed via whichever of
 * sequential/parallel/withManager the config's `kind` names. Agents are
 * built one at a time, not concurrently: if a later agent's Computer fails
 * to boot, every earlier one gets stopped before the error propagates,
 * rather than leaking containers this function itself started — the same
 * orphaned-container concern Computer.boot({httpRpc})'s own fix (see
 * gaps.md gap #12) already established the pattern for.
 */
export async function createCrewFromYaml(
  path: string,
): Promise<{ crew: CrewRun; computers: Computer[]; config: CrewConfig }> {
  const config = await loadCrewConfig(path);
  const computers: Computer[] = [];
  const agents: Agent[] = [];

  try {
    for (const agentConfig of config.agents) {
      const built = await buildNamedAgent(agentConfig);
      computers.push(built.computer);
      agents.push(built.agent);
    }

    if (config.kind === "sequential") {
      return { crew: Crew.sequential(agents), computers, config };
    }
    if (config.kind === "parallel") {
      return { crew: Crew.parallel(agents), computers, config };
    }

    // kind === "withManager"
    if (!config.manager) {
      throw new Error(`${path}: kind "withManager" needs a top-level "manager" agent config`);
    }
    const managerBuilt = await buildNamedAgent(config.manager);
    computers.push(managerBuilt.computer);
    return { crew: Crew.withManager({ manager: managerBuilt.agent, workers: agents }), computers, config };
  } catch (err) {
    await Promise.all(computers.map((computer) => computer.stop().catch(() => {})));
    throw err;
  }
}
