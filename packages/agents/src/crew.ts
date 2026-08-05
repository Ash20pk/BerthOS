import { Agent } from "./agent.js";
import type { NetworkedAgent } from "./network.js";
import type { CheckpointStore } from "./checkpoint.js";

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
  runId?: string;
}

async function loadCrewCheckpoint<S>(options: CrewCheckpointOptions<S>): Promise<CrewCheckpoint<S> | null> {
  if (!options.checkpoint || !options.runId) return null;
  return options.checkpoint.load(options.runId);
}

async function saveCrewCheckpoint<S>(
  options: CrewCheckpointOptions<S>,
  fields: Omit<CrewCheckpoint<S>, "runId">,
): Promise<void> {
  if (!options.checkpoint || !options.runId) return;
  await options.checkpoint.save({ runId: options.runId, ...fields });
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
  sequential(agents: Agent[], options: CrewCheckpointOptions<string> = {}): CrewRun {
    return {
      async run(input: string): Promise<string> {
        const prior = await loadCrewCheckpoint(options);
        if (prior?.status === "done") return prior.state;
        const startIndex = prior?.completedSteps ?? 0;
        let current = prior ? prior.state : input;
        for (let i = startIndex; i < agents.length; i++) {
          const result = await agents[i]!.run(current);
          current = result.text;
          await saveCrewCheckpoint(options, {
            kind: "sequential",
            status: i === agents.length - 1 ? "done" : "running",
            completedSteps: i + 1,
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
  withManager(options: { manager: Agent; workers: Agent[] }): CrewRun {
    const workerTools = options.workers.map((worker) =>
      worker.asTool(`Delegate a task to the "${worker.name}" agent, then return what it reports back.`),
    );
    const manager = options.manager.withTools(workerTools);

    return {
      async run(input: string): Promise<string> {
        const result = await manager.run(input);
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
  networked(options: { manager: Agent; peers: NetworkedAgent[] }): CrewRun {
    const manager = options.manager.withTools(options.peers.map((peer) => peer.tool));

    return {
      async run(input: string): Promise<string> {
        const result = await manager.run(input);
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
    options: { merge?: (results: { name: string; text: string }[]) => string } = {},
  ): CrewRun {
    const merge = options.merge ?? defaultParallelMerge;
    return {
      async run(input: string): Promise<string> {
        const results = await Promise.all(
          agents.map(async (agent) => ({ name: agent.name, text: (await agent.run(input)).text })),
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
          const result = await options.agent.run(current);
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
  route(options: { router: Agent; routes: Record<string, Agent>; fallback?: Agent }): CrewRun {
    return {
      async run(input: string): Promise<string> {
        const labels = Object.keys(options.routes);
        const classification = await options.router.run(
          `Classify the input below into exactly one of these labels: ${labels.join(", ")}.\n` +
            `Respond with only the label, nothing else.\n\nInput:\n${input}`,
        );
        const answer = classification.text.trim();
        const label = labels.find((candidate) => candidate.toLowerCase() === answer.toLowerCase());
        const target = label ? options.routes[label] : options.fallback;
        if (!target) {
          throw new Error(
            `Crew.route: router "${options.router.name}" returned "${answer}", which matches none of [${labels.join(", ")}] and no fallback was given`,
          );
        }
        return (await target.run(input)).text;
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
   */
  pipeline<S extends object>(
    steps: Array<(state: S) => Promise<Partial<S>> | Partial<S>>,
    options: CrewCheckpointOptions<S> = {},
  ): CrewStateRun<S> {
    return {
      async run(initialState: S): Promise<S> {
        const prior = await loadCrewCheckpoint(options);
        if (prior?.status === "done") return prior.state;
        const startIndex = prior?.completedSteps ?? 0;
        let state = prior ? prior.state : initialState;
        for (let i = startIndex; i < steps.length; i++) {
          const update = await steps[i]!(state);
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
