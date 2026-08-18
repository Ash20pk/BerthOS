#!/usr/bin/env bash
# Bring up a macOS Docker host whose kernel can actually enforce Berth's
# capabilities, then say plainly whether it does.
#
# This is the executable form of docs/mac-enforcement.md. It is deliberately
# idempotent and deliberately loud: every step prints what it decided, because
# the failure mode this exists to prevent is a host that *looks* sandboxed.
#
# It does not modify your shell. The final DOCKER_HOST line is printed for you
# to export, since a script cannot export into its parent.
set -euo pipefail

PROFILE="${COLIMA_PROFILE:-default}"
SOCK="$HOME/.colima/$PROFILE/docker.sock"
CPU="${BERTH_COLIMA_CPU:-4}"
MEM="${BERTH_COLIMA_MEMORY:-8}"
DISK="${BERTH_COLIMA_DISK:-60}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31merror: %s\033[0m\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "this script is for macOS; on Linux, run \`berth doctor\` directly."

say "Checking for Colima"
if ! command -v colima >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || die "Homebrew not found. Install Colima yourself, then re-run: https://github.com/abiosoft/colima"
  echo "not installed — installing colima and the docker CLI via Homebrew"
  brew install colima docker
else
  echo "found: $(colima version | head -1)"
fi

say "Starting the VM (profile: $PROFILE)"
if colima status --profile "$PROFILE" >/dev/null 2>&1; then
  echo "already running — leaving it alone (\`colima delete --profile $PROFILE\` to start over)"
else
  # --mount "$HOME:w" matters: Colima mounts $HOME read-only by default, and
  # Berth bind-mounts your checkout read-write. Without it, app writes fail with
  # EROFS, which is easy to misread as a capability denial.
  colima start --profile "$PROFILE" \
    --cpu "$CPU" --memory "$MEM" --disk "$DISK" \
    --vm-type vz --mount-type virtiofs \
    --mount "$HOME:w"
fi

[[ -S "$SOCK" ]] || die "expected a Docker socket at $SOCK but found none. Check \`colima status --profile $PROFILE\`."

say "Guest kernel"
# The authoritative answer, read from the guest rather than inferred: the string
# must contain `landlock`, or nothing below can be enforced no matter what the
# kernel version is.
LSM="$(colima ssh --profile "$PROFILE" -- cat /sys/kernel/security/lsm 2>/dev/null || echo "unreadable")"
echo "kernel:     $(colima ssh --profile "$PROFILE" -- uname -r 2>/dev/null || echo unknown)"
echo "LSM stack:  $LSM"
case "$LSM" in
  *landlock*) echo "landlock is active in this guest's LSM stack." ;;
  *) die "this guest kernel does not have landlock in its LSM stack. See docs/mac-enforcement.md." ;;
esac

# Berth reaches the daemon through dockerode, which reads DOCKER_HOST and does
# NOT read Docker CLI contexts — so `colima start`'s context switch is invisible
# to it. Setting this for the doctor run below is the whole point of the script.
export DOCKER_HOST="unix://$SOCK"

say "Ensuring there is an image to probe in"
# The probe needs python3. A Berth app image is preferred (it is what will
# actually boot), but before a first build there is none, so fall back.
if ! docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -q '^berth/'; then
  if ! docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -q '^python:'; then
    echo "no berth/* or python:* image in this daemon — pulling python:3.12-slim"
    docker pull python:3.12-slim
  fi
fi

say "berth doctor"
STATUS=0
node "$REPO_ROOT/packages/cli/bin/berth.js" doctor || STATUS=$?

say "Result"
if [[ $STATUS -eq 0 ]]; then
  cat <<MSG
This host can enforce Berth's capabilities. Export this in any shell where you
run Berth, or Berth will talk to Docker Desktop instead and enforcement will be
off without the CLI's context switch giving you any hint:

  export DOCKER_HOST="unix://$SOCK"

To see the kernel actually refuse an undeclared write:

  DOCKER_HOST="unix://$SOCK" node packages/docker-orchestrator/test/capability-enforcement.mjs
MSG
else
  cat <<MSG
\`berth doctor\` exited $STATUS — read its output above. It distinguishes "not
enforced" from "could not be checked", and those want different fixes. See
docs/mac-enforcement.md.
MSG
fi
exit $STATUS
