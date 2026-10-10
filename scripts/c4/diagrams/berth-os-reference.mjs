export default {
  name: "berth-os-reference",
  w: 1100,
  h: 600,
  title: "Berth OS: containers (C4 level 2)",
  boundaries: [
    { x: 416, y: 320, w: 664, h: 210, label: "Docker" },
  ],
  boxes: [
    { kind: "container", name: "berth os up", type: "Container: berth CLI, Node.js", desc: "Builds a production image for the apps and starts the container", x: 40, y: 60, w: 220, h: 125 },
    { kind: "container", name: "State file", type: "Container: ~/.berth/os/<name>.json", desc: "Container name, apps, HTTP bridge URL and token", x: 430, y: 60, w: 220, h: 125, shape: "db" },
    { kind: "container", name: "Agent code", type: "Container: Node.js, @berthos/agents", desc: "Computer.connect(), createAgent(), runAgent()", x: 820, y: 60, w: 240, h: 125 },
    { kind: "external", name: "Client with no Docker", type: "e.g. the Python client", desc: "Calls one app's exports over the HTTP bridge", x: 20, y: 360, w: 210, h: 125 },
    { kind: "container", name: "Berth OS", type: "Container: berth-os-<name>", desc: "Resident apps, each its own uid and policy; the context bus; the HTTP bridge with --http-rpc", x: 430, y: 350, w: 220, h: 145 },
    { kind: "container", name: "Semantic FS sidecar", type: "Container: berth-os-<name>-fs", desc: "By default, runs semantic-fs-daemon and mounts /context", x: 840, y: 360, w: 220, h: 125 },
  ],
  edges: [
    { pts: [[260, 122], [428, 122]], label: "writes\n[JSON, mode 0600]", at: [344, 122] },
    { pts: [[820, 122], [652, 122]], label: "reads\n[JSON]", at: [736, 122] },
    { pts: [[240, 185], [240, 250], [500, 250], [500, 348]], label: "builds, starts\n[Docker API]", at: [370, 250] },
    { pts: [[940, 185], [940, 250], [600, 250], [600, 348]], label: "calls exports\n[docker exec]", at: [770, 250] },
    { pts: [[230, 422], [428, 422]], label: "calls exports\n[HTTP, bearer token]", at: [318, 422] },
    { pts: [[838, 422], [652, 422]], label: "/context mount\n[FUSE, bind]", at: [745, 422] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
