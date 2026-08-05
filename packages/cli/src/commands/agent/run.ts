import { Args, Command, Flags } from "@oclif/core";
import { resolve } from "node:path";
import { createAgentFromYaml } from "@berth/agents";

export default class AgentRun extends Command {
  static override description =
    "Run a task against an Agent declared in a YAML config file — the declarative alternative to createAgent() in code, see docs/agents-reference.md's declarative agent/crew config section";

  static override args = {
    file: Args.string({ required: true, description: "path to a YAML agent config file" }),
    task: Args.string({ required: true, description: "the task to hand the agent" }),
  };

  static override flags = {
    json: Flags.boolean({ description: "emit {text, toolCalls} as JSON instead of just the answer text" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentRun);
    const configPath = resolve(process.cwd(), args.file);

    const { agent, computer } = await createAgentFromYaml(configPath);
    try {
      const result = await agent.run(args.task);
      this.log(flags.json ? JSON.stringify(result, null, 2) : result.text);
    } finally {
      await computer.stop();
    }
  }
}
