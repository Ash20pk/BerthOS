import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berth/manifest-schema";

const manifest = { name: "x" } as unknown as BerthManifest;

/** Minimal fake @kubernetes/client-node module — enough surface for start()/rpcUrl() to run against. */
function mockK8sModule(coreApi: Record<string, unknown>) {
  class FakeKubeConfig {
    loadFromDefault() {}
    makeApiClient() {
      return coreApi;
    }
  }
  return {
    namedExports: {
      KubeConfig: FakeKubeConfig,
      CoreV1Api: class {},
      Log: class {},
    },
  };
}

async function startedHandle(t: any, coreApi: Record<string, unknown>) {
  t.mock.module("@kubernetes/client-node", mockK8sModule(coreApi));
  const { createK8sAdapter } = await import("./index.js");
  const adapter = createK8sAdapter();
  return { adapter, handle: await adapter.start("berth/x:1.0.0", { imageRef: "berth/x:1.0.0", manifest }) };
}

test("rpcUrl() creates a NodePort Service and prefers a node's ExternalIP", async (t) => {
  const coreApi = {
    createNamespacedPod: async () => ({ metadata: { name: "x-abc12" } }),
    createNamespacedService: async () => ({ spec: { ports: [{ nodePort: 31234 }] } }),
    listNode: async () => ({
      items: [
        {
          status: {
            addresses: [
              { type: "InternalIP", address: "10.0.0.5" },
              { type: "ExternalIP", address: "203.0.113.9" },
            ],
          },
        },
      ],
    }),
  };
  const { adapter, handle } = await startedHandle(t, coreApi);

  const url = await adapter.rpcUrl!(handle, 7300);
  assert.equal(url, "http://203.0.113.9:31234");
});

test("rpcUrl() falls back to InternalIP when no node has an ExternalIP (e.g. a kind cluster)", async (t) => {
  const coreApi = {
    createNamespacedPod: async () => ({ metadata: { name: "x-abc12" } }),
    createNamespacedService: async () => ({ spec: { ports: [{ nodePort: 31234 }] } }),
    listNode: async () => ({ items: [{ status: { addresses: [{ type: "InternalIP", address: "172.18.0.2" }] } }] }),
  };
  const { adapter, handle } = await startedHandle(t, coreApi);

  const url = await adapter.rpcUrl!(handle, 7300);
  assert.equal(url, "http://172.18.0.2:31234");
});

test("rpcUrl() re-reads the existing Service's nodePort when creation says AlreadyExists", async (t) => {
  const coreApi = {
    createNamespacedPod: async () => ({ metadata: { name: "x-abc12" } }),
    createNamespacedService: async () => {
      throw { code: 409, body: { reason: "AlreadyExists" } };
    },
    readNamespacedService: async () => ({ spec: { ports: [{ nodePort: 30500 }] } }),
    listNode: async () => ({ items: [{ status: { addresses: [{ type: "ExternalIP", address: "203.0.113.9" }] } }] }),
  };
  const { adapter, handle } = await startedHandle(t, coreApi);

  const url = await adapter.rpcUrl!(handle, 7300);
  assert.equal(url, "http://203.0.113.9:30500");
});

test("rpcUrl() returns null when no node has any reachable address", async (t) => {
  const coreApi = {
    createNamespacedPod: async () => ({ metadata: { name: "x-abc12" } }),
    createNamespacedService: async () => ({ spec: { ports: [{ nodePort: 31234 }] } }),
    listNode: async () => ({ items: [{ status: { addresses: [] } }] }),
  };
  const { adapter, handle } = await startedHandle(t, coreApi);

  const url = await adapter.rpcUrl!(handle, 7300);
  assert.equal(url, null);
});

test("teardown() deletes the Pod and every Service created for this instance's rpcUrl()/previewUrl()", async (t) => {
  const deletedServiceCalls: unknown[] = [];
  let deletedPod: unknown;
  const coreApi = {
    createNamespacedPod: async () => ({ metadata: { name: "x-abc12" } }),
    createNamespacedService: async () => ({ spec: { ports: [{ nodePort: 31234 }] } }),
    listNode: async () => ({ items: [{ status: { addresses: [{ type: "ExternalIP", address: "203.0.113.9" }] } }] }),
    deleteNamespacedPod: async (args: unknown) => {
      deletedPod = args;
    },
    deleteCollectionNamespacedService: async (args: unknown) => {
      deletedServiceCalls.push(args);
    },
  };
  const { adapter, handle } = await startedHandle(t, coreApi);

  // Simulate the app having opted into a preview/rpc URL before teardown.
  await adapter.rpcUrl!(handle, 7300);

  await adapter.teardown(handle);

  assert.deepEqual(deletedPod, { name: "x-abc12", namespace: "default" });
  assert.equal(deletedServiceCalls.length, 1);
  assert.equal((deletedServiceCalls[0] as any).namespace, "default");
  assert.match((deletedServiceCalls[0] as any).labelSelector, /^berth\.dev\/instance=/);
});

