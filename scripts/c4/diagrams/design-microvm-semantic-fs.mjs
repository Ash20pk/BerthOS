export default {
  name: "design-microvm-semantic-fs",
  w: 1180,
  h: 600,
  title: "semantic-fs in the microVM: containers (C4 level 2)",
  boundaries: [{ x: 20, y: 30, w: 1140, h: 520, label: "Guest", sub: "microVM" }],
  boxes: [
    { kind: "container", name: "App i", type: "Container: Node.js, uid 10000+i", desc: "Declares filesystem:read or write:/context; the SDK embeds and tags", x: 40, y: 60, w: 250, h: 135 },
    { kind: "container", name: "semantic-fs daemon", type: "Container: Go, root", desc: "FUSE passthrough at /context and the tag/query control socket; narrows its capabilities after mounting", x: 470, y: 60, w: 260, h: 145 },
    { kind: "container", name: "berth-init", type: "Container: Rust, PID 1", desc: "Waits for the FUSE mount at /context, then boots the apps", x: 900, y: 60, w: 240, h: 125 },
    { kind: "container", name: "embeddings daemon", type: "Container: Node.js, uid 9004", desc: "One model per sandbox, loaded on the first request", x: 40, y: 330, w: 250, h: 125 },
    { kind: "container", name: "Context store", type: "Data store: ext4 state disk or tmpfs", desc: "/state/context on the state disk, /run/berth/context on tmpfs without one", x: 470, y: 330, w: 260, h: 125, shape: "db" },
  ],
  edges: [
    { pts: [[290, 100], [468, 100]], label: "file calls\n[FUSE /context]", at: [379, 100] },
    { pts: [[290, 165], [468, 165]], label: "tag, query\n[Unix socket]", at: [379, 165] },
    { pts: [[898, 122], [732, 122]], label: "starts it as root,\nbefore any app", at: [815, 122] },
    { pts: [[600, 205], [600, 328]], label: "data/ and index.db\n[files, SQLite]", at: [600, 267] },
    { pts: [[165, 195], [165, 328]], label: "embed text\n[embed.sock]", at: [165, 262] },
    { pts: [[1020, 185], [1020, 500], [165, 500], [165, 457]], label: "starts it when an app declares /context [agent-init]", at: [600, 500] },
  ],
  legendKinds: [["container", "Container"]],
};
