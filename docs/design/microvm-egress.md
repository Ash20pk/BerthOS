# microVM egress: the in-guest broker, and a host dialer behind vsock 1026

Date: 2026-10-01. Branch `feat/vm-egress`, from main f348469 (feat/vm-runtime merged). Machine: Apple M4, macOS 27.0, HVF, libkrun 1.19.6.

The microVM has no NIC and TSI is off, so an app that declares `network:host:<pattern>` had no way out at all (`microvm-runtime.md`, open problem 4). This adds one, and only one: the same egress broker the container runs, inside the guest, whose upstream connections leave through a vsock port to a dialer in `berth-vmm` on the host. The dialer enforces the sandbox's allowlist again, on its own, and is the only code that touches the host's network.

Status and evidence are at the end (Results). berth-vmm does not read manifests: the CLI computes the allowlist and passes it with `--egress-allow`.

## Context

An app in a microVM sandbox that declares `network:host:<pattern>` or `browser:navigate:<pattern>` reaches the internet this way and no other. The app and the egress broker run in the guest. On the host, the CLI starts `berth-vmm` with the sandbox's allowlist, and berth-vmm's dialer is the only code that connects to the declared internet hosts.

The broker's container behaviour, and what a host pattern covers, are in [`../egress-broker-reference.md`](../egress-broker-reference.md). For where the microVM sits in Berth, see [`../local-vm.md`](../local-vm.md).

## Containers

The diagram under Design is the container view: the app, the broker and berth-init in the guest, the dialer in `berth-vmm` on the host, and the vsock port between them.

### Design

```
guest (no NIC, TSI off)                                   host (berth-vmm process)
┌───────────────────────────────────────────────────┐
│ app uid 10000+i (agent-init: Landlock, seccomp)   │
│   fetch() ─ configureEgressProxy()                │
│   BERTH_EGRESS_PROXY_URL=http://127.0.0.1:8090    │
│   Landlock: TCP connect to port 8090 only         │
│   (network:connect:8090), no AF_VSOCK             │
│        │ CONNECT example.com:443                  │
│        ▼                                          │
│ egress broker, uid 9002 (agent-init: Landlock,    │
│   seccomp; bind 8090 only, no TCP connect)        │
│   gate 1: declared host patterns, ports,          │
│   dedicated-broker hosts, IP-literal block list   │
│        │ DIAL example.com 443                     │
│        ▼  /run/berth/egress/dial.sock             │
│   (root:berth-egress 0660, dir 0750)              │
│ berth-init (PID 1): byte relay, unix → vsock      │
│        │ AF_VSOCK connect(CID 2, port 1026)       │
└────────┼──────────────────────────────────────────┘
         └────────── libkrun vsock muxer ───────────▶ <run-dir>/egress.sock
                                                      egress dialer (berth-vmm thread)
                                                        gate 2: --egress-allow (from the CLI,
                                                        never from the guest), own DNS,
                                                        address block list after resolution,
                                                        connection cap, one log line per dial
                                                        │ TCP connect(pinned address)
                                                        ▼
                                                      example.com:443 (TLS end to end: app ↔ remote)
```

#### The protocol on vsock 1026

