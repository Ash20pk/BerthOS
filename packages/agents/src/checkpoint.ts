import type { ComputerHandle } from "./computer.js";
import type { AgentMessage, Tool } from "./types.js";
import type { AgentRunResult } from "./agent.js";

export interface CheckpointedRun {
  runId: string;
  agentName: string;
  status: "running" | "done" | "error";
  /** Index of the next turn to execute — where resume() picks the tool-use loop back up. */
  turnCount: number;
  messages: AgentMessage[];
  toolCalls: AgentRunResult["toolCalls"];
  /** Set once status is "done" — the final answer, so resuming an already-finished run is a plain read, not a replay. */
  text?: string;
}

/**
 * The persistence seam Agent.run()/resume() write through — deliberately as
 * narrow as save/load-by-id, so a backend other than Semantic FS (a plain
 * file, a real database) can implement it without pulling in a Computer at
 * all. Generic over the checkpoint shape (default CheckpointedRun, what
 * Agent itself uses) so the same seam and the same Semantic FS-backed
 * implementation below also serve Crew-level composition checkpoints
 * (crew.ts's CrewCheckpoint) — one storage concept, not two.
 */
export interface CheckpointStore<T extends { runId: string } = CheckpointedRun> {
  save(checkpoint: T): Promise<void>;
  load(runId: string): Promise<T | null>;
}

const CONTEXT_DIR = "agent-runs";

/**
 * Tool names are bare (`write_context_file`) for a single-app Computer,
 * `<appName>__write_context_file` once a Computer has more than one app (see
 * tools.ts's toolNameFor) — match either shape rather than assuming which.
 * Exported so tracing.ts's Semantic FS/Context Bus tracers can resolve their
 * own export names off Computer.tools the exact same way, instead of
 * duplicating this lookup.
 */
export function findExportTool(tools: Tool[], exportName: string, calledBy = "createSemanticFsCheckpointStore()"): Tool {
  const tool = tools.find((t) => t.name === exportName || t.name.endsWith(`__${exportName}`));
  if (!tool) {
    throw new Error(
      `${calledBy} needs a resident app exposing "${exportName}" in this Computer's app list ` +
        `(apps/filesystem does) — got tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`,
    );
  }
  return tool;
}

/**
 * A CheckpointStore backed by Semantic FS, reached the only way an Agent
 * (which runs outside the sandbox) can reach it: through a resident app's
 * write_context_file/read_context_file/tag_context_file exports (already
 * real, already tool-called like any other export — no new OS-level plumbing
 * needed). Resolves those three tools eagerly, at construction, so a
 * Computer missing them fails fast with a clear error instead of on the
 * first save() call deep inside a run.
 *
 * load()'s "not found" and "a real error happened" cases are indistinguishable
 * here: resident-app export errors cross the RPC wire as a plain message
 * string (see Computer's dispatch()), not a typed error code, so there's no
 * reliable way to tell ENOENT apart from anything else without parsing error
 * text. Any read failure is treated as "no prior checkpoint" — acceptable for
 * resume (worst case, you restart the run instead of resuming it), but worth
 * knowing if you're debugging why a resume() didn't pick up where you expected.
 */
export function createSemanticFsCheckpointStore<T extends { runId: string } = CheckpointedRun>(
  computer: ComputerHandle,
): CheckpointStore<T> {
  const writeTool = findExportTool(computer.tools, "write_context_file");
  const readTool = findExportTool(computer.tools, "read_context_file");
  const tagTool = findExportTool(computer.tools, "tag_context_file");

  const pathFor = (runId: string) => `${CONTEXT_DIR}/${runId}.json`;

  return {
    async save(checkpoint) {
      const path = pathFor(checkpoint.runId);
      const record = checkpoint as unknown as Record<string, unknown>;
      const task = (record.agentName as string) ?? (record.kind as string) ?? checkpoint.runId;
      await writeTool.invoke({ path, content: JSON.stringify(checkpoint) });
      await tagTool.invoke({ path, task, relatedApps: [] });
    },
    async load(runId) {
      try {
        const result = (await readTool.invoke({ path: pathFor(runId) })) as { content: string };
        return JSON.parse(result.content) as T;
      } catch {
        return null;
      }
    },
  };
}
