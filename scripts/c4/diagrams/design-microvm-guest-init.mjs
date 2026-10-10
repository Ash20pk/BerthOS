export default {
  name: "design-microvm-guest-init",
  w: 1180,
  h: 560,
  title: "berth-init: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 280, h: 470, label: "Host" },
    { x: 380, y: 30, w: 780, h: 470, label: "Guest", sub: "microVM, no NIC" },
  ],
  boxes: [
    { kind: "container", name: "Host client", type: "Container: e2e script or CLI", desc: "Reads control and logs, sends RPC calls, asks for shutdown", x: 40, y: 60, w: 240, h: 125 },
    { kind: "container", name: "berth-vmm", type: "Container: Rust + libkrun", desc: "Boots the guest; maps each vsock port to a Unix socket", x: 40, y: 330, w: 240, h: 125 },
    { kind: "container", name: "berth-init", type: "Container: Rust, PID 1", desc: "Mounts, cgroups, policies, identities; starts daemons and apps; relays vsock", x: 420, y: 330, w: 240, h: 125 },
    { kind: "container", name: "context-bus-daemon", type: "Container: Rust, uid 9001", desc: "Confined under agent-init, in /berth/daemons", x: 880, y: 60, w: 240, h: 125 },
    { kind: "container", name: "App i", type: "Container: Node.js, uid 10000+i", desc: "SDK runtime under agent-init, in its own cgroup", x: 880, y: 330, w: 240, h: 125 },
  ],
  edges: [
    { pts: [[160, 185], [160, 328]], label: "connects\n[Unix sockets]", at: [160, 257] },
    { pts: [[280, 392], [418, 392]], label: "1024, 1025,\n5000+i [vsock]", at: [349, 392] },
    { pts: [[660, 392], [878, 392]], label: "starts it, relays RPC\n[rpc.sock]", at: [769, 392] },
    { pts: [[540, 330], [540, 122], [878, 122]], label: "starts it confined\n[agent-init]", at: [709, 122] },
    { pts: [[1000, 330], [1000, 187]], label: "registers\n[bus socket]", at: [1000, 258] },
  ],
  legendKinds: [["container", "Container"]],
};
