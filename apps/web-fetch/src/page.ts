/**
 * Readable text from an HTML page, without a DOM: drop what isn't content
 * (script, style, svg, head), turn block elements into line breaks, strip the
 * remaining tags, decode entities, and collapse whitespace. Good enough for an
 * agent reading a page; not a renderer (browser-native is the app for pages
 * that need JavaScript).
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export interface Page {
  title: string;
  text: string;
  links: { text: string; href: string }[];
}

export function pageFromHtml(html: string, baseUrl: string): Page {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, "");

  const links: Page["links"] = [];
  for (const m of body.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decode(m[2] ?? m[3] ?? m[4] ?? "");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const text = decode(m[5]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!links.some((l) => l.href === absolute)) links.push({ text, href: absolute });
    if (links.length === 100) break;
  }

  const text = decode(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|ul|ol|tr|table|pre|blockquote|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, "\n")
      // A space, not nothing: adjacent inline elements (<a>Next</a><a>Out</a>)
      // are separate words; the whitespace is collapsed below.
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text, links };
}
