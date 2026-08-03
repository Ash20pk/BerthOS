import { test } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { isContainerRunning, removeStaleContainer } from "./os-docker.js";

function fakeDocker(container: { inspect: () => Promise<unknown>; remove?: () => Promise<void> }): Docker {
  return { getContainer: () => container } as unknown as Docker;
}

test("isContainerRunning() returns true when the container inspects as Running", async () => {
  const docker = fakeDocker({ inspect: async () => ({ State: { Running: true } }) });
  assert.equal(await isContainerRunning(docker, "berth-os-x"), true);
});

test("isContainerRunning() returns false when the container inspects as stopped", async () => {
  const docker = fakeDocker({ inspect: async () => ({ State: { Running: false } }) });
  assert.equal(await isContainerRunning(docker, "berth-os-x"), false);
});

test("isContainerRunning() returns false when no container exists under that name", async () => {
  const docker = fakeDocker({
    inspect: async () => {
      throw new Error("no such container");
    },
  });
  assert.equal(await isContainerRunning(docker, "berth-os-x"), false);
});

test("removeStaleContainer() removes a leftover stopped container and reports it was removed", async () => {
  let removed = false;
  const docker = fakeDocker({
    inspect: async () => ({ State: { Running: false } }),
    remove: async () => {
      removed = true;
    },
  });

  const result = await removeStaleContainer(docker, "berth-os-x");

  assert.equal(result, true);
  assert.equal(removed, true);
});

test("removeStaleContainer() is a no-op when nothing is registered under that name", async () => {
  let removeCalled = false;
  const docker = fakeDocker({
    inspect: async () => {
      throw new Error("no such container");
    },
    remove: async () => {
      removeCalled = true;
    },
  });

  const result = await removeStaleContainer(docker, "berth-os-x");

  assert.equal(result, false);
  assert.equal(removeCalled, false);
});
