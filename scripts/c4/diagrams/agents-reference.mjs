export default {
  name: "agents-reference",
  w: 1180,
  h: 770,
  title: "Agent runtime: containers (C4 level 2)",
  boundaries: [
    { x: 380, y: 470, w: 310, h: 235, label: "Computer", sub: "one Docker container" },
  ],
  boxes: [
    { kind: "container", name: "Your program", type: "Container: Node.js, @berthos/agents", desc: "Agent loop, Crew, governance gate; holds the Computer handle", x: 430, y: 40, w: 320, h: 150 },
    { kind: "external", name: "LLM provider API", type: "External System", desc: "Anthropic, OpenAI, Gemini, Azure, Bedrock, Ollama", x: 940, y: 40, w: 220, h: 135 },
    { kind: "external", name: "MCP servers", type: "External System", desc: "Run outside the sandbox, with no Landlock policy", x: 940, y: 290, w: 220, h: 130 },
    { kind: "container", name: "Networked peer", type: "Container: Docker, one per peer", desc: "Its own apps and agent loop in a <name>-agent-server app", x: 30, y: 270, w: 220, h: 145 },
    { kind: "container", name: "berth os up", type: "Container: berth CLI", desc: "Boots a Computer once and leaves it running", x: 30, y: 520, w: 210, h: 130 },
    { kind: "container", name: "Resident apps", type: "Container: Node.js or Python SDK", desc: "Each under its own kernel-enforced berth.yml policy. One can serve the HTTP RPC bridge", x: 400, y: 500, w: 270, h: 145 },
    { kind: "external", name: "Python or remote client", type: "External System", desc: "berth_agents, or any HTTP client", x: 960, y: 510, w: 200, h: 125 },
  ],
  edges: [
    { pts: [[750, 105], [938, 105]], label: "chat\n[HTTP API]", at: [844, 105] },
    { pts: [[720, 190], [720, 355], [938, 355]], label: "tools/call\n[stdio or HTTP]", at: [830, 355] },
    { pts: [[430, 115], [140, 115], [140, 268]], label: "run_task\n[docker exec or HTTP RPC]", at: [285, 115] },
    { pts: [[500, 190], [500, 498]], label: "tool calls\n[stdio attach or docker exec]", at: [500, 340] },
    { pts: [[240, 585], [398, 585]], label: "starts\n[Docker]", at: [319, 585] },
    { pts: [[958, 572], [672, 572]], label: "POST /rpc, bearer token\n[HTTP RPC bridge]", at: [815, 572] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
