# Kubernetes adapter reference

`@berthos/adapter-k8s` deploys a Berth sandbox to a Kubernetes cluster as a Pod. Use it when you want to run resident apps on your own cluster rather than on E2B or Daytona.

## Context

You run `berth deploy --fleet=k8s` from an app's directory, and the app ends up running on a Kubernetes cluster you already operate. Two other systems are involved: the cluster's API server, and an image registry the cluster pulls from, which you push to yourself.

## Containers

The adapter isn't a separate process. It's a package loaded by the `berth` CLI, which talks to the cluster's API server through `@kubernetes/client-node` and your kubeconfig. On the cluster it creates one single-container Pod per instance, plus a `ClusterIP` or `NodePort` Service for an instance when a preview or RPC URL is asked for.

## Components

Inside the adapter: one method per `DeployAdapter` operation, and the mapping from the manifest and flags to Pod settings.

### How it maps to `DeployAdapter`

The adapter implements the same `DeployAdapter` interface as the E2B and Daytona adapters.

| Method | What it does on Kubernetes |
|---|---|
| `upload()` | Nothing. Returns the image reference unchanged; the cluster must already be able to pull it. |
| `start()` | Creates one Pod per instance, named `<app>-<random>`, with `restartPolicy: Never`. Labels: `app.kubernetes.io/managed-by: berth`, `berth.dev/app-name: <name>`, `berth.dev/instance: <id>`. |
| `status()` | Maps the Pod phase: `Pending` → `starting`, `Running` → `running`, `Succeeded` → `stopped`, `Failed` → `error`. |
| `streamLogs()` | Follows the container's logs. |
| `list()` | Every Pod labeled `app.kubernetes.io/managed-by=berth` in the namespace, across all apps. |
| `previewUrl(handle, port)` | Creates a `ClusterIP` Service for that one instance and returns `<service>.<namespace>.svc.cluster.local:<port>`. Reachable from inside the cluster only. Used when `berth.yml` sets [`expose.preview: true`](./manifest-reference.md#expose-default-browser-true-terminal-true-preview-false). |
| `rpcUrl(handle, port)` | Creates a `NodePort` Service for that instance and returns `http://<node-ip>:<node-port>`, using a node's `ExternalIP`, or its `InternalIP` if none has one (as on kind). Used to reach an agent from outside the cluster ([networked crews](./agents-reference.md#networked-crew-over-a-remote-fleet-e2b-daytona-k8s)). |
| `teardown()` / `stop()` | Deletes the Pod, and on teardown also the Services created for it. |

Pod settings that come from the manifest and flags:

- **`resources:`** in `berth.yml` sets both `requests` and `limits` to the same values (Guaranteed QoS): `cpu` → `cpu`, `memory_mb` → `memory` in `Mi`, `gpu` → `nvidia.com/gpu`. No `resources:` means no resource fields on the Pod. See the [manifest reference](./manifest-reference.md#resources-default-).
- **`--region`** becomes `nodeSelector: {"topology.kubernetes.io/region": <value>}`. If no node carries that label, the Pod stays unschedulable.
- **`env`** from a fleet alias becomes plain container environment variables in the Pod spec.
- **`/context`** needs FUSE, so every Pod mounts `/dev/fuse` from the host and adds the `SYS_ADMIN` capability.

## Code

The adapter's source is [`packages/adapters/adapter-k8s`](../packages/adapters/adapter-k8s).

### Use it

Install the adapter and the Kubernetes client where the CLI is installed (add `-g` if the CLI is global):

```bash
npm install @berthos/adapter-k8s @kubernetes/client-node
```

Make sure the cluster can pull the image, then deploy from the app's directory:

```bash
berth deploy --fleet=k8s
berth deploy --fleet=k8s --count=3 --region=us-east-1
```

`berth deploy` builds the production image and starts it, but the adapter doesn't push it anywhere. Push it to a registry the cluster can pull from, or for a local [kind](https://kind.sigs.k8s.io) cluster, `kind load docker-image <image>`.

The adapter uses your default kubeconfig (`KUBECONFIG` or `~/.kube/config`) and deploys to the namespace in `BERTH_K8S_NAMESPACE` (default `default`).

To keep settings under a name, add an alias to `~/.berthrc` and deploy with `--fleet=prod`:

```json
{
  "prod": {
    "adapter": "k8s",
    "count": 2,
    "region": "us-east-1",
    "env": { "ANTHROPIC_API_KEY": "..." }
  }
}
```

`--count` and `--region` on the command line override the alias. If the alias carries `env`, keep the file private (`chmod 600 ~/.berthrc`); `berth` warns when it isn't. `berth fleet status k8s` lists the live Pods. `berth fleet scale` can add instances but can't remove them, because the adapter can't reconnect to an existing Pod by id; delete surplus Pods with `kubectl`.

## Limits

- **Pod Security Admission.** The `SYS_ADMIN` capability is rejected under the `restricted` level. Berth's namespace needs a policy that allows it.
- **Kernel enforcement depends on the node.** The node's kernel needs Landlock (Linux 6.7+) for any capability to be enforced; see [enforcement](./kernel-enforcement.md).
- **Credentials are visible in the Pod spec.** Alias `env` values are not stored as Kubernetes `Secret` objects, so `kubectl get pod -o yaml` shows them. See [secrets](./secrets-reference.md#what-this-does-not-protect-against).
- **`rpcUrl()` needs reachable node IPs.** A cluster that firewalls its nodes from outside has no usable RPC URL.

## What's deliberately out of scope

- Pushing images to a registry, or registry authentication (ECR, GCR, Docker Hub).
- Anything beyond one single-container Pod per instance: no Deployments or StatefulSets, no readiness or liveness probes, no autoscaling.
- GPUs other than NVIDIA's `nvidia.com/gpu` resource.
- Public URLs. The adapter creates no Ingress or `LoadBalancer` Service.
- Creating namespaces, RBAC or Pod Security policy. The namespace and permissions must already exist.
- Pause, resume, fork and snapshot. The adapter doesn't implement these optional `DeployAdapter` methods (see [computer snapshots](./computer-snapshots-reference.md#remote-fleets-e2bdaytona-via---fleet)).
