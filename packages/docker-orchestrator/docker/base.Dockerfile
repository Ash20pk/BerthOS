# Berth Agent OS — Phase 1 stand-in.
#
# node:22-alpine IS Alpine (musl) — used directly rather than alpine:3.20 +
# manual Node install, since the SDK runtime needs Node regardless and the
# official image is already minimal. Every sandbox competitor (E2B, Daytona,
# Modal, Vercel Sandbox) ships a stock kernel/image the same way; the one
# thing that will eventually differ here is Phase 3's custom PID 1 and
# eBPF/seccomp capability enforcement — not the base image itself.
FROM node:22-alpine AS base

RUN apk add --no-cache \
    bash curl ca-certificates tini \
    python3 py3-pip \
    chromium chromium-chromedriver \
    xvfb x11vnc websockify novnc \
    dbus ttf-freefont \
    # PEP 668 blocks `pip install` on a system Python unless this marker is
    # removed. This is a container we fully control (unlike a developer's own
    # machine), so on_install hooks like the PRD's `pip install -r
    # requirements.txt` are expected to work without a virtualenv dance.
    && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED

ENV CHROME_BIN=/usr/bin/chromium-browser \
    DISPLAY=:99 \
    BERTH_APP_ROOT=/app

WORKDIR /app

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

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
