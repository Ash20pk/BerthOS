# Berth Agent OS — Phase 1 stand-in, now with Phase 2's Context Bus daemon,
# Phase 3's kernel-enforced capability policy (Landlock), and Phase 4's
# semantic filesystem (FUSE, mounted at /context).
#
# node:22-alpine IS Alpine (musl) — used directly rather than alpine:3.20 +
# manual Node install, since the SDK runtime needs Node regardless and the
# official image is already minimal. Every sandbox competitor (E2B, Daytona,
# Modal, Vercel Sandbox) ships a stock kernel/image the same way; the base
# image itself stays stock — agent-init is what actually differs here.

# Compiles the Context Bus daemon (packages/context-bus-daemon) natively
# against musl inside Alpine, so the final image never needs a Rust
# toolchain — just the resulting static binary. Isolated in its own stage so
# Docker's layer cache only recompiles it when the daemon's own source
# changes, not on every app's dev/test/deploy build.
FROM rust:1-alpine AS context-bus-builder
RUN apk add --no-cache build-base protobuf protobuf-dev
WORKDIR /daemon
COPY context-bus-daemon/ .
RUN cargo build --release

# Compiles agent-init (packages/agent-init) the same way — a small Rust
# binary that applies a Landlock ruleset (kernel-enforced, unprivileged —
# see docs/capability-tokens-reference.md) before exec-ing into whatever
# command entrypoint.sh hands it. Landlock is Linux-only, so this can only
# be built here, not on a macOS/Windows host — see that doc for why.
FROM rust:1-alpine AS agent-init-builder
RUN apk add --no-cache build-base
WORKDIR /agent-init
COPY agent-init/ .
RUN cargo build --release

# Compiles semantic-fs-daemon (packages/semantic-fs-daemon) — a pure-Go (no
# cgo — bazil.org/fuse talks to /dev/fuse directly on Linux, and
# modernc.org/sqlite is a pure-Go SQLite) static binary, so CGO_ENABLED=0
# keeps it independent of Alpine's musl libc version the same way the Rust
# binaries above are. Its own stage means Docker's layer cache only rebuilds
# it when semantic-fs-daemon's own source changes.
FROM golang:1-alpine AS semantic-fs-daemon-builder
WORKDIR /semantic-fs-daemon
COPY semantic-fs-daemon/ .
RUN CGO_ENABLED=0 go build -o semantic-fs-daemon .

# Compiles mesh-daemon (packages/mesh-daemon) — the WireGuard mesh agent, same
# shape as the other Rust stages above. See docs/mesh-reference.md.
FROM rust:1-alpine AS mesh-daemon-builder
RUN apk add --no-cache build-base
WORKDIR /mesh-daemon
COPY mesh-daemon/ .
RUN cargo build --release

# Cloudflare's real, published userspace WireGuard implementation — this is
# wg-quick's own documented WG_QUICK_USERSPACE_IMPLEMENTATION fallback
# mechanism (not a Berth invention), used only when mesh-daemon's kernel
# WireGuard probe fails (e.g. a guest kernel with no `wireguard` module
# loaded). Its own stage so it only rebuilds on a version bump, never on any
# other package's changes.
FROM rust:1-alpine AS boringtun-builder
RUN apk add --no-cache build-base
RUN cargo install boringtun-cli --version 0.7.1 --root /out

FROM node:22-alpine AS base

RUN apk add --no-cache \
    bash curl ca-certificates tini \
    python3 py3-pip \
    chromium chromium-chromedriver \
    xvfb x11vnc websockify novnc \
    dbus ttf-freefont \
    # terminal:* capability support — real system binaries, not an npm native
    # binding, since `berth dev` bind-mounts host-built node_modules straight
    # into this (Alpine/musl) container: a node-gyp-compiled addon built on a
    # developer's own macOS/glibc-Linux host wouldn't load here at all. tmux
    # owns the actual pty and is the single source of truth for its content;
    # ttyd is just a web client attaching to that same tmux session (see
    # apps/terminal/src/tmux-controller.ts) — same "spawned as a child of the
    # app's own already-Landlocked process" design browser-native uses for
    # Chromium, so terminal:* composes with filesystem/network capabilities
    # the same way, rather than needing its own kernel-enforcement path.
    tmux ttyd \
    # fuse3 provides fusermount3, which bazil.org/fuse's Mount() execs to
    # perform the actual mount(2) syscall — the daemon itself needs no other
    # userspace FUSE library (no libfuse-dev, no cgo binding to it).
    fuse3 \
    # the openssl CLI, used by github-api-broker.cjs to generate its own
    # MITM CA + a per-boot leaf cert for api.github.com at container start —
    # Node core has no self-signing certificate API of its own.
    openssl \
    # network:peer:* capability support (see docs/mesh-reference.md):
    # wireguard-tools provides `wg`/`wg-quick` (real reference WireGuard
    # tooling, not a bespoke binding — mesh-daemon shells out to these rather
    # than talking netlink directly, the same "exec a real system binary"
    # pattern fusermount3/openssl above already use); iproute2 provides `ip`,
    # used both by mesh-daemon's kernel-WireGuard-support probe and by
    # wg-quick itself.
    wireguard-tools iproute2 \
    # PEP 668 blocks `pip install` on a system Python unless this marker is
    # removed. This is a container we fully control (unlike a developer's own
    # machine), so on_install hooks like the PRD's `pip install -r
    # requirements.txt` are expected to work without a virtualenv dance.
    && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
    # @berth/sdk-python's own runtime deps — baked into every image (not a
    # per-app on_install step) since run_lifecycle.py itself needs to import
    # berth_sdk (and thus pydantic/pyyaml) before any app-specific on_install
    # has had a chance to run; the same reason @berth/sdk's node_modules is
    # already resolvable before a TS app's own on_install runs.
    && pip install --no-cache-dir pydantic pyyaml protobuf

