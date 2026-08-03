import { existsSync } from "node:fs";
import { mkdir, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Docker from "dockerode";
import type { DeployAdapter } from "@berth/adapter-core";
import { inputSchemaFor } from "./tools.js";
import { resolveComputerApps, type ComputerAppSpec } from "./resolve-apps.js";
import { Computer, type ComputerHandle } from "./computer.js";
import { buildComputerImage } from "./build.js";
import { HttpBridgeComputer } from "./fleet-computer.js";
import type { Tool } from "./types.js";

const DEFAULT_NETWORK_NAME = "berth-agent-net";
/** Arbitrary, chosen only to avoid the handful of ports first-party apps already use (8090 egress broker, 8092 GitHub broker, 4875 mesh-coordinator) — fully overridable per bootNetworkedAgent({fleet: {port}}) call. */
const DEFAULT_FLEET_RPC_PORT = 7300;

export interface AgentServerLLMConfig {
  provider: "anthropic" | "openai";
  model?: string;
  /**
   * Name of the env var the generated app reads its API key from at
   * runtime (e.g. "ANTHROPIC_API_KEY") — the key itself is passed into the
   * container via Computer.boot()'s `env` option, never embedded in
   * generated source.
   */
  apiKeyEnvVar: string;
}

export interface GenerateAgentServerAppOptions {
  /** Must not collide with any sibling app's name — this becomes the app's own berth.yml `name`. */
  name: string;
  llm: AgentServerLLMConfig;
  systemPrompt?: string;
  /** The peer's own tool-providing apps — their exports become this agent-server's tool list. */
  siblingApps: ComputerAppSpec[];
}

export interface GeneratedAgentServerApp {
  name: string;
  appDir: string;
}

interface EmbeddedToolSpec {
  name: string;
  description: string;
  inputSchema: object;
  appName: string;
  exportName: string;
}

function embeddedToolsFor(apps: ComputerAppSpec[]): EmbeddedToolSpec[] {
  const namespaced = apps.length > 1;
  const specs: EmbeddedToolSpec[] = [];
  for (const app of apps) {
    for (const exportSpec of app.manifest.exports) {
      specs.push({
        name: namespaced ? `${app.name}__${exportSpec.name}` : exportSpec.name,
        description: `Berth resident app export "${exportSpec.name}" (from ${app.name}'s berth.yml)`,
        inputSchema: inputSchemaFor(exportSpec),
        appName: app.name,
        exportName: exportSpec.name,
      });
    }
  }
  return specs;
}

function renderManifestYaml(name: string): string {
  return `name: ${name}
version: 0.1.0
description: "Synthesized by @berth/agents — runs an in-container agent loop reachable as a Crew.networked() peer"

capabilities:
  # v1 simplification: unrestricted egress rather than a scoped broker — the
  # existing egress broker only host-matches browser:navigate:* today (see
  # docs/egress-broker-reference.md). Documented follow-up in
  # docs/agents-reference.md.
  - network:connect:*

exports:
  - name: run_task
    input: { task: string }
    output: { text: string }

on_install: []
on_agent_ready: []
`;
}

function renderPackageJson(name: string): string {
  return (
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "dist/index.js",
        dependencies: {
          "@berth/sdk": "file:./vendor/berth-sdk.tgz",
          zod: "^3.24.1",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Same vendoring mechanism `berth init` already uses (packages/cli/src/commands/init.ts's
 * vendorSdk()) to make @berth/sdk resolvable outside the pnpm workspace — this
 * generated app lives in a temp directory, not a workspace member.
 */
async function vendorSdk(appDir: string): Promise<void> {
  const sdkEntryPath = fileURLToPath(import.meta.resolve("@berth/sdk"));
  const sdkPkgRoot = dirname(dirname(sdkEntryPath)); // dist/index.js -> dist -> package root
  const tarballPath = join(sdkPkgRoot, "dist-external", "berth-sdk.tgz");
  if (!existsSync(tarballPath)) {
    throw new Error(`@berth/sdk's external bundle not found at ${tarballPath} — run \`pnpm --filter @berth/sdk build\` first`);
  }
  const vendorDir = join(appDir, "vendor");
  await mkdir(vendorDir, { recursive: true });
  await cp(tarballPath, join(vendorDir, "berth-sdk.tgz"));
}

/**
 * The generated app's runtime: a self-contained agent loop using only Node
 * built-ins (node:net for sibling RPC sockets, fetch() for the LLM API) —
 * deliberately not importing @berth/agents itself, which would drag
 * @anthropic-ai/sdk/openai (and their own vendoring) into the sandbox. Kept
 * as one provider-native loop per LLM (Anthropic content-blocks vs OpenAI
 * role/tool_calls) rather than a third unified format, since this is
 * generated source, not a place to layer another abstraction.
 */
function renderAgentServerSource(options: GenerateAgentServerAppOptions): string {
  const tools = embeddedToolsFor(options.siblingApps);
  const llm = { provider: options.llm.provider, model: options.llm.model ?? null, apiKeyEnvVar: options.llm.apiKeyEnvVar };
  const systemPrompt = options.systemPrompt ?? null;

  return `import { defineApp } from "@berth/sdk";
import { z } from "zod";
import * as net from "node:net";

const TOOLS = ${JSON.stringify(tools)};
const LLM = ${JSON.stringify(llm)};
const SYSTEM_PROMPT = ${JSON.stringify(systemPrompt)};
const MAX_TURNS = 25;

function callSibling(appName, exportName, input) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(\`/tmp/berth-rpc/\${appName}.sock\`);
    const id = \`\${Date.now()}-\${Math.random().toString(36).slice(2)}\`;
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(\`callSibling(\${appName}, \${exportName}) timed out\`));
    }, 15000);
    socket.on("connect", () => socket.write(JSON.stringify({ id, export: exportName, input }) + "\\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const nl = buffer.indexOf("\\n");
      if (nl === -1) return;
      clearTimeout(timer);
      const line = buffer.slice(0, nl);
      socket.end();
      try {
        const response = JSON.parse(line);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function invokeTool(call) {
  const spec = TOOLS.find((t) => t.name === call.name);
  if (!spec) return { error: \`no such tool "\${call.name}"\` };
  try {
    return await callSibling(spec.appName, spec.exportName, call.input);
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function chatAnthropic(messages) {
  const apiKey = process.env[LLM.apiKeyEnvVar];
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: LLM.model || "claude-sonnet-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT || undefined,
      messages,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    }),
  });
  if (!response.ok) throw new Error(\`Anthropic API error \${response.status}: \${await response.text()}\`);
  const data = await response.json();
  const textBlocks = data.content.filter((b) => b.type === "text");
  const toolUseBlocks = data.content.filter((b) => b.type === "tool_use");
  return {
    text: textBlocks.map((b) => b.text).join("\\n") || undefined,
    toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
    assistantContent: data.content,
  };
}

async function runAnthropicLoop(task) {
  const messages = [{ role: "user", content: task }];
  for (let i = 0; i < MAX_TURNS; i++) {
    const turn = await chatAnthropic(messages);
    if (turn.toolCalls.length === 0) return turn.text || "";
    messages.push({ role: "assistant", content: turn.assistantContent });
    const resultsContent = [];
    for (const call of turn.toolCalls) {
      const output = await invokeTool(call);
      resultsContent.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(output) });
    }
    messages.push({ role: "user", content: resultsContent });
  }
  throw new Error("agent-server exceeded MAX_TURNS without reaching a final answer");
}

async function chatOpenAI(messages) {
  const apiKey = process.env[LLM.apiKeyEnvVar];
  const chatMessages = SYSTEM_PROMPT ? [{ role: "system", content: SYSTEM_PROMPT }, ...messages] : messages;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: \`Bearer \${apiKey}\`, "content-type": "application/json" },
    body: JSON.stringify({
      model: LLM.model || "gpt-4o",
      messages: chatMessages,
      tools: TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    }),
  });
  if (!response.ok) throw new Error(\`OpenAI API error \${response.status}: \${await response.text()}\`);
  const data = await response.json();
  const message = data.choices[0].message;
  const toolCalls = (message.tool_calls || []).map((c) => ({
    id: c.id,
    name: c.function.name,
    input: c.function.arguments ? JSON.parse(c.function.arguments) : {},
  }));
  return { text: message.content || undefined, toolCalls, message };
}

async function runOpenAILoop(task) {
  const messages = [{ role: "user", content: task }];
  for (let i = 0; i < MAX_TURNS; i++) {
    const turn = await chatOpenAI(messages);
    if (turn.toolCalls.length === 0) return turn.text || "";
    messages.push(turn.message);
    for (const call of turn.toolCalls) {
      const output = await invokeTool(call);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  throw new Error("agent-server exceeded MAX_TURNS without reaching a final answer");
}

export default defineApp((app) => {
  app.export({
    name: "run_task",
    input: z.object({ task: z.string() }),
    output: z.object({ text: z.string() }),
    handler: async ({ task }) => {
      const text = LLM.provider === "openai" ? await runOpenAILoop(task) : await runAnthropicLoop(task);
      return { text };
    },
  });
});
`;
}

/**
 * Synthesizes a resident app on disk (berth.yml + package.json + a
 * plain, pre-built dist/index.js — no TS compile step needed) that runs its
 * own agent loop over its sibling apps' tools, reachable via its one
 * `run_task` export exactly like any other companion app's export
 * (Computer's own invokeAppExport/createStdioRpcClient transport). See
 * bootNetworkedAgent() for the Computer wiring.
 */
export async function generateAgentServerApp(options: GenerateAgentServerAppOptions): Promise<GeneratedAgentServerApp> {
  const appDir = await mkdtemp(join(tmpdir(), "berth-agent-server-"));

  await writeFile(join(appDir, "berth.yml"), renderManifestYaml(options.name));
  await writeFile(join(appDir, "package.json"), renderPackageJson(options.name));
  await vendorSdk(appDir);

  const distDir = join(appDir, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "index.js"), renderAgentServerSource(options));

  return { name: options.name, appDir };
}

export interface NetworkedAgentFleetOptions {
  /** Deploys this peer to a remote fleet (E2B, Daytona, K8s) instead of a local Docker container — the adapter must implement rpcUrl(). */
  adapter: DeployAdapter;
  /** Port the deployed instance's HTTP RPC bridge listens on. Defaults to DEFAULT_FLEET_RPC_PORT. */
  port?: number;
}

export interface NetworkedAgentOptions {
  /** Peer identity — also used to name its synthesized agent-server companion app. */
  name: string;
  /** This peer's own resident-app directories — their exports become its tool set. */
  apps: string[];
  llm: AgentServerLLMConfig;
  systemPrompt?: string;
  /** Shared Docker network peers join — defaults to one shared name so callers don't have to coordinate it themselves. Ignored when `fleet` is set. */
  network?: string;
  /** Deploy this peer to a remote fleet instead of booting it locally — see NetworkedAgentFleetOptions. Omit for today's local-Docker behavior, unchanged. */
  fleet?: NetworkedAgentFleetOptions;
  env?: Record<string, string>;
  docker?: Docker;
}

export interface NetworkedAgent {
  computer: ComputerHandle;
  /**
   * Delegates a task to this peer's own in-container agent loop — hand this
   * to Crew.networked() as one of the manager's tools. For a local peer,
   * dispatches through Computer's existing invokeAppExport/createStdioRpcClient
   * transport (host mediated); the peer's container is also joined to
   * `network`, which is the substrate for direct container-to-container
   * reachability — wiring a mesh dispatch path through that instead of the
   * host is deferred (see docs/agents-reference.md). For a fleet-deployed
   * peer, dispatches over its HTTP RPC bridge instead (see `transport`).
   */
  tool: Tool;
  /** Which transport this peer ended up on — informational only, for logging/debugging. Crew.networked() never reads it. */
  transport: "local" | "http";
  stop(): Promise<void>;
}

/**
 * Boots a Computer whose tools are this peer's own resident apps *plus* a
 * synthesized agent-server companion app that runs its own agent loop over
 * them — i.e. the agent itself lives on this computer, not just its tools.
 * Returns a Tool a manager Agent can delegate to via Crew.networked().
 *
 * Without `fleet`, this peer boots as a local Docker container, byte-for-
 * byte the same as before `fleet` existed. With `fleet`, it's deployed
 * through the given DeployAdapter (E2B, Daytona, K8s) instead, reached over
 * an HTTP RPC bridge rather than docker exec/attach — see fleet-computer.ts.
 * Either way, the returned `tool` looks identical to a caller; Crew.networked()
 * needs no awareness of which one it got.
 */
export async function bootNetworkedAgent(options: NetworkedAgentOptions): Promise<NetworkedAgent> {
  const siblingApps = await resolveComputerApps(options.apps);
  const agentServerName = `${options.name}-agent-server`;

  const agentServerApp = await generateAgentServerApp({
    name: agentServerName,
    llm: options.llm,
    systemPrompt: options.systemPrompt,
    siblingApps,
  });

  const computer: ComputerHandle = options.fleet
    ? await bootFleetComputer(options, agentServerName, agentServerApp.appDir)
    : await Computer.boot({
        apps: [...options.apps, agentServerApp.appDir],
        network: options.network ?? DEFAULT_NETWORK_NAME,
        env: options.env,
        docker: options.docker,
      });

  const runTaskToolName = `${agentServerName}__run_task`;
  const tool: Tool = {
    name: options.name,
    description: `Delegate a task to the networked "${options.name}" agent, running independently in its own computer.`,
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "the task to delegate to this networked agent" } },
      required: ["task"],
    },
    invoke: async (input: unknown) => {
      const { task } = input as { task: string };
      const result = (await computer.call(runTaskToolName, { task })) as { text: string };
      return result.text;
    },
  };

  return { computer, tool, transport: options.fleet ? "http" : "local", stop: () => computer.stop() };
}

async function bootFleetComputer(options: NetworkedAgentOptions, agentServerName: string, agentServerAppDir: string): Promise<HttpBridgeComputer> {
  // Same [siblings..., agent-server] ordering Computer.boot() uses for the
  // local path — buildComputerImage() treats the first app as primary
  // (naming only; every app's exports still end up as tools either way).
  const allApps = await resolveComputerApps([...options.apps, agentServerAppDir]);
  const imageRef = await buildComputerImage(allApps);

  return HttpBridgeComputer.deploy({
    adapter: options.fleet!.adapter,
    port: options.fleet!.port ?? DEFAULT_FLEET_RPC_PORT,
    imageRef,
    manifest: allApps[0]!.manifest,
    apps: allApps,
    rpcAppName: agentServerName,
    env: options.env,
  });
}
