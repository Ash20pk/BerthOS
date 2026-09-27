# @berthos/adapter-daytona

Deploy a Berth sandbox to [Daytona](https://www.daytona.io) with `berth deploy --fleet=daytona`.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

Install it, with the Daytona SDK, next to [`@berthos/cli`](https://www.npmjs.com/package/@berthos/cli) (add `-g` if the CLI is global):

```sh
npm install @berthos/adapter-daytona @daytonaio/sdk
```

## Usage

From the app's directory:

```sh
berth deploy --fleet=daytona
berth deploy --fleet=daytona --region=<region-id>
berth fleet status daytona
```

The adapter authenticates through the Daytona SDK's own configuration. `--region` sets the region of the snapshot an instance boots from. `berth snapshot create --fleet` snapshots a Daytona instance, and `berth snapshot fork` clones a running one.

## Docs

[Quickstart: testing and deploying](https://github.com/Ash20pk/BerthOS/blob/main/docs/quickstart.md) · [Repo](https://github.com/Ash20pk/BerthOS)
