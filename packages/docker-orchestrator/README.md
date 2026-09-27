# @berthos/docker-orchestrator

The Docker layer under the `berth` CLI: builds app images, starts and stops sandboxed containers, calls app exports, runs the `doctor` kernel probe, and takes snapshots.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install @berthos/docker-orchestrator
```

Most people use it through [`@berthos/cli`](https://www.npmjs.com/package/@berthos/cli). Use it directly if you're building your own tooling on the sandbox. The main entry points are `buildImage()`, `startContainer()` / `stopContainer()`, `invokeAppExport()`, `runDoctor()` and `createSnapshot()` / `restoreSnapshot()`.

Needs a running Docker daemon. Enforcement needs that daemon's kernel to have Landlock (Linux 6.7+; Docker Desktop doesn't). Anyone with root on the host, or access to `docker exec`, can bypass the sandbox.

## Docs

[Berth OS reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/berth-os-reference.md) · [Enforcement](https://github.com/Ash20pk/BerthOS/blob/main/docs/kernel-enforcement.md) · [Repo](https://github.com/Ash20pk/BerthOS)
