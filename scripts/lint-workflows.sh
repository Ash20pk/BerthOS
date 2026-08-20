#!/usr/bin/env bash
# Supply-chain lint (BUILD_PLAN M0.1 / REMEDIATION 6.6): every `uses:` in
# .github/workflows/ must be pinned to a full 40-hex commit SHA, and every
# FROM in base.Dockerfile that pulls from a registry must carry a digest.
# A tag or branch ref is a mutable pointer the upstream owner (or an
# attacker with their credentials) can move under us — see the SolarWinds /
# tj-actions incidents this rule exists because of.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# uses: local composite actions (./...) and docker:// digests are fine;
# anything else must be owner/repo@<40-hex-sha>.
while IFS= read -r line; do
  ref=$(echo "$line" | sed -E 's/.*uses:[[:space:]]*//; s/[[:space:]]*#.*//')
  case "$ref" in
    ./*) continue ;;
    docker://*@sha256:*) continue ;;
  esac
  if ! echo "$ref" | grep -qE '^[^@]+@[0-9a-f]{40}$'; then
    echo "UNPINNED ACTION: $line"
    fail=1
  fi
done < <(grep -rn --include='*.yml' --include='*.yaml' -E '^\s*-?\s*uses:' .github/workflows/)

# Registry-pulled base images must be digest-pinned. FROM referencing an
# earlier build stage (no registry pull) is exempt.
dockerfile=packages/docker-orchestrator/docker/base.Dockerfile
stages=$(grep -iE '^FROM' "$dockerfile" | sed -E 's/.*[Aa][Ss][[:space:]]+//' )
while IFS= read -r line; do
  image=$(echo "$line" | awk '{print $2}')
  if echo "$stages" | grep -qxF "$image"; then continue; fi
  if ! echo "$image" | grep -q '@sha256:'; then
    echo "UNPINNED BASE IMAGE: $line"
    fail=1
  fi
done < <(grep -inE '^FROM' "$dockerfile")

if [ "$fail" -ne 0 ]; then
  echo "lint-workflows: FAIL — mutable refs found (pin to a commit SHA / image digest)"
  exit 1
fi
echo "lint-workflows: OK — all actions SHA-pinned, all base images digest-pinned"
