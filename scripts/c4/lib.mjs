// Drawing primitives for the C4 diagrams in docs/images/c4/. Each diagram is
// a file in ./diagrams exporting { name, ...spec }; see ../c4-diagrams.mjs.
//
// A spec: { w, h, title, boundaries, boxes, edges, legendKinds }.
//   box:      { kind: person|system|container|component|external, name, type, desc, x, y, w, h, shape?: "db" }
//   boundary: { x, y, w, h, label, sub? }
//   edge:     { pts: [[x, y], ...], label?: "line\n[tech]", at: [x, y], dashed?, both? }
export const KINDS = {
  person: { fill: "#08427b", stroke: "#073b6f", text: "#ffffff" },
  system: { fill: "#1168bd", stroke: "#0b4884", text: "#ffffff" },
  container: { fill: "#438dd5", stroke: "#3c7fc0", text: "#ffffff" },
  component: { fill: "#85bbf0", stroke: "#5d82a8", text: "#0b2140" },
  external: { fill: "#6b7280", stroke: "#4b5563", text: "#ffffff" },
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Greedy wrap by an average glyph width; good enough for the system sans stack.
function wrap(text, width, px) {
  const max = Math.floor(width / (px * 0.54));
  const out = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > max) {
      out.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) out.push(line);
  return out;
}

function box(b) {
  const k = KINDS[b.kind];
  const { x, y, w, h } = b;
  const parts = [];
  if (b.shape === "db") {
    const ry = 10;
    parts.push(
      `<path d="M${x},${y + ry} a${w / 2},${ry} 0 0 0 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0 1 -${w},0 z" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1.5"/>`,
      `<ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1.5"/>`,
    );
  } else {
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1.5"/>`);
  }
  if (b.kind === "person") {
    parts.push(`<circle cx="${x + w / 2}" cy="${y - 22}" r="20" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1.5"/>`);
  }
  const desc = wrap(b.desc ?? "", w - 24, 12.5);
  const lines = 2 + desc.length;
  const lh = 17;
  const top = y + h / 2 - ((lines - 1) * lh) / 2 + (b.shape === "db" ? 6 : 0);
  const cx = x + w / 2;
  parts.push(`<text x="${cx}" y="${top}" text-anchor="middle" dominant-baseline="middle" fill="${k.text}">`);
  parts.push(`<tspan x="${cx}" font-size="15.5" font-weight="700">${esc(b.name)}</tspan>`);
  parts.push(`<tspan x="${cx}" dy="${lh}" font-size="11.5" opacity="0.85">[${esc(b.type)}]</tspan>`);
  desc.forEach((d, i) => parts.push(`<tspan x="${cx}" dy="${i === 0 ? lh + 3 : lh}" font-size="12.5">${esc(d)}</tspan>`));
  parts.push(`</text>`);
  return parts.join("\n");
}

function boundary(b) {
  return [
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="14" fill="none" class="bd" stroke-width="1.5" stroke-dasharray="7 5"/>`,
    `<text x="${b.x + 16}" y="${b.y + b.h - 14}" class="bl" font-size="13.5" font-weight="700">${esc(b.label)}</text>`,
    b.sub ? `<text x="${b.x + 16}" y="${b.y + b.h - 14}" dx="${b.label.length * 7.6 + 6}" class="bl" font-size="12">${esc(b.sub)}</text>` : "",
  ].join("\n");
}

// An edge is a polyline through `pts`, with its label centred on `at`.
function edge(e) {
  const d = e.pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const out = [`<path d="${d}" fill="none" class="ln" stroke-width="1.6"${e.dashed ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#arrow)"${e.both ? ' marker-start="url(#arrow-start)"' : ""}/>`];
  if (e.label) {
    const lines = e.label.split("\n");
    const w = Math.max(...lines.map((l) => l.length)) * 7.1 + 20;
    const h = lines.length * 16 + 8;
    const [ax, ay] = e.at;
    out.push(`<rect x="${ax - w / 2}" y="${ay - h / 2}" width="${w}" height="${h}" rx="6" class="pill"/>`);
    out.push(`<text x="${ax}" y="${ay - ((lines.length - 1) * 16) / 2}" text-anchor="middle" dominant-baseline="middle" font-size="12" class="pt">`);
    lines.forEach((l, i) => out.push(`<tspan x="${ax}" dy="${i ? 16 : 0}"${l.startsWith("[") ? ' font-style="italic"' : ""}>${esc(l)}</tspan>`));
    out.push(`</text>`);
  }
  return out.join("\n");
}

function legend(x, y, kinds) {
  const out = [];
  let cx = x;
  for (const [kind, label] of kinds) {
    const k = KINDS[kind];
    out.push(`<rect x="${cx}" y="${y}" width="16" height="16" rx="4" fill="${k.fill}" stroke="${k.stroke}"/>`);
    out.push(`<text x="${cx + 22}" y="${y + 12.5}" font-size="12.5" class="bl">${label}</text>`);
    cx += 30 + label.length * 7;
  }
  return out.join("\n");
}

export function svg({ w, h, title, boundaries = [], boxes, edges, legendKinds }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .ln { stroke: #57606a; }
  .bd { stroke: #8c959f; }
  .bl { fill: #57606a; }
  .ah { fill: #57606a; }
  .pill { fill: #f6f8fa; stroke: #d0d7de; }
  .pt { fill: #24292f; }
  @media (prefers-color-scheme: dark) {
    .ln { stroke: #8b949e; }
    .bd { stroke: #6e7681; }
    .bl { fill: #9198a1; }
    .ah { fill: #8b949e; }
    .pill { fill: #161b22; stroke: #30363d; }
    .pt { fill: #e6edf3; }
  }
</style>
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah"/></marker>
  <marker id="arrow-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah"/></marker>
</defs>
${boundaries.map(boundary).join("\n")}
${edges.map(edge).join("\n")}
${boxes.map(box).join("\n")}
${legendKinds ? legend(24, h - 34, legendKinds) : ""}
</svg>
`;
}

