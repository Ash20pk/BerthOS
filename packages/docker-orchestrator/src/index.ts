import { applyDockerContext } from "./docker-host.js";

// Before anything here constructs a Docker client: follow the selected
// Docker context the way the `docker` CLI does. See docker-host.ts.
applyDockerContext();

export {
  resolveDockerHost,
  applyDockerContext,
  describeDockerHost,
  type DockerHostResolution,
} from "./docker-host.js";
export { buildImage, removeImageKeepingCache, type BuildImageOptions, type BuildTarget } from "./image.js";
export {
  startContainer,
  stopContainer,
  restartContainer,
  streamLogs,
  declaresBrowserCapability,
  declaresTerminalCapability,
  needsBrowserPorts,
  needsTerminalPort,
  describeContainerFailure,
  formatContainerFailure,
  containerResources,
  type ContainerFailure,
  type StartContainerOptions,
  type RunningContainer,
} from "./container.js";
export {
  runDoctor,
  probeKernel,
  findProbeImage,
  PROBE_FALLBACK_IMAGE,
  type DoctorReport,
  type DoctorCheck,
  type CheckStatus,
  type RunDoctorOptions,
  type LandlockProbeResult,
  enforcementStatusForBoot,
  cgroupDelegationVerdict,
  cgroupDelegationForBoot,
  type CgroupProbe,
  warnIfEnforcementInactive,
  unenforcedBanner,
  resetBannerState,
} from "./doctor.js";
export {
  gatherBootEvidence,
  demuxLogBuffer,
  parseBootId,
  parsePolicyLines,
  parseRulesetReports,
  parseResourceLimits,
  type BootEvidence,
  type ResourceLimitsEvidence,
} from "./attest.js";
export { watchApp, type WatchHandle } from "./watch.js";
export { invokeAppExport, rpcSocketPathFor, RPC_SOCKET_DIR, type RpcRequest, type RpcResponse } from "./relay.js";
export { createStdioRpcClient, DEFAULT_STDIO_RPC_TIMEOUT_MS, RpcNotSentError, type StdioRpcCallOptions, type StdioRpcClient } from "./stdio-rpc.js";
export {
  createSnapshot,
  restoreSnapshot,
  listSnapshots,
  snapshotDirFor,
  type SnapshotMetadata,
  type CreateSnapshotOptions,
  type RestoredSnapshot,
} from "./snapshot.js";
export {
  readOsState,
  writeOsState,
  removeOsState,
  listOsNames,
  type OsStateFile,
  type OsAppRecord,
} from "./os-state.js";
export {
  isSecretEnvName,
  partitionSecretEnv,
  stripSecretEnv,
  serializeSecretsEnvFile,
  writeContainerSecretsFile,
  removeContainerSecretsDir,
  containerSecretsDir,
  isGroupOrWorldReadable,
  CONTAINER_SECRETS_PATH,
  CONTAINER_APP_SECRETS_DIR,
  partitionSecretsPerApp,
  writePerAppSecretsFiles,
  type PartitionedEnv,
  type AppSecretsDeclaration,
  type PerAppSecretPartition,
} from "./secrets.js";
export {
  startSemanticFsSidecar,
  stopSemanticFsSidecar,
  sidecarName,
  sidecarHostDir,
  SIDECAR_EXPORT_DIR,
  type RunningSidecar,
} from "./semantic-fs-sidecar.js";
