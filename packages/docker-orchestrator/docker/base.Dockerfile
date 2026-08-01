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

FROM node:22-alpine AS base

RUN apk add --no-cache \
    bash curl ca-certificates tini \
    python3 py3-pip \
    chromium chromium-chromedriver \
    xvfb x11vnc websockify novnc \
    dbus ttf-freefont \
    # fuse3 provides fusermount3, which bazil.org/fuse's Mount() execs to
    # perform the actual mount(2) syscall — the daemon itself needs no other
    # userspace FUSE library (no libfuse-dev, no cgo binding to it).
    fuse3 \
    # PEP 668 blocks `pip install` on a system Python unless this marker is
    # removed. This is a container we fully control (unlike a developer's own
    # machine), so on_install hooks like the PRD's `pip install -r
    # requirements.txt` are expected to work without a virtualenv dance.
    && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED

ENV CHROME_BIN=/usr/bin/chromium-browser \
    DISPLAY=:99 \
    BERTH_APP_ROOT=/app \
    BERTH_CONTEXT_BUS_SOCKET=/tmp/berth-context-bus.sock \
    BERTH_CONTEXT_MOUNT=/context \
    BERTH_CONTEXT_DATA=/var/berth/context-data \
    BERTH_CONTEXT_INDEX_DB=/var/berth/context-index.db \
    BERTH_SEMANTIC_FS_SOCKET=/tmp/berth-semantic-fs.sock

WORKDIR /app

COPY --from=context-bus-builder /daemon/target/release/context-bus-daemon /usr/local/bin/context-bus-daemon
COPY --from=agent-init-builder /agent-init/target/release/agent-init /usr/local/bin/agent-init
COPY --from=semantic-fs-daemon-builder /semantic-fs-daemon/semantic-fs-daemon /usr/local/bin/semantic-fs-daemon

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY docker/rpc-relay.js /usr/local/bin/berth-rpc-relay.js
COPY docker/egress-broker.cjs /usr/local/bin/berth-egress-broker.js

EXPOSE 5900 6080 9222

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
COPY . /app
CMD ["node", "node_modules/@berth/sdk/dist/runtime.js"]
