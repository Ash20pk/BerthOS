import { Args, Command } from "@oclif/core";
import { resolve } from "node:path";
import { createCrewFromYaml } from "@berth/agents";

export default class CrewRun extends Command {
  static override description =
    "Run a task against a Crew (sequential/parallel/withManager) declared in a YAML config file — see docs/agents-reference.md's declarative agent/crew config section";

  static override args = {
    file: Args.string({ required: true, description: "path to a YAML crew config file" }),
    task: Args.string({ required: true, description: "the task to hand the crew" }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(CrewRun);
    const configPath = resolve(process.cwd(), args.file);

    const { crew, computers } = await createCrewFromYaml(configPath);
    try {
      const result = await crew.run(args.task);
      this.log(result);
    } finally {
      await Promise.all(computers.map((computer) => computer.stop()));
    }
  }
}
