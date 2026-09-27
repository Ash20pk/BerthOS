# @berthos/cli

The `berth` command: scaffold, run, test and deploy resident apps, check whether your machine can enforce, and connect apps to any MCP client.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel (Landlock and seccomp) enforces it.

```sh
npm install -g @berthos/cli
```

Needs Node.js 22+ and Docker.

## Usage

```sh
berth doctor --fix        # can this machine's kernel enforce? (--fix sets up Colima on a Mac)
berth init my-app         # scaffold a resident app
cd my-app
berth dev                 # boot it in a sandbox, reload on save
berth test                # build the production image and check every export
berth mcp --app my-app    # serve its exports as MCP tools over stdio
```

## Commands

| Command | What it does |
|---|---|
| `berth init [name]` | Scaffold a resident app (`--template`, `--registry`) |
| `berth dev` | Boot the app in a local sandbox with hot reload (`--apps` adds companion apps) |
| `berth test` | Build the production image, check export contracts, run the app's tests (`--json`) |
| `berth doctor` | Check whether this machine can enforce capabilities |
| `berth mcp --app <name>` | Expose an app's exports as MCP tools (`--only`, `--warm`, `--no-boot`) |
| `berth rpc <app> --export <name>` | Call one export directly (`--input` takes JSON) |
| `berth os up\|down\|status` | Keep a sandbox running so code can reconnect to it instantly |
| `berth attest <runId>` | Produce an attestation record for a run |
| `berth audit list\|verify` | Show the audit trail, or check its hash chain |
| `berth snapshot create\|list\|restore\|fork` | Checkpoint and restore a sandbox |
| `berth deploy --fleet=<e2b\|daytona\|k8s>` | Deploy to a remote provider |
| `berth fleet status\|scale`, `berth logs` | Manage and follow deployed instances |
| `berth publish --registry=<url>` | Publish an app to a `berth-registry` |
| `berth tls init` | Mint a local CA and server certificate |

Run `berth <command> --help` for every flag. Deploying needs the matching adapter installed next to the CLI: `@berthos/adapter-e2b`, `@berthos/adapter-daytona` or `@berthos/adapter-k8s`.

`berth agent run`, `berth crew run` and `berth eval` drive the experimental agent framework, which isn't published. They work from a clone of the repo only.

## Docs

[Quickstart](https://github.com/Ash20pk/BerthOS/blob/main/docs/quickstart.md) · [MCP quickstart](https://github.com/Ash20pk/BerthOS/blob/main/docs/mcp-quickstart.md) · [Doctor](https://github.com/Ash20pk/BerthOS/blob/main/docs/doctor-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