The guest connects out (libkrun's non-listen mapping: guest `connect(CID 2, 1026)` → libkrun connects to `<run-dir>/egress.sock`, where the dialer listens). One connection is one tunnel:

```
guest → host   DIAL example.com 443\n                 one line, ≤ 1 KiB, within 5 s; single spaces, nothing else
host  → guest  OK 93.184.215.14\n                     then raw bytes both ways until either side closes
           or  ERR <code> <message>\n                 and close; code: denied | unresolved | unreachable | busy | bad_request
```

A text frame rather than JSON: berth-vmm has no dependencies, and a grammar of three tokens is easier to hold strictly than a JSON parser. The port is decimal with no leading zero; the host is a lowercased DNS name (`[a-z0-9-]` labels of at most 63 bytes, no empty labels) or an IP literal, and a name whose last label is numeric must be a canonical dotted quad, so `127.1` and `2130706433` are refused before any lookup (the address check would refuse them after, too).

There is no `resolve` op. The guest has no resolver to give it (no NIC, empty `resolv.conf`), and a separate resolve would open a window between the address the guest was told and the one the host dials. The dialer resolves on dial and pins; the broker sends names, and it only checks IP *literals* against its own block list (defence in depth; the host checks them again). `address` in the reply is informational, for the broker's log.

The dialer never terminates TLS: after `ok` it copies bytes. TLS is between the app and the remote, as it is through the container broker's `CONNECT`.

#### Port plan, updated

| Port | Name | Direction | Host side |
|---|---|---|---|
| 1024 | control | guest listens | `<run-dir>/control.sock` |
| 1025 | logs | guest listens | `<run-dir>/logs.sock` |
| **1026** | **egress** | **guest connects out** | **`<run-dir>/egress.sock`, served by the dialer; mapped only with `--egress-allow`** |
| 5000+i | RPC for app i (i < 64) | guest listens | `<run-dir>/rpc-<i>.sock` |

1026 is the first port in this plan where the guest connects out, which is why it is the first host-side listener: it follows rule 4 of "The rule for the host side" (only this sandbox's configured port, every request scoped against the host's own copy of the policy, bounded and capped).

## Components

Inside the path: the two gates and what each checks, how the guest starts and confines the broker, and the threat model that follows.

### Two gates, and why both

**Gate 1, the broker in the guest**, is today's `egress-broker.cjs`, unchanged in policy: declared `network:host:` / `browser:navigate:` patterns, the default ports (80, 443) unless a scope names one, refusing the hosts a dedicated broker owns (`api.github.com` when a `github:*` capability is declared), `CONNECT` for TLS, absolute-URI forwarding for plain `http://`. It is what the app talks to, so it is where the app-facing behaviour (403 and its message, the `navigate_allowed` / `navigate_denied` log lines) stays.

**Gate 2, the dialer on the host**, exists because the guest cannot be trusted with the decision. Guest root can open AF_VSOCK (`microvm-guest-init.md`, "The rule for the host side"), so anything that becomes root in the guest can connect to port 1026 and ask for anything. The dialer therefore:

1. **Takes its allowlist from the host** (`berth-vmm run --egress-allow 'example.com,api.example.org:8443'`), which the CLI computes from the sandbox's manifests, the same `network:host:` and `browser:navigate:` scopes the guest compiles. It never reads a policy, a manifest or a claim from the guest. No `--egress-allow`, no port 1026 mapping at all: a guest connect to 1026 is refused by libkrun.
2. **Matches the same way** as the broker: `*` is the only wildcard (a glob over the whole name, `?` literal), and a pattern with no port covers 80 and 443 only. Names are compared lowercased; a host must be a plain DNS name or an IP literal (`[A-Za-z0-9.-]`, at most 253 bytes, no empty labels).
3. **Resolves on its own** (the host's resolver, `getaddrinfo`), and **refuses the dial if any answer is internal**: loopback, RFC 1918, link-local and the metadata address 169.254.169.254, CGNAT 100.64/10, 0/8, benchmark, documentation, multicast and reserved ranges, broadcast; for IPv6 `::`, `::1`, ULA `fc00::/7` (so `fd00::/8` and AWS's `fd00:ec2::254`), link-local `fe80::/10`, site-local, multicast, documentation, discard, and any IPv4-mapped, IPv4-compatible or NAT64 (`64:ff9b::/96`) address whose embedded IPv4 is internal. Refusing when *any* answer is internal (rather than skipping to a public one) is deliberately stricter than the container broker: a public name that also answers with a private address is either misconfigured or a rebinding attempt, and either way not something to dial.
4. **Pins**: it connects to the addresses it checked, never to the name again, so DNS rebinding between check and dial has nothing to work with.
5. **Caps** concurrent connections (`--egress-max-conns`, default 64), bounds the request line (1 KiB) and the time to send it (5 s), and gives each connect 10 s.
6. **Logs every request**, allowed or not, as one JSON line on berth-vmm's stderr, the stream that already carries `endpoints` and `measurements`: `{"source":"berth-vmm","event":"egress","id","decision":"allowed|denied|failed","host","port","address","reason"}`, and `egress_closed` with byte counts and duration when an allowed tunnel ends.

Gate 2 does not know which guest process asked, so it cannot apply the per-app or dedicated-broker rules: those stay in the guest. What it guarantees is the outer bound: whatever happens inside the guest, its traffic reaches only the declared hosts, on the declared ports, at public addresses.

### In the guest

- **Who starts the broker.** berth-init, after the policies compile, when exactly one app declares a `network:host:` or `browser:navigate:` capability. Two such apps are refused (`egress_refused`, no broker, so no egress for anyone), which mirrors the CLI's `assertAtMostOneEgressBrokerApp` for containers: the broker port is a sandbox-wide resource and its pattern list is one app's.
- **Its confinement.** uid/gid 9002 (`berth-egress`, written into passwd/group at boot like the app users), in `/berth/daemons` with berth-init and context-bus-daemon, under agent-init with a daemon policy: write `/tmp/berth-egress` only (its HOME), TCP bind 8090 only, **no TCP connect at all** (`networkPorts: []`), seccomp as for apps (so no AF_VSOCK, no UDP, no io_uring). It reads the egress app's compiled policy (`/run/berth/egress/policy.json`, a root-owned copy).
- **How it gets out.** It cannot open vsock (seccomp), and node has no AF_VSOCK anyway, so berth-init serves `/run/berth/egress/dial.sock` (socket `root:9002 0660` in a `root:9002 0750` directory) and copies each connection to a new vsock connection to the host's port 1026. berth-init does not parse the stream; the host does. Apps cannot reach `dial.sock`: they are not in group 9002, and the directory is closed to them.
- **What apps get.** Every app gets `BERTH_EGRESS_PROXY_URL=http://127.0.0.1:8090` when the broker runs, as entrypoint.sh exports it to every app in a container. Only an app that declared `network:connect:8090` can actually connect (Landlock), the rule `docs/kernel-enforcement.md` already documents.
- **An app with no network capability** has no TCP connect at all (Landlock denies every port), no UDP or AF_VSOCK (seccomp), no route anywhere but loopback (no NIC), and no access to `dial.sock` (DAC). Nothing about it changes.
- **Broker mode.** `egress-broker.cjs` grows one switch, `BERTH_EGRESS_DIALER_SOCKET`. When it is set, a `CONNECT` or a plain-http forward that passes gate 1 is dialled through that socket instead of `dns.resolve4` + `net.connect`. The upstream proxy chaining (`BERTH_EGRESS_UPSTREAM_PROXY`) is not available in this mode: chaining would have to happen on the host, and the dialer has no such option yet. Without the variable the broker behaves exactly as before, so the container path is untouched.

### Threat model notes

- **Compromised app** (code execution as uid 10000+i under agent-init): reaches only 127.0.0.1:8090 and only if it declared `network:connect:8090`. Through the broker it gets the egress app's declared hosts, exactly as in a container. It cannot open vsock or `dial.sock`.
- **Compromised broker** (code execution as uid 9002): can talk to `dial.sock`, so it can ask the host for any `host:port`. The host refuses everything outside `--egress-allow` and every internal address. It cannot bypass agent-init (no TCP connect, no vsock).
- **Compromised guest root / kernel**: can open vsock 1026 directly (tested below with a test hook that does exactly that as PID 1). Same outcome as the broker case: gate 2 holds on the host. It can also open as many connections as the cap allows, and it can send what it likes inside an allowed tunnel; the dialer is a TCP pipe, not a content filter, the same property the container broker's CONNECT has.
- **DNS**: the guest cannot influence resolution except by the name it asks for. A declared name that resolves to an internal address (misconfigured, hijacked, or a rebinding record) is refused on the host, after resolution. Tested with `localhost` declared, and with a public wildcard-DNS name that answers 10.0.0.1.
- **Read scope.** The broker's Landlock policy restricts writes and network, not reads (`readPaths: []`, as for context-bus-daemon): node needs most of the image. Other apps' private directories are closed to uid 9002 by DAC (`/tmp/<app>` 0700, `/run/berth/<app>` 0711), and the broker is not in the shared `berth` group, so the apps' shared directories are closed to it too.
- **UDP.** An app that declares any network capability keeps datagram sockets (agent-init leaves them open "for DNS"). With no NIC there is nowhere for them to go but loopback, and nothing listens there for UDP.
- **The test hook.** `BERTH_VM_TEST_HOOKS=1` (a guest environment variable, so set by the host on the kernel command line) enables one control op, `egress_raw`, which makes PID 1 do what a compromised guest root could do anyway. Production boots never set it.
- **What is still open**: the dialer runs inside berth-vmm, which is not yet under a Seatbelt profile (`microvm-runtime.md` problem 9); when it is, the profile must allow outbound TCP for this process, and only that. There is no rate limit beyond the concurrency cap, and no bandwidth accounting yet beyond the per-tunnel byte counts in the log.

### Not in scope

- **github-api-broker** (TLS interception for `api.github.com`): not started in the VM. It needs a GitHub token, and the VM has no secrets channel yet (`microvm-runtime.md` problem 5); it also needs its CA in the app's trust store. Its upstream would use the same dial socket (it would run as another member of group 9002), and the host allowlist would carry `api.github.com:443`. One consequence to settle then: gate 2 cannot tell the github broker from the egress broker, so `api.github.com` being allowed on the host means a compromised guest root can reach it raw; the path-level policy is a guest-side guarantee only.
- **The mesh** (WireGuard over UDP, `network:peer:`): out of scope. vsock is a stream transport, so it needs either a datagram relay over a vsock stream or a virtio-net device behind a host userspace stack allowlisted to peer endpoints.
- **Upstream proxy chaining** in the VM, and IPv6-only remotes through the broker (the broker sends names; the dialer will dial IPv6 if that is all a name has, but nothing has tested it).

## Code

The dialer is [`packages/vmm/src/egress.rs`](../../packages/vmm/src/egress.rs). berth-init's side, the broker's start and the relay to vsock 1026, is in [`packages/vmm/init/src/egress.rs`](../../packages/vmm/init/src/egress.rs) and [`main.rs`](../../packages/vmm/init/src/main.rs). The broker is [`packages/docker-orchestrator/docker/egress-broker.cjs`](../../packages/docker-orchestrator/docker/egress-broker.cjs), and the CLI computes the allowlist in [`packages/cli/src/vm/support.ts`](../../packages/cli/src/vm/support.ts).

### How to run

```sh
cd packages/vmm
export BERTH_VMM_ARTIFACTS=/Users/ash/berth-wt/vm-egress-artifacts
./scripts/build-berth-init.sh && ./scripts/build-rootfs.sh && ./scripts/build-apps.sh
cargo test --release                      # the dialer's unit tests, on the host
node scripts/e2e.mjs egress               # 28 checks; needs outbound network
A=$BERTH_VMM_ARTIFACTS
./target/release/berth-vmm run --app $A/apps/http-fetch --run-dir $A/run/hf --egress-allow example.com &
node scripts/vm.mjs call $A/run/hf 0 fetch_text '{"url":"https://example.com/"}'
```

### Notes for the CLI's local-vm adapter

- Compute `--egress-allow` on the host from the sandbox's manifests: every `network:host:<scope>` and `browser:navigate:<scope>`, verbatim (the dialer parses scopes exactly as the broker does). Pass nothing when there are none; then no port is mapped.
- Read `endpoints.egress` (null without an allowlist) and the `egress` / `egress_closed` / `egress_dialer` lines on berth-vmm's stderr, which are host output (berth-vmm's own), not guest output. They are the egress audit log.
- The apps need nothing new: `BERTH_EGRESS_PROXY_URL` is set by berth-init, and `configureEgressProxy()` reads it as in a container. An app still has to declare `network:connect:8090`.

