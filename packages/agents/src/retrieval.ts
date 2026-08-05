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

const DEFAULT_CHUNK_MAX_CHARS = 2000;
const DEFAULT_CHUNK_OVERLAP_CHARS = 200;

/**
 * A plain character-window chunker — no NLP, no tokenizer dependency, same
 * "real, and says so" honesty semantic-fs's own v0 keyword-overlap ranking
 * already has elsewhere in this package. Prefers to break at the last
 * paragraph/sentence boundary inside a window over a hard mid-word cut, when
 * one exists past the window's halfway point; a paragraph longer than
 * `maxChars` on its own still gets hard-split. Adjacent chunks share
 * `overlapChars` of text so a fact split across a chunk boundary isn't lost
 * to whichever chunk it landed outside of.
 */
export function chunkText(text: string, options: { maxChars?: number; overlapChars?: number } = {}): string[] {
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_MAX_CHARS;
  const overlapChars = Math.min(options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS, Math.floor(maxChars / 2));
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const windowEnd = Math.min(start + maxChars, trimmed.length);
    let end = windowEnd;
    if (windowEnd < trimmed.length) {
      const window = trimmed.slice(start, windowEnd);
      const breakIndex = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
      if (breakIndex > maxChars * 0.5) {
        end = start + breakIndex + 1;
      }
    }
    const chunk = trimmed.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= trimmed.length) break;
    const nextStart = end - overlapChars;
    start = nextStart > start ? nextStart : end; // always make forward progress, even if overlap would otherwise stall it
  }
  return chunks;
}

const INGEST_DIR = "ingested";

function slugify(source: string): string {
  return source.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

export interface IngestOptions {
  /** Where chunks are written under /context — defaults to a slug derived from `source`. */
  pathPrefix?: string;
  task?: string;
  relatedApps?: string[];
  /** Override the default chunkText() — e.g. a smaller maxChars, or an entirely different splitting strategy. */
  chunk?: (text: string) => string[];
}

/**
 * Gets a document *into* Semantic FS as retrievable chunks — the piece
 * createSemanticFsRetriever() alone never covered: querying always assumed
 * something had already called write_context_file/tag_context_file by hand,
 * chunk by chunk, yourself. Resolves those same two exports off
 * Computer.tools the exact way checkpoint.ts's findExportTool already does
 * for checkpointing/tracing, so this works with any app exposing that
 * contract — not apps/filesystem specifically. Returns the paths written, in
 * order, so a caller can tag or cross-reference them further if needed.
 */
export async function ingest(
  computer: ComputerHandle,
  source: string,
  text: string,
  options: IngestOptions = {},
): Promise<string[]> {
  const writeTool = findExportTool(computer.tools, "write_context_file", "ingest()");
  const tagTool = findExportTool(computer.tools, "tag_context_file", "ingest()");
  const chunk = options.chunk ?? chunkText;
  const chunks = chunk(text);
  const prefix = options.pathPrefix ?? `${INGEST_DIR}/${slugify(source)}`;

  const paths: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const path = chunks.length > 1 ? `${prefix}-${i}.txt` : `${prefix}.txt`;
    await writeTool.invoke({ path, content: chunks[i] });
    await tagTool.invoke({ path, task: options.task ?? source, relatedApps: options.relatedApps ?? [] });
    paths.push(path);
  }
  return paths;
}
