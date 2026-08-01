import { Agent } from "./agent.js";
import type { NetworkedAgent } from "./network.js";

export interface CrewRun {
  run(input: string): Promise<string>;
}

/**
 * Multi-agent composition — both patterns here are just wiring over Agent,
 * not a new execution primitive: Agent's tool-use loop is identical whether
 * its tools are resident-app exports or other agents.
 */
export const Crew = {
  /** Pipes each agent's output text as the next agent's input; returns the last agent's output. */
  sequential(agents: Agent[]): CrewRun {
    return {
      async run(input: string): Promise<string> {
        let current = input;
        for (const agent of agents) {
          const result = await agent.run(current);
          current = result.text;
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
};
