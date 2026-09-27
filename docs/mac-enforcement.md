# Enforcement on macOS

On a Mac, Berth's apps run on the kernel of the Linux VM your Docker daemon lives in, not on macOS. Docker Desktop's VM has no Landlock, so nothing is enforced. Colima's default VM has it. This page sets up Colima so the kernel refuses an undeclared write.

| Docker runtime | Kernel | `berth doctor` |
|---|---|---|
| Docker Desktop | `linuxkit`, no Landlock (`landlock_create_ruleset` returns `ENOSYS`) | `enforcement: NOT ACTIVE` |
| Colima (default VM) | Ubuntu 24.04, Landlock ABI 4 | `enforcement: ACTIVE` |

No custom kernel is needed.

## Quick setup

```bash
berth doctor --fix                    # install and start Colima, then re-check against it
./scripts/mac-enforcement.sh          # the same steps as a standalone script
```

`--fix` installs Colima with Homebrew if it's missing, starts the VM with the flags in step 2 below, and re-runs doctor against the Colima socket. It reports success only if the re-check sees enforcement. It can't change your shell, so it prints the `docker context use` and `DOCKER_HOST` lines for you to run.

Both read these env vars:

| Variable | Default |
|---|---|
| `COLIMA_PROFILE` | `default` |
| `BERTH_COLIMA_CPU` | `4` |
| `BERTH_COLIMA_MEMORY` | `8` (GB) |
| `BERTH_COLIMA_DISK` | `60` (GB) |

## Step by step

### 1. Install Colima

```bash
brew install colima docker
```

`docker` here is just the CLI; Colima provides the daemon. You can keep Docker Desktop installed: Colima registers its own daemon and Docker context, and step 5 switches back.

### 2. Start the VM

```bash
colima start \
  --cpu 4 --memory 8 --disk 60 \
  --vm-type vz --mount-type virtiofs \
  --mount "$HOME:w"
```

- **`--cpu 4 --memory 8 --disk 60`**: Colima's default of 2 CPUs and 2 GB makes the first image build slow enough to look hung. The disk holds the layer cache for several app images.
- **`--vm-type vz`**: Apple's Virtualization framework instead of QEMU, so the VM runs at native speed on Apple silicon.
- **`--mount-type virtiofs`**: required by `vz`, and faster than sshfs for the bind mount `berth dev` uses.
- **`--mount "$HOME:w"`**: Colima mounts your home directory read-only by default. Without `:w`, writes fail with `EROFS`, which is easy to mistake for an enforcement denial.

### 3. Point Berth at Colima

```bash
docker context use colima
```

`colima start` usually does this for you. Berth picks the daemon the way the `docker` CLI does: `DOCKER_HOST`, then `DOCKER_CONTEXT`, then the current context in `~/.docker/config.json`. To pin it for one shell instead, export `DOCKER_HOST`, which wins over any context:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
```

### 4. Check

```bash
berth doctor
```

On a working setup every check passes and the command exits 0:

```
Kernel that runs Berth's apps: 6.8.0-117-generic (Ubuntu 24.04.4 LTS)
Probed in: python:3.12-slim

  ✔ Docker daemon reachable
      Ubuntu 24.04.4 LTS (29.5.2), kernel 6.8.0-117-generic on aarch64
  ✔ Docker's default seccomp profile
      profile=builtin
  ✔ Landlock enforcement in the container kernel
      a ruleset granting nothing denied a write (ABI 4) — write refused with Permission denied
  ✔ /dev/fuse available to a sandbox
      present when requested as a device

enforcement: ACTIVE
```

If the kernel line says `linuxkit`, Berth is still talking to Docker Desktop. The daemon line says which setting chose the socket (for example `via unix:///Users/you/.colima/default/docker.sock (current Docker context "colima")`); go back to step 3.

Doctor runs its probe in a local image that has `python3` (any Berth app image works). If you haven't built one yet it pulls `python:3.13-alpine`; `--image` picks a different one. The `--json` output and every verdict are in the [doctor reference](./doctor-reference.md).

To test the full boundary against a real app, not just the kernel:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"   # this script doesn't follow Docker contexts
node packages/docker-orchestrator/test/capability-enforcement.mjs
```

It should exit 0, and the log should include `ruleset=FullyEnforced`. That line means every denial check ran for real.

### 5. Going back to Docker Desktop

```bash
unset DOCKER_HOST           # only if you exported it in step 3
docker context use desktop-linux
colima stop                 # or `colima delete` to reclaim the disk
```

Nothing Berth writes is Colima-specific, so you can switch back and forth. On Docker Desktop you're back to `enforcement: NOT ACTIVE`.

## Other VMs

Colima is a wrapper over [Lima](https://lima-vm.io). Plain Lima with `template://docker`, or any Linux VM whose distro keeps `landlock` in its active LSM list (Ubuntu 22.04+, Fedora, recent Debian), should work the same way; only Colima is tested. To check another VM, run `cat /sys/kernel/security/lsm` inside it (the output must contain `landlock`), then `berth doctor`.

## Limits

- Your home directory is mounted writable into the VM (step 2). The boundary between the VM and macOS is Docker's, not Berth's.
