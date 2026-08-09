import type { z } from "zod";
import { Agent, type StructuredOutputRunOptions } from "./agent.js";
import type { NetworkedAgent } from "./network.js";
import type { CheckpointStore } from "./checkpoint.js";
import { parseStructuredOutput, structuredOutputRepairPrompt, StructuredOutputError } from "./structured-output.js";

export interface CrewRun {
  run(input: string): Promise<string>;
}

export interface CrewStateRun<S> {
  run(initialState: S): Promise<S>;
}

/**
 * The composition-level counterpart to Agent's own CheckpointedRun — reuses
 * the exact same CheckpointStore seam (generic over the checkpoint shape),
 * so "resume a crashed Crew" needs no new storage concept, only this shape.
 * `state` is whatever the composition threads between steps (a `string` for
 * sequential/loopUntil, the typed `S` for pipeline).
 */
export interface CrewCheckpoint<S = unknown> {
  runId: string;
  kind: string;
  status: "running" | "done" | "error";
  /** Index of the next step to run — where a resumed run picks back up. */
  completedSteps: number;
  state: S;
}

interface CrewCheckpointOptions<S> {
  checkpoint?: CheckpointStore<CrewCheckpoint<S>>;
  /**
   * Also passed straight through to every step's Agent.run(current, {runId})
   * call — see the module-level comment on RUN_ID_TRACE below for why
   * checkpointing and trace correlation share this one option instead of
   * two, and how a collision between them is avoided.
   */
  runId?: string;
}

/**
 * Crew's own checkpoint is stored under a key namespaced away from the bare
 * `runId` — `runId` itself is handed to each step's Agent.run() call for
 * trace correlation, unchanged in the shapes whose steps run one at a time
 * (sequential, loopUntil, route, withManager, networked) and derived per
 * agent in the one that fans out (see fanOutRunIdFor()). If Crew's checkpoint
 * used that same bare runId as its
 * storage key, and a step's own Agent *also* happened to have its own
 * `checkpoint` store pointed at the same backend, both checkpoints would
 * collide on the same CheckpointStore path and corrupt each other. Namespacing
 * Crew's own key avoids that without asking the caller to juggle two ids.
 */
// Exported (but deliberately not re-exported from index.ts — this is an
// implementation detail of Crew's own storage key, not part of the public
// checkpointing API) so tests can seed/inspect a checkpoint under the exact
// key Crew itself reads and writes, without hardcoding the "crew__" prefix
// in two places.
export function checkpointKeyFor(runId: string): string {
  return `crew__${runId}`;
}

/**
 * Every agent in a fan-out shape gets its own derived runId rather than the
 * crew's bare one. Handing N concurrently-running agents a single runId meant
 * all N wrote the same checkpoint key and the same trace blob: the surviving
 * checkpoint was an interleaved mixture of unrelated runs, and `resume(runId)`
 * replayed it as though it were one. The trace side was already a known race
 * (tracing.ts's read-modify-write note); the checkpoint side was not.
 * See REMEDIATION 3.3.
 *
 * The index comes before the name and is what actually guarantees uniqueness:
 * Agent's default name is "agent", so a crew built from agents nobody named
 * would otherwise collide exactly as before. The name is included after it
 * purely so a stored key is recognizable when you go looking for one — it's
 * sanitized because these ids become path segments (`agent-runs/<id>.json`)
 * in the Semantic FS-backed store.
 *
 * The parent runId stays a prefix, so trace correlation across a fan-out is
 * still a prefix match rather than an exact one.
 */
