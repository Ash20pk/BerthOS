# @berthos/adapter-k8s

Deploy a Berth sandbox to your own Kubernetes cluster, one Pod per instance, with `berth deploy --fleet=k8s`.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

Install it, with the Kubernetes client, next to [`@berthos/cli`](https://www.npmjs.com/package/@berthos/cli) (add `-g` if the CLI is global):

```sh
npm install @berthos/adapter-k8s @kubernetes/client-node
```

## Usage

From the app's directory:

```sh
berth deploy --fleet=k8s
berth deploy --fleet=k8s --count=3 --region=us-east-1
berth fleet status k8s
```

The adapter uses your default kubeconfig (`KUBECONFIG` or `~/.kube/config`) and deploys to `BERTH_K8S_NAMESPACE` (default `default`). `--region` becomes a `topology.kubernetes.io/region` node selector.

## Limits

- It doesn't push the image. Push it to a registry the cluster can pull from (or `kind load docker-image` for kind).
- The Pod needs `SYS_ADMIN`, which Pod Security Admission's `restricted` level rejects.
- Capabilities are enforced only if the node's kernel has Landlock (Linux 6.7+).
- `env` values from a `~/.berthrc` alias appear in the Pod spec, not in a Kubernetes `Secret`.

## Docs

[Kubernetes adapter reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/k8s-adapter-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
