import type { ComputerHandle } from "./computer.js";
import { findExportTool } from "./checkpoint.js";

export interface AgentStepEvent {
  runId: string;
  agentName: string;
  /** Index of the turn this step happened in — same numbering as CheckpointedRun.turnCount. */
  turn: number;
  kind: "llm-turn" | "tool-call";
  /** Set only on kind "tool-call". */
  toolName?: string;
  durationMs: number;
  /** Set when the LLM call or tool.invoke() threw — the same message Agent.run()'s {error} tool result carries for tool-calls. */
  error?: string;
  /** Set only on kind "llm-turn", when the LLMProvider reports it (LLMTurn.usage) — absent, not zero, for a provider that doesn't. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * The observability seam Agent.run()/resume() emit through — as narrow as
 * "here's one step", so a backend other than Context Bus/Semantic FS (a
 * plain logger, a real tracing backend) can implement it without pulling in
 * a Computer at all.
 */
export interface StepTracer {
  emit(event: AgentStepEvent): Promise<void>;
}

const TRACE_DIR = "agent-traces";
/** Tagged onto every trace file's relatedApps so listAgentTraces() can find them all via one query_context call, without needing any runId up front. */
const TRACE_INDEX_MARKER = "agent-trace-index";

function pathFor(runId: string): string {
  return `${TRACE_DIR}/${runId}.json`;
}

function runIdFromPath(path: string): string | null {
  const prefix = `${TRACE_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".json")) return null;
  return path.slice(prefix.length, -".json".length);
}

/**
 * Publishes each step to the Context Bus topic "agent.step" for live
 * tailing — reached the only way an Agent (running outside the sandbox) can
 * reach the bus at all: through a resident app's publish_context_event
 * export (apps/filesystem, alongside write_context_file et al.), the same
 * "small, real addition" pattern read_context_file/tag_context_file were for
 * checkpointing. Purely fire-and-forget: the Context Bus is ephemeral
 * pub/sub, nothing here is readable back later — see
 * createSemanticFsStepTracer() for that.
 */
export function createContextBusStepTracer(computer: ComputerHandle): StepTracer {
  const publishTool = findExportTool(computer.tools, "publish_context_event", "createContextBusStepTracer()");
  return {
    async emit(event) {
      await publishTool.invoke({ topic: "agent.step", payload: event });
    },
  };
}

/**
 * Appends each step to a single Semantic FS blob per runId
 * (agent-traces/<runId>.json) — durable replay after the fact, the thing the
 * Context Bus tracer can't do. Same single-file-per-runId shape as
 * CheckpointStore, and the same tradeoff: every emit() is a full
 * read-modify-write of that run's whole trace so far, not an append, so two
 * concurrent emit() calls for the same runId can race and drop one — no
 * different from CheckpointStore.save() already overwriting wholesale each
 * turn. Use readAgentTrace() to read one back.
 */
export function createSemanticFsStepTracer(computer: ComputerHandle): StepTracer {
  const writeTool = findExportTool(computer.tools, "write_context_file", "createSemanticFsStepTracer()");
  const readTool = findExportTool(computer.tools, "read_context_file", "createSemanticFsStepTracer()");
  const tagTool = findExportTool(computer.tools, "tag_context_file", "createSemanticFsStepTracer()");

  return {
    async emit(event) {
      const path = pathFor(event.runId);
      let events: AgentStepEvent[] = [];
      try {
        const existing = (await readTool.invoke({ path })) as { content: string };
        events = JSON.parse(existing.content) as AgentStepEvent[];
      } catch {
        // Nothing saved for this runId yet — this is its first step.
      }
      events.push(event);
      await writeTool.invoke({ path, content: JSON.stringify(events) });
      // task keeps the exact-runId lookup readAgentTrace() doesn't actually
      // need (it derives the path itself), but relatedApps carries a fixed
      // marker every trace file shares — that's what makes them all
      // discoverable by listAgentTraces() via one query_context call,
      // without needing to already know a runId.
      await tagTool.invoke({ path, task: event.runId, relatedApps: [TRACE_INDEX_MARKER] });
    },
  };
}

/** Reads back the full step history createSemanticFsStepTracer() wrote for a runId — [] if none was ever saved. */
export async function readAgentTrace(computer: ComputerHandle, runId: string): Promise<AgentStepEvent[]> {
  const readTool = findExportTool(computer.tools, "read_context_file", "readAgentTrace()");
  try {
    const result = (await readTool.invoke({ path: pathFor(runId) })) as { content: string };
    return JSON.parse(result.content) as AgentStepEvent[];
  } catch {
    return [];
  }
}

/**
 * Lists every runId createSemanticFsStepTracer() has ever traced, newest
 * first — closing "no way to list/browse every trace ever recorded" without
 * inventing a second storage concept: it's one query_context call (the same
 * generic Semantic FS search every other Berth-agents primitive already
 * reaches through) filtered to paths under agent-traces/, not a new index.
 * Content isn't fetched — call readAgentTrace(runId) for that.
 */
export async function listAgentTraces(
  computer: ComputerHandle,
  options: { limit?: number } = {},
): Promise<{ runId: string; updatedAt: number }[]> {
  const queryTool = findExportTool(computer.tools, "query_context", "listAgentTraces()");
  const { results } = (await queryTool.invoke({ text: TRACE_INDEX_MARKER })) as {
    results: { path: string; updatedAt: number }[];
  };

  const traces = results
    .map((hit) => {
      const runId = runIdFromPath(hit.path);
      return runId ? { runId, updatedAt: hit.updatedAt } : null;
    })
    .filter((hit): hit is { runId: string; updatedAt: number } => hit !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return options.limit ? traces.slice(0, options.limit) : traces;
}

/**
 * gaps.md's chosen replacement for observability/tracing: both channels at
 * once — live tailing via Context Bus, durable replay via Semantic FS. Needs
 * a Computer whose apps expose all four of publish_context_event/
 * write_context_file/read_context_file/tag_context_file (apps/filesystem
 * does); throws immediately at construction, same as
 * createSemanticFsCheckpointStore(), rather than on the first emit() deep
 * inside a run.
 */
export function createAgentTracer(computer: ComputerHandle): StepTracer {
  const contextBus = createContextBusStepTracer(computer);
  const semanticFs = createSemanticFsStepTracer(computer);
  return {
    async emit(event) {
      await Promise.all([contextBus.emit(event), semanticFs.emit(event)]);
    },
  };
}
