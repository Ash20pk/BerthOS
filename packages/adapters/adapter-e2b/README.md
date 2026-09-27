# @berthos/adapter-e2b

Deploy a Berth sandbox to [E2B](https://e2b.dev) with `berth deploy --fleet=e2b`.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

Install it, with the E2B SDK, next to [`@berthos/cli`](https://www.npmjs.com/package/@berthos/cli) (add `-g` if the CLI is global):

```sh
npm install @berthos/adapter-e2b e2b
```

## Usage

From the app's directory:

```sh
berth deploy --fleet=e2b
berth deploy --fleet=e2b --count=3
berth fleet status e2b
```

The adapter authenticates through the E2B SDK's own configuration. `--region` has no effect on E2B. `berth snapshot create --fleet` pauses and resumes an E2B instance.

## Docs

[Quickstart: testing and deploying](https://github.com/Ash20pk/BerthOS/blob/main/docs/quickstart.md) · [Repo](https://github.com/Ash20pk/BerthOS)
