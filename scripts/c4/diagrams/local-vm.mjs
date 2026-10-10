export default {
  name: "local-vm",
  w: 1160,
  h: 860,
  title: "Local microVM runtime: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 300, h: 480, label: "Host" },
    { x: 20, y: 580, w: 1130, h: 220, label: "microVM guest", sub: "pinned kernel and erofs rootfs, no network device" },
  ],
  boxes: [
    { kind: "container", name: "berth CLI", type: "Container: Node.js", desc: "berth dev, mcp, rpc, vm. Bundles the app, finds the VM again by its run directory", x: 40, y: 60, w: 260, h: 140 },
    { kind: "external", name: "vm-artifacts release", type: "External System: GitHub", desc: "Kernel, rootfs, berth-vmm, checked against pins", x: 500, y: 70, w: 250, h: 120 },
    { kind: "external", name: "Internet hosts", type: "External System", desc: "Only those in --egress-allow", x: 875, y: 70, w: 250, h: 120 },
    { kind: "container", name: "berth-vmm", type: "Container: Rust + libkrun", desc: "One VM per process. Hosts the egress dialer. Under Seatbelt on macOS", x: 40, y: 330, w: 260, h: 150 },
    { kind: "container", name: "berth-init", type: "Container: Rust, PID 1", desc: "Compiles the policy, reads the secrets disk, starts the apps and daemons", x: 40, y: 610, w: 240, h: 140 },
    { kind: "container", name: "Resident app", type: "Container: Node.js or Python", desc: "Own uid and cgroup, under Landlock and seccomp", x: 480, y: 610, w: 220, h: 140 },
    { kind: "container", name: "Guest daemons", type: "Container: in the guest", desc: "Context bus, semantic-fs, egress broker; GitHub broker when declared", x: 840, y: 610, w: 280, h: 140 },
  ],
  edges: [
    { pts: [[300, 130], [498, 130]], label: "berth vm install\n[HTTPS]", at: [400, 130] },
    { pts: [[170, 200], [170, 328]], label: "spawns, then talks over\n[Unix sockets in run dir]", at: [170, 265] },
    { pts: [[170, 480], [170, 608]], label: "control, logs, RPC\n[vsock 1024, 1025, 5000+i]", at: [170, 545] },
    { pts: [[280, 680], [478, 680]], label: "starts each app\n[agent-init]", at: [380, 680] },
    { pts: [[700, 680], [838, 680]], label: "[Unix sockets,\n127.0.0.1:8090]", at: [769, 680] },
    { pts: [[980, 608], [980, 450], [302, 450]], label: "allowed connections\n[vsock 1026]", at: [640, 450] },
    { pts: [[300, 370], [1000, 370], [1000, 192]], label: "dials, checks again\n[TCP]", at: [640, 370] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
