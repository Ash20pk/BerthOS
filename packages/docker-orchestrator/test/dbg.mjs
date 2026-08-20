import { join } from "node:path";
import { loadManifest } from "/Users/ash/agentOS/packages/manifest-schema/dist/index.js";
import Docker from "dockerode";
import { startContainer } from "/Users/ash/agentOS/packages/docker-orchestrator/dist/index.js";
const docker = new Docker();
const manifest = await loadManifest("/Users/ash/agentOS/apps/filesystem/berth.yml");
await docker.getContainer("berth-m11-dbg").remove({force:true}).catch(()=>{});
await docker.getContainer("berth-m11-dbg-fs").remove({force:true}).catch(()=>{});
const r = await startContainer({
  image: "berth/filesystem:dev", name: "berth-m11-dbg", manifest,
  bindMount: { hostPath: "/Users/ash/agentOS", containerPath: "/workspace" },
  workingDir: "/workspace/apps/filesystem",
  env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" }, docker,
});
console.log("booted", r.container.id.slice(0,12));
