import { Command, Args, Flags } from "@oclif/core";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  runEvalSuite,
  recordEvalRun,
  listEvalRuns,
  type EvalRunnable,
  type EvalCase,
  type EvalSuiteResult,
  type ComputerHandle,
} from "@berth/agents";

/**
 * What an eval file must export: a default async factory, not a static
 * {runnable, cases} object — building a real EvalRunnable almost always
 * means booting a Computer or constructing an Agent first, both async, and
 * this command has no idea which apps/provider/model a given suite needs.
 * `teardown` is optional because not every runnable owns something that
 * needs closing (a plain in-process Crew adapter might not), but most will —
 * a booted Computer needs `computer.stop()` or its container leaks.
 * `computer`/`suiteName` are also optional: only present them if you want
 * this run recorded to Semantic FS (recordEvalRun()) and browsable via
 * `--history` later — a suite that doesn't return a Computer just runs
 * without history, same as passing no `checkpoint`/`trace` to an Agent.
 */
interface EvalModule {
  default: () => Promise<{
    runnable: EvalRunnable;
    cases: EvalCase[];
    computer?: ComputerHandle;
    suiteName?: string;
    teardown?: () => Promise<void>;
  }>;
}

export default class Eval extends Command {
  static override description =
    "Run an eval suite (packages/agents' runEvalSuite) against a real Agent/Crew — a regression check for agent *behavior*, distinct from `berth test`'s manifest/export shape check";
  static override args = {
    file: Args.string({
      required: true,
      description: "path to a module with a default export: async () => {runnable, cases, computer?, suiteName?, teardown?}",
    }),
  };
  static override flags = {
    json: Flags.boolean({ description: "emit a structured JSON summary instead of a human-readable one" }),
    history: Flags.boolean({
      description: "list this suite's recorded run history instead of running it again (needs the module to return a computer)",
    }),
    limit: Flags.integer({ description: "max history entries to show, with --history", default: 10 }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Eval);
    const modulePath = path.resolve(process.cwd(), args.file);
    const mod = (await import(pathToFileURL(modulePath).href)) as Partial<EvalModule>;

    if (typeof mod.default !== "function") {
      this.error(`${args.file} has no default export — expected an async function returning {runnable, cases, teardown?}`);
    }

    const { runnable, cases, computer, suiteName = path.basename(args.file), teardown } = await mod.default();

    try {
      if (flags.history) {
        await this.printHistory(computer, suiteName, flags.limit, flags.json);
        return;
      }

      if (!flags.json) this.log(`Running ${cases.length} eval case(s) from ${args.file}...`);
      const suite = await runEvalSuite(runnable, cases);

      if (computer) {
        const record = await recordEvalRun(computer, suiteName, suite);
        if (!flags.json) this.log(`(recorded as run ${record.runId} — see \`berth eval ${args.file} --history\`)`);
      }

      if (flags.json) {
        this.log(JSON.stringify(suite, null, 2));
      } else {
        this.printHumanSummary(suite);
      }

      if (suite.failed > 0) this.exit(1);
    } finally {
      await teardown?.();
    }
  }

  private async printHistory(computer: ComputerHandle | undefined, suiteName: string, limit: number, json: boolean): Promise<void> {
    if (!computer) {
      this.error(`--history needs the eval module's default export to return a \`computer\` — this one didn't.`);
    }
    const runs = await listEvalRuns(computer, { suiteName, limit });

    if (json) {
      this.log(JSON.stringify(runs, null, 2));
      return;
    }
    if (runs.length === 0) {
      this.log(`no recorded runs for "${suiteName}" yet`);
      return;
    }
    for (const run of runs) {
      this.log(`${new Date(run.updatedAt).toISOString()}  ${run.runId}`);
    }
  }

  private printHumanSummary(suite: EvalSuiteResult): void {
    for (const result of suite.results) {
      this.log(result.passed ? `✓ ${result.name}` : `✗ ${result.name}`);
      if (!result.passed) {
        if (result.error) this.log(`  run threw: ${result.error}`);
        for (const assertion of result.assertionResults) {
          if (!assertion.pass) this.log(`  ✗ ${assertion.message}`);
        }
      }
    }
    this.log(`\n${suite.passed}/${suite.total} passed`);
  }
}
