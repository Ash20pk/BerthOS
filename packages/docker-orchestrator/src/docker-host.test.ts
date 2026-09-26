import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDockerHost, describeDockerHost } from "./docker-host.js";

/** A fake ~/.docker with the given current context and context endpoints. */
async function dockerConfig(current: string | undefined, contexts: Record<string, string>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "berth-docker-host-"));
  const dir = join(home, ".docker");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(current ? { currentContext: current } : {}));
  for (const [name, host] of Object.entries(contexts)) {
    const metaDir = join(dir, "contexts", "meta", createHash("sha256").update(name).digest("hex"));
    await mkdir(metaDir, { recursive: true });
    await writeFile(join(metaDir, "meta.json"), JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }));
  }
  return home;
}

const COLIMA = "unix:///Users/me/.colima/default/docker.sock";
const DESKTOP = "unix:///Users/me/.docker/run/docker.sock";

test("the current Docker context is followed, as `docker context use` would have it", async () => {
  const home = await dockerConfig("colima", { colima: COLIMA, "desktop-linux": DESKTOP });
  const r = resolveDockerHost({}, home);
  assert.equal(r.host, COLIMA);
  assert.equal(r.source, "docker context");
  assert.match(describeDockerHost(r), /current Docker context "colima"/);
});

test("DOCKER_HOST wins over any context", async () => {
  const home = await dockerConfig("colima", { colima: COLIMA });
  const r = resolveDockerHost({ DOCKER_HOST: DESKTOP }, home);
  assert.equal(r.host, DESKTOP);
  assert.equal(r.source, "DOCKER_HOST");
});

test("DOCKER_CONTEXT wins over config.json's currentContext", async () => {
  const home = await dockerConfig("desktop-linux", { colima: COLIMA, "desktop-linux": DESKTOP });
  const r = resolveDockerHost({ DOCKER_CONTEXT: "colima" }, home);
  assert.equal(r.host, COLIMA);
  assert.equal(r.source, "DOCKER_CONTEXT");
});

test("the default context, or no config at all, leaves dockerode's default alone", async () => {
  assert.equal(resolveDockerHost({}, await dockerConfig("default", {})).host, undefined);
  assert.equal(resolveDockerHost({}, await dockerConfig(undefined, {})).host, undefined);
  assert.equal(resolveDockerHost({}, await mkdtemp(join(tmpdir(), "berth-no-docker-"))).source, "default");
});

test("a selected context that's gone (Colima deletes its own on stop) is a named problem, not a silent default", async () => {
  const home = await dockerConfig("colima", {});
  const r = resolveDockerHost({}, home);
  assert.equal(r.host, undefined);
  assert.match(r.problem ?? "", /"colima" is selected but not found/);
});

test("a tcp:// context isn't dialed without its TLS material", async () => {
  const home = await dockerConfig("remote", { remote: "tcp://10.0.0.5:2376" });
  const r = resolveDockerHost({}, home);
  assert.equal(r.host, undefined);
  assert.match(r.problem ?? "", /only unix:\/\/ and npipe:\/\/ contexts are followed/);
});

test("DOCKER_CONFIG relocates the config directory, as it does for the CLI", async () => {
  const home = await dockerConfig("colima", { colima: COLIMA });
  const r = resolveDockerHost({ DOCKER_CONFIG: join(home, ".docker") }, "/nonexistent-home");
  assert.equal(r.host, COLIMA);
});