ENV CHROME_BIN=/usr/bin/chromium-browser \
    DISPLAY=:99 \
    BERTH_APP_ROOT=/app \
    BERTH_CONTEXT_BUS_SOCKET=/tmp/berth-context-bus.sock \
    BERTH_CONTEXT_MOUNT=/context \
    BERTH_CONTEXT_DATA=/var/berth/context-data \
    BERTH_CONTEXT_INDEX_DB=/var/berth/context-index.db \
    BERTH_SEMANTIC_FS_SOCKET=/tmp/berth-semantic-fs.sock \
    # Chrome 128+ made crashpad's --database flag mandatory for its crash
    # handler, which derives that path from XDG_CONFIG_HOME/XDG_CACHE_HOME —
    # unset in a plain container, this makes the handler invocation itself
    # fail ("chrome_crashpad_handler: --database is required"), which then
    # takes the whole browser down with SIGTRAP on startup. Docker Desktop's
    # linuxkit VM tolerates the unset case somehow; a more locked-down runner
    # (e.g. GitHub Actions' ubuntu-latest) does not — pointing both at a
    # writable dir up front is the documented fix (see e.g.
    # chrome-php/chrome#649, puppeteer#11023).
    XDG_CONFIG_HOME=/tmp/.chromium \
    XDG_CACHE_HOME=/tmp/.chromium

WORKDIR /app

COPY --from=context-bus-builder /daemon/target/release/context-bus-daemon /usr/local/bin/context-bus-daemon
COPY --from=agent-init-builder /agent-init/target/release/agent-init /usr/local/bin/agent-init
COPY --from=semantic-fs-daemon-builder /semantic-fs-daemon/semantic-fs-daemon /usr/local/bin/semantic-fs-daemon
COPY --from=mesh-daemon-builder /mesh-daemon/target/release/mesh-daemon /usr/local/bin/mesh-daemon
COPY --from=boringtun-builder /out/bin/boringtun-cli /usr/local/bin/boringtun-cli

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY docker/rpc-relay.js /usr/local/bin/berth-rpc-relay.js
COPY docker/egress-broker.cjs /usr/local/bin/berth-egress-broker.js
COPY docker/github-api-broker.cjs /usr/local/bin/berth-github-api-broker.js

EXPOSE 5900 6080 9222 7681

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]

# --- dev target: bind-mounted source, devDependencies kept for fast iteration ---
FROM base AS dev
ENV NODE_ENV=development
CMD ["node", "node_modules/@berth/sdk/dist/runtime.js"]

# --- production target: source + a real (non-symlinked) node_modules ---
# already materialized host-side into the build context by
# @berth/docker-orchestrator's stageProductionSource() — via `pnpm deploy
# --legacy` for workspace members, or a plain prod install for standalone
# apps — so no install step runs here at all.
FROM base AS production
ENV NODE_ENV=production
# Every production image refuses to exec its resident app unrestricted —
# agent-init (see packages/agent-init/src/main.rs) exits non-zero instead of
# falling back to "warn and run anyway" if Landlock didn't fully enforce the
# capability policy. Dev images leave this unset: Docker Desktop's linuxkit
# VM (Mac) never enforces Landlock at all, and failing dev boots over that
# would make local iteration impossible.
ENV BERTH_REQUIRE_ENFORCEMENT=1
COPY . /app
CMD ["node", "node_modules/@berth/sdk/dist/runtime.js"]
