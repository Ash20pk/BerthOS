export { buildImage, type BuildImageOptions, type BuildTarget } from "./image.js";
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
  type ContainerFailure,
  type StartContainerOptions,
  type RunningContainer,
} from "./container.js";
export {
  runDoctor,
  probeKernel,
  findProbeImage,
  type DoctorReport,
  type DoctorCheck,
  type CheckStatus,
  type RunDoctorOptions,
  type LandlockProbeResult,
  enforcementStatusForBoot,
  warnIfEnforcementInactive,
  unenforcedBanner,
  resetBannerState,
} from "./doctor.js";
export { watchApp, type WatchHandle } from "./watch.js";
export { invokeAppExport, rpcSocketPathFor, RPC_SOCKET_DIR, type RpcRequest, type RpcResponse } from "./relay.js";
export { createStdioRpcClient, type StdioRpcClient } from "./stdio-rpc.js";
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
