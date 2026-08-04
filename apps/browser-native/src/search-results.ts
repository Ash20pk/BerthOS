export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_MAX_RESULTS = 5;

/** DuckDuckGo's server-rendered (no-JS) HTML endpoint — no API key, and friendly to a headless browser, unlike Google/Bing which routinely challenge or block one. */
export function buildSearchUrl(query: string): string {
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo wraps each result's real target in a `/l/?uddg=<encoded-url>` redirect link — decode it back to the actual URL rather than exposing that redirect link as the "url" a model would then have to navigate through again. */
function resolveResultUrl(href: string): string {
  const match = href.match(/uddg=([^&]+)/);
  const encoded = match?.[1];
  if (encoded === undefined) return href;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return href;
  }
}

/**
 * Regex-based extraction of DuckDuckGo's `result__a`/`result__snippet` markup
 * — not a real HTML parser (no such dependency exists anywhere in this
 * monorepo, and pulling one in for a single small feature isn't worth it).
 * Fragile to a markup change on DuckDuckGo's end, same honesty this repo
 * already applies to semantic-fs's "v0 keyword-overlap ranking, not real
 * semantic search" — this is v0 web search, not a robust scraper.
 */
export function parseSearchResults(html: string, maxResults: number = DEFAULT_MAX_RESULTS): SearchResult[] {
  const titleMatches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs)];
  const snippetMatches = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs)];

  const results: SearchResult[] = [];
  for (let i = 0; i < titleMatches.length && results.length < maxResults; i++) {
    const titleMatch = titleMatches[i];
    if (!titleMatch) continue;
    const [, href, rawTitle] = titleMatch;
    const title = stripTags(rawTitle ?? "");
    if (!title || !href) continue;
    const snippetMatch = snippetMatches[i];
    results.push({
      title,
      url: resolveResultUrl(href),
      snippet: snippetMatch ? stripTags(snippetMatch[1] ?? "") : "",
    });
  }
  return results;
}