## Results

All on kernel `8f79e8da…`, rootfs **`5f80e448…`** (pinned), berth-init **`c82613e7…`**, through `berth-vmm run`. Real outbound network from the host for example.com. Load average 4 to 8 throughout (other work on the host).

| Goal | Result | Evidence |
|---|---|---|
| 1. Host dialer in berth-vmm, host-side allowlist, vsock mapping | **Pass** | `src/egress.rs`; `berth-vmm run --egress-allow LIST [--egress-max-conns N]` maps vsock 1026 (non-listen) to `<run-dir>/egress.sock` and reports it in `endpoints` (`"egress":{"port":1026,"socket":…,"allow":[…]}`). Low-level form: `--egress-allow LIST --egress-socket SOCK`; `berth-vmm egress-dialer` runs the dialer alone. 16 Rust unit tests on the host (`cargo test --release` in `packages/vmm`), 10 of them the dialer's: patterns, glob, default ports, the request grammar, IPv4 and IPv6 block lists, any-internal-answer refusal, localhost through the real resolver, the whole dialer over its socket, and the connection cap |
| 2. Guest side: broker started by berth-init, upstream over vsock, `BERTH_EGRESS_PROXY_URL` | **Pass** | `daemon_started` `egress-broker`: uid 9002, 127.0.0.1:8090, listening 26 to 32 ms after start, `ruleset=FullyEnforced`, in `/berth/daemons`. Rootfs rebuilt twice to the same hash (below) |
| 3a. `network:host:example.com` app fetches https://example.com from the VM | **Pass** | http-fetch's `fetch_text`: 713 bytes, "Example Domain". Host log: `{"event":"egress","decision":"allowed","host":"example.com","port":443,"address":"104.20.23.154"}`, then `egress_closed` with 1870 bytes up, 6293 down. Plain `http://example.com` through the broker's forward path as well |
| 3b. Undeclared host: refused by the guest broker, and by the host with the broker bypassed | **Pass** | `https://www.google.com` → `navigate_denied` in the broker, nothing reaches the host. As guest root on vsock 1026 directly: `DIAL www.google.com 443` → `ERR denied not in this sandbox's egress allowlist`; `DIAL example.com 22` (undeclared port) → denied; malformed frames (`GET http://… HTTP/1.1`, `DIAL 127.1 443`) → `bad_request`. The same raw path to a declared host works (`DIAL example.com 80` → `OK`, `HTTP/1.1 200 OK`): guest root gets exactly the host's allowlist, no more |
| 3c. Internal addresses refused by the host even when declared | **Pass** | Boot 2 declares (in the manifest and so in `--egress-allow`) `localhost:*`, `10.0.0.1.nip.io`, `169.254.169.254.nip.io`, `127.0.0.1:*`. Through the broker and raw from guest root, the host refused every one after its own resolution: `resolves to ::1 (loopback)`, `resolves to 10.0.0.1 (private (10/8))`, `resolves to 169.254.169.254 (link-local and cloud metadata)`, `resolves to 127.0.0.1 (loopback)`; the broker refused the 127.0.0.1 literal itself first. 6 requests, 0 dialled. The address rules are also unit-tested (ULA/`fd00:ec2::254`, mapped and NAT64 forms, CGNAT, …) |
| 3d. An app with no network capability has no egress | **Pass** | probe, in the same VM as a running broker: connect to 127.0.0.1:8090 `EACCES`, to `dial.sock` `EACCES` (directory 0750 root:9002), to 1.1.1.1:443 `EACCES`, `socket(AF_VSOCK)` `EPERM`, UDP `EPERM` |
| 3e. No allowlist, no way out | **Pass** | Boot 3: http-fetch without `--egress-allow`: no dialer, 1026 not mapped, the broker's dial fails (`host_dialer_refused`), the fetch fails |
| 3f. Port plan regression | **Pass** | `node scripts/e2e.mjs all` on the new rootfs: single 18/18, multi 15/15, enforce 12/12, stdio 3/3, exits 3/3 (51/51). In the egress boot itself: control `status`, logs, RPC on 5000 and 5001 next to 1026, all streams well-formed, clean shutdown with `unmountFailed: []` |
| 4. Docs | Done | This file; `microvm-runtime.md` status and port plan |