test("teardown() doesn't blow up if Service cleanup fails — the Pod still gets deleted", async (t) => {
  let deletedPod: unknown;
  const coreApi = {
    createNamespacedPod: async () => ({ metadata: { name: "x-abc12" } }),
    deleteNamespacedPod: async (args: unknown) => {
      deletedPod = args;
    },
    deleteCollectionNamespacedService: async () => {
      throw new Error("RBAC denied");
    },
  };
  const { adapter, handle } = await startedHandle(t, coreApi);

  await adapter.teardown(handle);

  assert.deepEqual(deletedPod, { name: "x-abc12", namespace: "default" });
});

test("start() sends no resources field on the Pod spec when the manifest declares none", async (t) => {
  let podBody: any;
  const coreApi = {
    createNamespacedPod: async (args: any) => {
      podBody = args.body;
      return { metadata: { name: "x-abc12" } };
    },
  };
  await startedHandle(t, coreApi);
  assert.equal(podBody.spec.containers[0].resources, undefined);
});

test("start() sets requests == limits on the Pod spec when the manifest declares cpu/memory_mb/gpu", async (t) => {
  let podBody: any;
  const coreApi = {
    createNamespacedPod: async (args: any) => {
      podBody = args.body;
      return { metadata: { name: "x-abc12" } };
    },
  };
  const resourcedManifest = { name: "x", resources: { cpu: 0.5, memory_mb: 512, gpu: 1 } } as unknown as BerthManifest;
  const { createK8sAdapter } = await (async () => {
    t.mock.module("@kubernetes/client-node", mockK8sModule(coreApi));
    return import("./index.js");
  })();
  const adapter = createK8sAdapter();
  await adapter.start("berth/x:1.0.0", { imageRef: "berth/x:1.0.0", manifest: resourcedManifest });

  const expected = { cpu: "0.5", memory: "512Mi", "nvidia.com/gpu": "1" };
  assert.deepEqual(podBody.spec.containers[0].resources, { requests: expected, limits: expected });
});

test("start() sets a topology.kubernetes.io/region nodeSelector when target.region is given", async (t) => {
  let podBody: any;
  const coreApi = {
    createNamespacedPod: async (args: any) => {
      podBody = args.body;
      return { metadata: { name: "x-abc12" } };
    },
  };
  t.mock.module("@kubernetes/client-node", mockK8sModule(coreApi));
  const { createK8sAdapter } = await import("./index.js");
  const adapter = createK8sAdapter();
  await adapter.start("berth/x:1.0.0", { imageRef: "berth/x:1.0.0", manifest, region: "eu-central-1" });

  assert.deepEqual(podBody.spec.nodeSelector, { "topology.kubernetes.io/region": "eu-central-1" });
});

test("start() sends no nodeSelector when target.region isn't set", async (t) => {
  let podBody: any;
  const coreApi = {
    createNamespacedPod: async (args: any) => {
      podBody = args.body;
      return { metadata: { name: "x-abc12" } };
    },
  };
  t.mock.module("@kubernetes/client-node", mockK8sModule(coreApi));
  const { createK8sAdapter } = await import("./index.js");
  const adapter = createK8sAdapter();
  await adapter.start("berth/x:1.0.0", { imageRef: "berth/x:1.0.0", manifest });

  assert.equal(podBody.spec.nodeSelector, undefined);
});

test("rpcUrl() returns null for a handle this adapter didn't create", async (t) => {
  t.mock.module("@kubernetes/client-node", mockK8sModule({}));
  const { createK8sAdapter } = await import("./index.js");
  const adapter = createK8sAdapter();
  const foreignHandle = {
    id: "not-k8s",
    status: async () => "running" as const,
    streamLogs: async function* () {},
    stop: async () => {},
  };

  const url = await adapter.rpcUrl!(foreignHandle, 7300);
  assert.equal(url, null);
});
