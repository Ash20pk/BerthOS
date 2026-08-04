import type { ComputerHandle } from "./computer.js";
import type { Tool } from "./types.js";
import { findExportTool } from "./checkpoint.js";

export interface RetrievedDocument {
  path: string;
  content: string;
  task?: string;
  relatedApps?: string[];
}

/**
 * The retrieval seam Agent tool lists plug a search_context Tool through —
 * as narrow as "text in, ranked documents out", so a backend other than
 * Semantic FS (a real vector DB, a plain grep) can implement it without
 * pulling in a Computer at all.
 */
export interface Retriever {
  retrieve(text: string, opts?: { topK?: number }): Promise<RetrievedDocument[]>;
  /** Wraps this retriever as a Tool an Agent can call directly, alongside resident-app exports. */
  asTool(name?: string): Tool;
}

const DEFAULT_TOP_K = 5;

/**
 * A Retriever backed by Semantic FS's real hybrid keyword+embedding query,
 * reached through apps/filesystem's query_context/read_context_file exports
 * the same way checkpointing/tracing reach write_context_file et al.
 *
 * query_context alone only ever returns metadata (path/task/relatedApps/
 * timestamps — see @berth/sdk's SemanticFsQueryResult), never the file's
 * actual content, so calling it directly forces the model into an N+1
 * round trip (one query_context call, then one read_context_file call per
 * hit) just to get anything it can reason over. retrieve() collapses that
 * into a single call, which is what asTool() exposes as one LLM-callable
 * "search_context" tool.
 */
export function createSemanticFsRetriever(computer: ComputerHandle): Retriever {
  const queryTool = findExportTool(computer.tools, "query_context", "createSemanticFsRetriever()");
  const readTool = findExportTool(computer.tools, "read_context_file", "createSemanticFsRetriever()");

  async function retrieve(text: string, opts: { topK?: number } = {}): Promise<RetrievedDocument[]> {
    const topK = opts.topK ?? DEFAULT_TOP_K;
    const { results } = (await queryTool.invoke({ text })) as {
      results: { path: string; task?: string; relatedApps?: string[] }[];
    };

    const documents = await Promise.all(
      results.slice(0, topK).map(async (hit): Promise<RetrievedDocument | null> => {
        try {
          const { content } = (await readTool.invoke({ path: hit.path })) as { content: string };
          return { path: hit.path, content, task: hit.task, relatedApps: hit.relatedApps };
        } catch {
          // Semantic FS indexed this path at tag time, but the file's since been
          // deleted/moved — drop the stale hit rather than fail the whole call.
          return null;
        }
      }),
    );
    return documents.filter((doc): doc is RetrievedDocument => doc !== null);
  }

  return {
    retrieve,
    asTool(name = "search_context"): Tool {
      return {
        name,
        description:
          "Search Semantic FS for context files relevant to a query and return their actual content " +
          "(not just metadata) — a retrieval lookup over whatever this agent or others have tagged via " +
          "tag_context_file.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "what to search for" },
            topK: { type: "number", description: `max number of documents to return (default ${DEFAULT_TOP_K})` },
          },
          required: ["query"],
        },
        invoke: async (input: unknown) => {
          const { query, topK } = input as { query: string; topK?: number };
          return { documents: await retrieve(query, { topK }) };
        },
      };
    },
  };
}