`node scripts/e2e.mjs egress`: **28/28**. Results in `$ART/run/e2e-egress.json`, including every host log line.

One defect found on the way and fixed (c0db4f7): the relay's listening socket and every connection accepted on it (Linux gives an accepted Unix socket the listener's path) kept `/run` busy at shutdown, so it was lazily detached. berth-init now closes the relay before unmounting.

### Pinned artifacts

| | sha256 | Inputs |
|---|---|---|
| rootfs | `5f80e448b6658cb14612dcc5534fcf495c6dd31a687822f9234859b1643c9579` (46,727,168 B) | as `57e7ef8b…` (same resolved packages: Alpine 3.24.2, nodejs 24.18.1-r0, e2fsprogs 1.47.4-r0; same agent-init, probe, sdk-node bundles), plus the broker; berth-init replaced. The tree listing differs from 57e7ef8b's by one line, `./usr/local/bin/berth-egress-broker.cjs`. Built twice, identical |
| `/sbin/berth-init` | `c82613e72a1bc0445a18cd2b63822a7aab0f482dbf7ceb574ef0fa0fddf1b572` | `packages/vmm/init` at this branch; 21 unit tests (2 new: the egress plan and identity); built twice, identical |
| `/usr/local/bin/berth-egress-broker.cjs` | `4ff162e8e2c86cc43a73caa02bd1a78e4fe620c2b18040334b79366402157d89` | `packages/docker-orchestrator/docker/egress-broker.cjs` at this branch |
| `/usr/local/bin/context-bus-daemon` | `1138c3595142a3235145b530d0cf1157b0971aa2230d417befe0a6e783477544` | unchanged, rebuilt to the same hash |

Artifacts are in `/Users/ash/berth-wt/vm-egress-artifacts/` (kernel, cache, builders, agent-init are APFS clones of `vm-runtime-artifacts`).
