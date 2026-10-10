export default {
  name: "design-microvm-spike",
  w: 1180,
  h: 770,
  title: "libkrun spike: containers (C4 level 2)",
  boundaries: [
    { x: 30, y: 40, w: 240, h: 440, label: "Host", sub: "macOS" },
    { x: 430, y: 40, w: 730, h: 440, label: "Guest", sub: "one microVM" },
  ],
  boxes: [
    { kind: "container", name: "Host script", type: "Container: Node.js or shell", desc: "boot-notes.mjs or run-probe.sh: boots the VM, calls the app", x: 45, y: 70, w: 210, h: 120 },
    { kind: "container", name: "berth-vmm", type: "Container: Rust, libkrun on HVF", desc: "One VM per process: no NIC, TSI off, one vsock port", x: 45, y: 300, w: 210, h: 140 },
    { kind: "container", name: "notes app", type: "Container: Node.js under agent-init", desc: "node /app/runtime.mjs as uid 10000, Landlock and seccomp", x: 470, y: 70, w: 230, h: 120 },
    { kind: "container", name: "Guest kernel", type: "Container: linux 6.12.109", desc: "Our config: Landlock on, no dummy0, no io_uring", x: 880, y: 70, w: 250, h: 120 },
    { kind: "container", name: "berth-init.sh", type: "Container: shell, as root", desc: "Exec'd by init.krun (PID 1): mounts, policy compile, socat on vsock 5000", x: 470, y: 300, w: 230, h: 140 },
    { kind: "container", shape: "db", name: "Root and app shares", type: "virtio-fs, read-only", desc: "rootfs-notes as /, the app directory at /app", x: 880, y: 300, w: 250, h: 140 },
    { kind: "container", name: "Builder VMs", type: "Container: berth-vmm --tsi", desc: "Build the kernel, agent-init and the rootfs in Alpine", x: 45, y: 580, w: 210, h: 120 },
    { kind: "external", name: "Alpine CDN, kernel.org", type: "External System", desc: "Packages, minirootfs and kernel source", x: 470, y: 580, w: 230, h: 120 },
  ],
  edges: [
    { pts: [[150, 190], [150, 298]], label: "spawns; RPC\n[Unix socket]", at: [150, 245] },
    { pts: [[255, 370], [468, 370]], label: "boots; RPC\n[vsock 5000]", at: [350, 370] },
    { pts: [[585, 300], [585, 192]], label: "socat, one app per\nconnection [stdio]", at: [585, 245] },
    { pts: [[700, 370], [878, 370]], label: "mounts\n[virtio-fs]", at: [789, 370] },
    { pts: [[255, 640], [468, 640]], label: "apk, downloads\n[TCP over TSI]", at: [362, 640] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
