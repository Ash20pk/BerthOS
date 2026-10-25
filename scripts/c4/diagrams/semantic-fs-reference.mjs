export default {
  name: "semantic-fs-reference",
  w: 980,
  h: 600,
  title: "Semantic FS: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 300, h: 270, label: "App container" },
    { x: 620, y: 30, w: 320, h: 270, label: "Sidecar container, per sandbox" },
  ],
  boxes: [
    { kind: "container", name: "Resident app", type: "Container: Node.js or Python + SDK", desc: "Writes files under /context; tags and searches them. The SDK computes the embeddings", x: 50, y: 60, w: 240, h: 165 },
    { kind: "container", name: "semantic-fs-daemon", type: "Container: Go, FUSE", desc: "Serves /context and the control socket. Holds CAP_SYS_ADMIN only until mounted", x: 650, y: 60, w: 240, h: 165 },
    { kind: "container", name: "Backing store and index", type: "Data store: volume + SQLite", desc: "The files behind /context; tags and embeddings by path", x: 650, y: 400, w: 240, h: 130, shape: "db" },
    { kind: "container", name: "berth snapshot", type: "Container: berth CLI", desc: "Captures the backing directory and the index", x: 50, y: 400, w: 240, h: 130 },
  ],
  edges: [
    { pts: [[290, 110], [648, 110]], label: "file reads and writes\n[FUSE mount at /context]", at: [470, 110] },
    { pts: [[290, 185], [648, 185]], label: "register, tag, query\n[Unix socket]", at: [470, 185] },
    { pts: [[862, 225], [862, 400]], label: "passes writes through,\nupdates the index", at: [862, 345] },
    { pts: [[290, 465], [648, 465]], label: "archives both\n[tar]", at: [470, 465] },
  ],
  legendKinds: [["container", "Container"]],
};
