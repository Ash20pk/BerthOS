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
 * Thrown when a checkpoint exists but could not be read or parsed —
 * deliberately distinct from load() returning null, which means "there is no
 * checkpoint for this runId". Conflating the two is what let a transient read
 * failure masquerade as a fresh run. See REMEDIATION 3.5.
 */
export class CheckpointReadError extends Error {
  constructor(
    readonly runId: string,
    readonly cause: unknown,
  ) {
    super(`checkpoint for run "${runId}" exists but could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CheckpointReadError";
  }
}

/**
 * Whether a resident-app read error means the file simply isn't there.
 * apps/filesystem's read_context_file is a thin wrapper over fs.readFile, so
 * the underlying ENOENT text is what reaches us — matched on both the errno
 * code and the human-readable phrasing, since a different app implementing
 * the same export contract may word it differently.
 */
function isNotFound(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes("enoent") || message.includes("no such file");
}

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
 * **On atomicity, stated rather than implied.** save() is a write followed by
 * a tag — two RPCs, and there is no rename primitive in this contract, so a
 * torn write cannot be *prevented* here the way a temp-file-plus-rename would
 * prevent it on a local filesystem. Adding one would mean a new resident-app
 * export and FUSE-level rename support, which is a larger change than this
 * seam. What is done instead is to make a torn write *loud*: load() below
 * refuses to silently treat unparseable content as "no checkpoint". A tag
 * failure is separately harmless for resume — load() reads by exact path, so
 * an untagged checkpoint still loads; the tag only affects discoverability.
 * See REMEDIATION 3.5.
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
      let content: string;
      try {
        const result = (await readTool.invoke({ path: pathFor(runId) })) as { content: string };
        content = result.content;
      } catch (err) {
        // Only a genuinely absent file means "no prior checkpoint". Every
        // other read failure — a broken RPC, a permission error, a daemon
        // that went away — used to be swallowed into null, so a transient
        // fault looked exactly like a fresh run and resume() silently
        // restarted from scratch, re-executing everything the checkpoint
        // existed to avoid re-executing.
        //
        // Resident-app errors cross the wire as plain strings rather than
        // typed codes (see Computer's dispatch()), so this matches on the
        // message. That is not pretty, and it is why the test asserts both
        // directions: guessing wrong in the "absent" direction resurrects the
        // original bug, and guessing wrong the other way makes every first
        // run throw.
        if (isNotFound(err)) return null;
        throw new CheckpointReadError(runId, err);
      }

      try {
        return JSON.parse(content) as T;
      } catch (err) {
        // Unparseable content is not an absent checkpoint — it is a torn or
        // corrupted one, the failure mode save()'s lack of a rename primitive
        // can't rule out. Returning null here would quietly restart the run.
        throw new CheckpointReadError(runId, err);
      }
    },
  };
}
