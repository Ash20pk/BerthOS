import type { ComputerHandle } from "./computer.js";
import type { AgentMessage } from "./types.js";
import { findExportTool } from "./checkpoint.js";

/**
 * Checkpointing (checkpoint.ts) is durable *run* resume — the same logical
 * task, picked back up after a crash. A Session is a different thing
 * entirely: shared conversation history across *separate* run() calls (a
 * chat UI's turns, say), the seam OpenAI SDK Sessions, ADK's
 * SessionService/MemoryService, and CrewAI's short-term memory all cover.
 * "It's in Semantic FS" was an architecture claim before this, not an API
 * @berth/agents exposed — Session is that API. Deliberately narrow, the
 * same "save/load, nothing fancier" posture CheckpointStore has: no
 * summarization, no entity/long-term memory, no automatic trimming — see
 * docs/agents-reference.md for what a caller still owns.
 */
export interface Session {
  /** Every item recorded so far, oldest first. */
  getItems(): Promise<AgentMessage[]>;
  /** Appends new items — never replaces what's already there. */
  addItems(items: AgentMessage[]): Promise<void>;
  /** Drops every item — starts the next run() call with no prior history. */
  clear(): Promise<void>;
}

/** The default, ephemeral backend — history lives only as long as this process does. Good for a dev loop or a single-process chat server; a restart loses it, same tradeoff any in-memory store has. */
export function createInMemorySession(initial: AgentMessage[] = []): Session {
  let items = [...initial];
  return {
    async getItems() {
      return [...items];
    },
    async addItems(newItems) {
      items = [...items, ...newItems];
    },
    async clear() {
      items = [];
    },
  };
}

const CONTEXT_DIR = "agent-sessions";

/**
 * A Session backed by Semantic FS, reached the same way
 * createSemanticFsCheckpointStore() reaches it: through a resident app's
 * write_context_file/read_context_file/tag_context_file exports. One JSON
 * array per sessionId at /context/agent-sessions/<sessionId>.json,
 * read-modify-write on every addItems() call (same tradeoff
 * createSemanticFsStepTracer() already has for its own per-runId file) —
 * fine for a chat-length history, not built for high-frequency concurrent
 * writers to the same sessionId. Resolves its three tools eagerly, at
 * construction, so a Computer missing them fails fast rather than on the
 * first getItems()/addItems() call deep inside a run.
 */
export function createSemanticFsSession(computer: ComputerHandle, sessionId: string): Session {
  const writeTool = findExportTool(computer.tools, "write_context_file", "createSemanticFsSession()");
  const readTool = findExportTool(computer.tools, "read_context_file", "createSemanticFsSession()");
  const tagTool = findExportTool(computer.tools, "tag_context_file", "createSemanticFsSession()");
  const path = `${CONTEXT_DIR}/${sessionId}.json`;

  const getItems = async (): Promise<AgentMessage[]> => {
    try {
      const result = (await readTool.invoke({ path })) as { content: string };
      return JSON.parse(result.content) as AgentMessage[];
    } catch {
      // Same "can't tell missing from a real read error" caveat
      // CheckpointStore.load() already has, for the same reason: a
      // resident-app export error crosses the RPC wire as a plain string,
      // not a typed error code.
      return [];
    }
  };

  return {
    getItems,
    async addItems(newItems) {
      const existing = await getItems();
      await writeTool.invoke({ path, content: JSON.stringify([...existing, ...newItems]) });
      await tagTool.invoke({ path, task: sessionId, relatedApps: [] });
    },
    async clear() {
      await writeTool.invoke({ path, content: JSON.stringify([]) });
    },
  };
}
