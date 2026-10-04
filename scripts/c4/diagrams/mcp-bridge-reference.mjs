export default {
  name: "mcp-bridge-reference",
  w: 1090,
  h: 560,
  title: "MCP bridge: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 300, w: 260, h: 200, label: "microVM sandbox", sub: "--runtime vm" },
    { x: 400, y: 300, w: 280, h: 200, label: "Sandbox", sub: "berth-dev-<app>, Docker" },
  ],
  boxes: [
    { kind: "external", name: "MCP client", type: "Claude Code, Cursor, ...", desc: "Spawns the bridge from its config and calls its tools", x: 40, y: 60, w: 220, h: 125 },
    { kind: "container", name: "berth mcp", type: "Container: Node.js, on the host", desc: "One export, one tool. Boots or attaches to the sandbox, explains denials", x: 420, y: 60, w: 240, h: 125 },
    { kind: "container", name: "Audit trail", type: "Container: ~/.berth/audit/audit.jsonl", desc: "Each call: allowed, denied or failed, tagged with the run id", x: 830, y: 60, w: 230, h: 125, shape: "db" },
    { kind: "container", name: "Resident app", type: "Container: under agent-init", desc: "Landlock and seccomp policy from its berth.yml", x: 420, y: 330, w: 240, h: 125 },
    { kind: "container", name: "Resident app", type: "Container: berth-vmm, agent-init", desc: "The same policy, on Berth's pinned kernel", x: 40, y: 330, w: 220, h: 125 },
  ],
  edges: [
    { pts: [[260, 122], [418, 122]], label: "tools/call\n[MCP over stdio]", at: [339, 122] },
    { pts: [[660, 122], [828, 122]], label: "appends records\n[JSONL]", at: [744, 122] },
    { pts: [[600, 185], [600, 328]], label: "RPC per call\n[container stdio]", at: [600, 256] },
    { pts: [[460, 185], [460, 256], [150, 256], [150, 328]], label: "RPC per call\n[rpc-<i>.sock]", at: [300, 256] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
