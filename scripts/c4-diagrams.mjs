#!/usr/bin/env node
// Generates the README's C4 diagrams as SVG into docs/images/c4/.
//
//   node scripts/c4-diagrams.mjs
//
// Layout is by hand (coordinates below), so the diagrams stay legible at
// GitHub's README width. Colours follow the C4 convention; strokes and labels
// outside the boxes switch with prefers-color-scheme so they read on GitHub's
// light and dark themes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "images", "c4");

const KINDS = {
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

function svg({ w, h, title, boundaries = [], boxes, edges, legendKinds }) {
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

// Level 1: system context
const context = svg({
  w: 1100,
  h: 760,
  title: "Berth: system context (C4 level 1)",
  boxes: [
    { kind: "person", name: "Developer", type: "Person", desc: "Writes resident apps and their berth.yml, runs the berth CLI", x: 50, y: 60, w: 260, h: 120 },
    { kind: "external", name: "AI agent", type: "Software System", desc: "Claude Code, Cursor, any MCP client, or your own tool-calling loop", x: 420, y: 60, w: 260, h: 120 },
    { kind: "person", name: "Reviewer", type: "Person", desc: "Checks what ran in a session, and what was enforced", x: 790, y: 60, w: 260, h: 120 },
    { kind: "system", name: "Berth", type: "Software System", desc: "Runs an agent's tools in a sandbox, each confined to the capabilities its manifest declares", x: 370, y: 330, w: 360, h: 130 },
    { kind: "external", name: "Host kernel or hypervisor", type: "External System", desc: "Linux 6.7+ (Landlock, seccomp, cgroups), or HVF / KVM for the microVM", x: 20, y: 560, w: 245, h: 125 },
    { kind: "external", name: "Internet hosts", type: "External System", desc: "Only the hosts an app declares", x: 295, y: 560, w: 245, h: 125 },
    { kind: "external", name: "GitHub API", type: "External System", desc: "Only the API verbs an app declares", x: 570, y: 560, w: 245, h: 125 },
    { kind: "external", name: "Remote sandboxes", type: "External System", desc: "E2B, Daytona, Kubernetes", x: 845, y: 560, w: 235, h: 125 },
  ],
  edges: [
    { pts: [[180, 180], [180, 255], [470, 255], [470, 328]], label: "builds and runs apps\n[berth CLI]", at: [300, 255] },
    { pts: [[550, 180], [550, 328]], label: "calls tools\n[MCP over stdio, or SDK adapters]", at: [550, 214] },
    { pts: [[920, 180], [920, 255], [630, 255], [630, 328]], label: "verifies attestation records", at: [790, 255] },
    { pts: [[368, 420], [142, 420], [142, 558]], label: "has its policy\nenforced by", at: [142, 500] },
    { pts: [[417, 460], [417, 558]], label: "declared hosts\n[egress broker]", at: [417, 510] },
    { pts: [[692, 460], [692, 558]], label: "declared verbs\n[API broker]", at: [692, 510] },
    { pts: [[732, 420], [962, 420], [962, 558]], label: "deploys apps to\n[deploy adapters]", at: [962, 500] },
  ],
  legendKinds: [["person", "Person"], ["system", "The system"], ["external", "External system"]],
});

// Level 2: containers
const containers = svg({
  w: 1100,
  h: 900,
  title: "Berth: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 230, w: 820, h: 610, label: "Berth", sub: "[Software System]" },
    { x: 45, y: 520, w: 520, h: 260, label: "Sandbox", sub: "one per dev session or MCP server" },
  ],
  boxes: [
    { kind: "person", name: "Developer", type: "Person", desc: "Runs berth init, dev, test, deploy", x: 190, y: 60, w: 240, h: 105 },
    { kind: "external", name: "AI agent", type: "Software System", desc: "Any MCP client", x: 500, y: 60, w: 240, h: 105 },
    { kind: "container", name: "berth CLI", type: "Container: Node.js, @berthos/cli", desc: "Every command. The MCP server, and the host side of every sandbox: bundles apps, boots and stops sandboxes", x: 300, y: 270, w: 330, h: 140 },
    { kind: "container", name: "Audit trail", type: "Data store: JSONL", desc: "Hash-chained; one record per tool call and boot", x: 40, y: 280, w: 170, h: 135, shape: "db" },
    { kind: "container", name: "Container sandbox", type: "Container: Docker / Colima", desc: "The default. Alpine image; entrypoint.sh starts daemons and apps", x: 65, y: 545, w: 230, h: 160 },
    { kind: "container", name: "microVM sandbox", type: "Container: berth-vmm, Rust + libkrun", desc: "Pinned kernel and rootfs, berth-init as PID 1, no network device. --runtime vm", x: 315, y: 545, w: 230, h: 160 },
    { kind: "container", name: "Registry server", type: "Container: Node.js", desc: "Publish, discover, install resident apps. Optional", x: 600, y: 545, w: 215, h: 120 },
    { kind: "container", name: "Mesh coordinator", type: "Container: Node.js", desc: "Introduces sandboxes on a WireGuard mesh. Optional", x: 600, y: 690, w: 215, h: 120 },
    { kind: "external", name: "Remote sandboxes", type: "External System", desc: "E2B, Daytona, Kubernetes", x: 870, y: 280, w: 210, h: 120 },
  ],
  edges: [
    { pts: [[310, 165], [310, 210], [400, 210], [400, 268]], label: "runs", at: [355, 210] },
    { pts: [[620, 165], [620, 210], [540, 210], [540, 268]], label: "tools/call\n[MCP, stdio]", at: [585, 205] },
    { pts: [[298, 347], [212, 347]], label: "appends,\nattests", at: [255, 347] },
    { pts: [[630, 340], [868, 340]], label: "deploys through\n[deploy adapters]", at: [750, 340] },
    { pts: [[380, 410], [380, 470], [180, 470], [180, 543]], label: "RPC to apps\n[stdio relay, docker exec]", at: [250, 470] },
    { pts: [[460, 410], [460, 543]], label: "RPC to apps\n[vsock]", at: [460, 480] },
    { pts: [[560, 410], [560, 460], [707, 460], [707, 543]], label: "publish / install\n[HTTP(S)]", at: [660, 460] },
    { pts: [[565, 750], [598, 750]], dashed: true },
  ],
  legendKinds: [["person", "Person"], ["container", "Container"], ["external", "External system"]],
});

// Level 3: components inside a sandbox
const components = svg({
  w: 1180,
  h: 1150,
  title: "Berth: components inside a sandbox (C4 level 3)",
  boundaries: [
    { x: 20, y: 150, w: 1090, h: 770, label: "Sandbox", sub: "[Container: Docker or microVM]" },
    { x: 295, y: 545, w: 510, h: 175, label: "Resident apps", sub: "one uid and policy each" },
  ],
  boxes: [
    { kind: "container", name: "berth CLI", type: "Container, on the host", desc: "Calls app exports", x: 420, y: 25, w: 260, h: 90 },
    { kind: "component", name: "Init", type: "Component: entrypoint.sh, or berth-init (Rust)", desc: "Mounts, secrets, per-app cgroups; starts everything below; relays RPC", x: 405, y: 185, w: 290, h: 120 },
    { kind: "component", name: "agent-init", type: "Component: Rust", desc: "Compiles a berth.yml into Landlock + seccomp, drops to the app's uid, then execs it", x: 405, y: 365, w: 290, h: 120 },
    { kind: "component", name: "filesystem", type: "Component: app, Node.js SDK", desc: "e.g. read and write /workspace and /context", x: 320, y: 565, w: 220, h: 115 },
    { kind: "component", name: "browser-native", type: "Component: app, Node.js SDK", desc: "e.g. drive Chromium", x: 560, y: 565, w: 220, h: 115 },
    { kind: "component", name: "Context bus", type: "Component: Rust", desc: "Pub/sub between apps, protobuf over a Unix socket", x: 25, y: 365, w: 215, h: 120 },
    { kind: "component", name: "Semantic FS", type: "Component: Go, FUSE", desc: "/context: files tagged by task, queried by meaning", x: 25, y: 565, w: 215, h: 115 },
    { kind: "component", name: "Embeddings daemon", type: "Component: Node.js", desc: "One model per sandbox (microVM)", x: 25, y: 765, w: 215, h: 110 },
    { kind: "component", name: "Display stack", type: "Component: Xvfb, x11vnc, noVNC", desc: "For browser apps; watch it over VNC", x: 860, y: 365, w: 225, h: 120 },
    { kind: "component", name: "Egress broker", type: "Component: Node.js", desc: "Allows only declared hosts (network:host, browser:navigate)", x: 860, y: 565, w: 225, h: 115 },
    { kind: "component", name: "GitHub API broker", type: "Component: Node.js", desc: "Allows only declared API verbs (github:*)", x: 860, y: 765, w: 225, h: 110 },
    { kind: "external", name: "Kernel", type: "Landlock, seccomp, cgroups", desc: "Checks every syscall against the app's policy", x: 410, y: 975, w: 280, h: 110 },
    { kind: "external", name: "Internet hosts", type: "External System", desc: "Reached only through the brokers", x: 860, y: 975, w: 225, h: 110 },
  ],
  edges: [
    { pts: [[550, 115], [550, 183]], label: "RPC\n[stdio relay, or vsock]", at: [550, 148] },
    { pts: [[550, 305], [550, 363]], label: "starts every app and daemon through", at: [550, 334] },
    { pts: [[550, 485], [550, 543]], label: "applies the policy, then execs", at: [550, 514] },
    { pts: [[240, 440], [340, 440], [340, 563]], label: "publish /\nsubscribe", at: [340, 515], both: true },
    { pts: [[320, 622], [242, 622]], label: "/context", at: [281, 622] },
    { pts: [[132, 680], [132, 763]], label: "embeds text\nthrough", at: [132, 722] },
    { pts: [[780, 622], [858, 622]], label: "proxy", at: [819, 622] },
    { pts: [[760, 565], [760, 440], [858, 440]], label: "draws\ninto", at: [760, 515] },
    { pts: [[700, 720], [700, 820], [858, 820]], label: "GitHub calls", at: [775, 820] },
    { pts: [[1085, 622], [1140, 622], [1140, 1030], [1087, 1030]], label: "declared\nhosts", at: [1140, 945] },
    { pts: [[972, 875], [972, 973]], label: "api.github.com only", at: [972, 940] },
    { pts: [[550, 720], [550, 973]], dashed: true, label: "every syscall checked by", at: [550, 940] },
  ],
  legendKinds: [["container", "Container"], ["component", "Component"], ["external", "External"]],
});

mkdirSync(OUT, { recursive: true });
for (const [name, body] of Object.entries({ "1-context": context, "2-containers": containers, "3-components": components })) {
  writeFileSync(join(OUT, `${name}.svg`), body);
  console.log(join("docs/images/c4", `${name}.svg`));
}