export function fanOutRunIdFor(runId: string, agentName: string, index: number): string {
  return `${runId}:${index}:${agentName.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

async function loadCrewCheckpoint<S>(options: CrewCheckpointOptions<S>): Promise<CrewCheckpoint<S> | null> {
  if (!options.checkpoint || !options.runId) return null;
  return options.checkpoint.load(checkpointKeyFor(options.runId));
}

async function saveCrewCheckpoint<S>(
  options: CrewCheckpointOptions<S>,
  fields: Omit<CrewCheckpoint<S>, "runId">,
): Promise<void> {
  if (!options.checkpoint || !options.runId) return;
  await options.checkpoint.save({ runId: checkpointKeyFor(options.runId), ...fields });
}

/**
 * The Crew-level counterpart to Agent's own responseSchema repair loop
 * (agent.ts's loop()) — reuses the exact same parseStructuredOutput()/
 * structuredOutputRepairPrompt()/StructuredOutputError this package already
 * has for a single Agent's final answer, just re-running `repairAgent`
 * (whichever Agent actually produced the composition's final text) instead
 * of looping inside one Agent's own turn budget. Only wired into the Crew
 * shapes where "which Agent produced the final text" is unambiguous —
 * sequential's last agent, route's chosen branch — not parallel/withManager/
 * networked, where it's either ambiguous (which of N agents?) or already
 * covered by the manager's own responseSchema.
 */
async function repairStructuredOutput<T>(
  repairAgent: Agent,
  text: string,
  schema: z.ZodType<T>,
  maxRepairAttempts: number,
  runId: string | undefined,
  callerName: string,
): Promise<string> {
  let current = text;
  let parsed = parseStructuredOutput(current, schema);
  let attempts = 0;
  while (!parsed.success && attempts < maxRepairAttempts) {
    const repaired = await repairAgent.run(structuredOutputRepairPrompt(parsed.error), { runId });
    current = repaired.text;
    parsed = parseStructuredOutput(current, schema);
    attempts++;
  }
  if (!parsed.success) {
    throw new StructuredOutputError(
      `${callerName} failed to produce output matching responseSchema after ${maxRepairAttempts} repair attempt(s): ${parsed.error}`,
      current,
    );
  }
  return current;
}

/**
 * Multi-agent composition — both patterns here are just wiring over Agent,
 * not a new execution primitive: Agent's tool-use loop is identical whether
 * its tools are resident-app exports or other agents.
 */
export const Crew = {
  /**
   * Pipes each agent's output text as the next agent's input; returns the
   * last agent's output. `checkpoint`/`runId` (same CheckpointStore seam
   * Agent.run() itself uses) save which step just completed after every
   * agent — a crash between two agents resumes from the next one instead of
   * replaying the whole chain, closing the "Crew-level composition state
   * isn't checkpointed" gap for this shape specifically.
   */
  sequential<T = never>(
    agents: Agent[],
    options: CrewCheckpointOptions<string> & Partial<StructuredOutputRunOptions<T>> = {},
  ): CrewRun {
    return {
      async run(input: string): Promise<string> {
        const prior = await loadCrewCheckpoint(options);
        if (prior?.status === "done") return prior.state;
        const startIndex = prior?.completedSteps ?? 0;
        let current = prior ? prior.state : input;
        for (let i = startIndex; i < agents.length; i++) {
          const result = await agents[i]!.run(current, { runId: options.runId });
          current = result.text;
          const isLastStep = i === agents.length - 1;
          // The final step's checkpoint isn't saved as "done" until after
          // the optional repair pass below — a resumed run that crashed
          // mid-repair should re-attempt repair, not treat the unrepaired
          // text as already finished.
          await saveCrewCheckpoint(options, {
            kind: "sequential",
            status: isLastStep && !options.responseSchema ? "done" : "running",
            completedSteps: i + 1,
            state: current,
          });
        }

        if (options.responseSchema && agents.length > 0) {
          current = await repairStructuredOutput(
            agents[agents.length - 1]!,
            current,
            options.responseSchema,
            options.maxRepairAttempts ?? 2,
            options.runId,
            "Crew.sequential",
          );
          await saveCrewCheckpoint(options, {
            kind: "sequential",
            status: "done",
            completedSteps: agents.length,
            state: current,
          });
        }

        return current;
      },
    };
  },

  /**
   * Gives the manager one Tool per worker (worker.asTool()), so the manager's
   * own LLM decides when/whether to delegate — the "agent-as-tool" pattern,
   * reusing the exact same Tool dispatch path a resident-app export uses.
   */
  withManager(options: { manager: Agent; workers: Agent[]; runId?: string }): CrewRun {
    const workerTools = options.workers.map((worker) =>
      worker.asTool(`Delegate a task to the "${worker.name}" agent, then return what it reports back.`),
    );
    const manager = options.manager.withTools(workerTools);

    return {
      async run(input: string): Promise<string> {
        // Correlates only the manager's own turns/tool-calls under runId — a
        // delegated worker.asTool() call runs that worker via a plain
        // this.run(task) with no runId of its own (asTool()'s Tool shape
        // doesn't carry one through), so a worker's internal turns don't
        // join this trace even when the worker Agent has its own tracer.
        const result = await manager.run(input, { runId: options.runId });
        return result.text;
      },
    };
  },

  /**
   * Same "agent-as-tool" delegation as withManager(), but the workers are
   * genuinely independent agent-computers (bootNetworkedAgent()) rather than
   * in-process Agent objects — each free to run its own LLM/model/tool set
   * inside its own sandbox, joined to a shared Docker network.
   */
  networked(options: { manager: Agent; peers: NetworkedAgent[]; runId?: string }): CrewRun {
    const manager = options.manager.withTools(options.peers.map((peer) => peer.tool));

    return {
      async run(input: string): Promise<string> {
        // Same boundary as withManager(): only the manager's own turns
        // correlate under runId — a peer's own sandbox/Computer has no way
        // to receive it through the tool-call wire.
        const result = await manager.run(input, { runId: options.runId });
        return result.text;
      },
    };
  },

  /**
   * Runs every agent against the same input concurrently, then combines
   * their outputs — the "parallel-then-merge" shape none of
   * sequential/withManager/networked can express, since each of those pipes
   * one input through agents one at a time. Default `merge` concatenates
   * each agent's output under a `## <name>` heading; pass `merge` for
   * anything else (pick one, vote, structured combine).
   */
  parallel(
    agents: Agent[],
    options: { merge?: (results: { name: string; text: string }[]) => string; runId?: string } = {},
  ): CrewRun {
    const merge = options.merge ?? defaultParallelMerge;
    return {
      async run(input: string): Promise<string> {
        const results = await Promise.all(
          agents.map(async (agent, index) => ({
            name: agent.name,
            // Each concurrent agent gets its own derived runId — see
            // fanOutRunIdFor(). Passing options.runId to all N made them
            // overwrite each other's checkpoints and traces.
            text: (
              await agent.run(input, {
                runId: options.runId === undefined ? undefined : fanOutRunIdFor(options.runId, agent.name, index),
              })
            ).text,
          })),
        );
        return merge(results);
      },
    };
  },

  /**
   * Runs `agent` repeatedly, feeding its own output back in as the next
   * input — the cycle none of the other Crew shapes can express, since each
   * of those runs every agent at most once. Checked *after* each run (so it
   * always runs at least once), stops as soon as `until(result, iteration)`
   * returns true, or after `maxIterations` (default 10) if it never does —
   * the backstop against a condition that never triggers.
   */
  loopUntil(
    options: {
      agent: Agent;
      until: (result: string, iteration: number) => boolean;
      maxIterations?: number;
    } & CrewCheckpointOptions<string>,
  ): CrewRun {
    const maxIterations = options.maxIterations ?? 10;
    return {
      async run(input: string): Promise<string> {
        const prior = await loadCrewCheckpoint(options);
        if (prior?.status === "done") return prior.state;
        const startIteration = prior?.completedSteps ?? 0;
        let current = prior ? prior.state : input;
        for (let iteration = startIteration; iteration < maxIterations; iteration++) {
          const result = await options.agent.run(current, { runId: options.runId });
          current = result.text;
          const finished = options.until(current, iteration);
          await saveCrewCheckpoint(options, {
            kind: "loopUntil",
            status: finished ? "done" : "running",
            completedSteps: iteration + 1,
            state: current,
          });
          if (finished) {
            return current;
          }
        }
        return current;
      },
    };
  },

  /**
   * Conditional branching: `router` is asked to classify the input as
   * exactly one of `routes`'s keys, and only that one branch's agent runs
   * against the *original* input — the if/else a fixed sequential/manager/
   * networked shape has no way to express without dropping out of the
   * framework entirely. Falls back to `fallback` (or throws, naming what the
   * router actually said) when its answer doesn't match any route.
   */
  route<T = never>(
    options: {
      router: Agent;
      routes: Record<string, Agent>;
      fallback?: Agent;
      runId?: string;
    } & Partial<StructuredOutputRunOptions<T>>,
  ): CrewRun {
    return {
      async run(input: string): Promise<string> {
        const labels = Object.keys(options.routes);
        const classification = await options.router.run(
          `Classify the input below into exactly one of these labels: ${labels.join(", ")}.\n` +
            `Respond with only the label, nothing else.\n\nInput:\n${input}`,
          { runId: options.runId },
        );
        const answer = classification.text.trim();
        const label = labels.find((candidate) => candidate.toLowerCase() === answer.toLowerCase());
        const target = label ? options.routes[label] : options.fallback;
        if (!target) {
          throw new Error(
            `Crew.route: router "${options.router.name}" returned "${answer}", which matches none of [${labels.join(", ")}] and no fallback was given`,
          );
        }
        let result = (await target.run(input, { runId: options.runId })).text;
        if (options.responseSchema) {
          result = await repairStructuredOutput(
            target,
            result,
            options.responseSchema,
            options.maxRepairAttempts ?? 2,
            options.runId,
            "Crew.route",
          );
        }
        return result;
      },
    };
  },

  /**
   * Threads a typed state object across steps instead of only a `string` —
   * the gap every other Crew shape has, since sequential/parallel/loopUntil/
   * route all pipe plain text. Each step reads the accumulated state (built
   * from every prior step's return, not just the last one), does whatever it
   * needs with Agents/tools, and returns a partial update merged shallowly
   * into that state for the next step. Not a graph: steps still run in the
   * fixed order given, same "wiring over Agent" stance as the rest of Crew.
   * Unlike the other shapes, `pipeline` can't thread `runId` into an Agent's
   * `run()` call itself — it doesn't call any Agent directly, a step's own
   * function body does — so it's passed as that function's second argument
   * instead, for a step that wants its own Agent call to correlate under it.
   */
  pipeline<S extends object>(
    steps: Array<(state: S, runId?: string) => Promise<Partial<S>> | Partial<S>>,
    options: CrewCheckpointOptions<S> = {},
  ): CrewStateRun<S> {
    return {
      async run(initialState: S): Promise<S> {
        const prior = await loadCrewCheckpoint(options);
        if (prior?.status === "done") return prior.state;
        const startIndex = prior?.completedSteps ?? 0;
        let state = prior ? prior.state : initialState;
        for (let i = startIndex; i < steps.length; i++) {
          const update = await steps[i]!(state, options.runId);
          state = { ...state, ...update };
          await saveCrewCheckpoint(options, {
            kind: "pipeline",
            status: i === steps.length - 1 ? "done" : "running",
            completedSteps: i + 1,
            state,
          });
        }
        return state;
      },
    };
  },
};

function defaultParallelMerge(results: { name: string; text: string }[]): string {
  return results.map((r) => `## ${r.name}\n${r.text}`).join("\n\n");
}
