# @berth/cli

The berth CLI — init, dev, test, publish, deploy.

Part of [Berth](https://github.com/Ash20pk/BerthOS) — capability-scoped, kernel-enforced sandboxes for AI agents. The `berth.yml` capability line is the boundary; Landlock + seccomp hold it.

```sh
npm install @berth/cli
```

## Usage

```sh
npm install -g @berth/cli
berth init my-app     # scaffold a resident app with a berth.yml manifest
berth doctor          # verify the host actually enforces (Landlock/seccomp probe)
berth dev             # boot the sandbox and run your app inside it
```

## Documentation

- [Getting started](https://github.com/Ash20pk/BerthOS/blob/main/docs/getting-started.md), [doctor reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/doctor-reference.md)
- Repo: https://github.com/Ash20pk/BerthOS
