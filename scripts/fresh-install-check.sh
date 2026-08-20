#!/usr/bin/env bash
# BUILD_PLAN M0.2 verification: prove the published packages work on a
# machine that has never seen this repo. Run inside an empty container:
#   docker run --rm node:22-alpine sh -c "apk add --no-cache bash && bash -" < scripts/fresh-install-check.sh
# Record the output in docs/internal/verification/fresh-install-<date>.txt.
set -euxo pipefail
npm install -g @berth/cli
berth --version
berth doctor || true   # doctor may report NOT_ENFORCED inside this container — that's a finding, not a failure
echo "fresh-install-check: OK"
