/**
 * Readable text from an HTML page, without a DOM. A single pass over the
 * markup: comments and non-content elements (script, style, svg, head…) are
 * skipped whole, block elements become line breaks, every other tag becomes a
 * word break, and text is kept, entity-decoded. Links are collected on the
 * way. Good enough for an agent reading a page; not a renderer
 * (browser-native is the app for pages that need JavaScript).
 *
 * A scanner rather than regex replacement on purpose: there is no partial
 * "remove <script>…</script>" step that nested or unclosed markup can defeat,
 * because nothing is ever put back together from what's left.
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

// Not "head": its <title> is read, and the rest of it (meta, link, base)
// holds no text.
const SKIPPED = new Set(["script", "style", "noscript", "svg", "template", "iframe", "object"]);
const BLOCKS = new Set([
  "br", "hr", "p", "div", "section", "article", "header", "footer", "main", "nav", "aside",
  "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "tr", "table", "pre", "blockquote",
  "dl", "dt", "dd", "figure", "figcaption", "title",
]);
const MAX_LINKS = 100;

function attribute(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

/** Where the element opened at `from` ends, i.e. just past its closing tag, or the end of the input. */
function skipElement(html: string, from: number, name: string): number {
  const close = new RegExp(`</${name}\\s*>`, "ig");
  close.lastIndex = from;
  const m = close.exec(html);
  return m ? m.index + m[0].length : html.length;
}

export function pageFromHtml(html: string, baseUrl: string): Page {
  const out: string[] = [];
  const links: Page["links"] = [];
  let title = "";
  let openLink: { href: string; start: number } | undefined;

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(decode(html.slice(i)));
      break;
    }
    if (lt > i) out.push(decode(html.slice(i, lt)));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break; // an unclosed tag at the end: nothing after it is text
    const tag = html.slice(lt, gt + 1);
    i = gt + 1;

    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (!m) {
      // <!DOCTYPE …>, <?xml …?>, or a stray "<": not content.
      out.push(" ");
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();

    if (!closing && name === "title") {
      const end = skipElement(html, i, "title");
      const inner = html.slice(i, end).replace(/<\/title\s*>$/i, "");
      if (!title) title = decode(inner).replace(/\s+/g, " ").trim();
      i = end;
      continue;
    }
    if (!closing && SKIPPED.has(name)) {
      i = skipElement(html, i, name);
      out.push(" ");
      continue;
    }
    if (name === "a") {
      if (!closing) {
        const href = attribute(tag, "href");
        if (href) openLink = { href, start: out.length };
      } else if (openLink) {
        let absolute: URL | undefined;
        try {
          absolute = new URL(openLink.href, baseUrl);
        } catch {
          absolute = undefined;
        }
        // Only links the agent could follow with this app: not javascript:,
        // data:, vbscript:, mailto: or anything else.
        if (absolute && (absolute.protocol === "http:" || absolute.protocol === "https:") && links.length < MAX_LINKS) {
          const text = out.slice(openLink.start).join("").replace(/\s+/g, " ").trim();
          if (!links.some((l) => l.href === absolute!.toString())) links.push({ text, href: absolute.toString() });
        }
        openLink = undefined;
      }
    }
    out.push(BLOCKS.has(name) ? "\n" : " ");
  }

  const text = out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text, links };
}
