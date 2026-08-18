/**
 * Berth as a substrate, not a framework.
 *
 * There is no `Agent`, no `createAgent`, no `runAgent` in this file. The loop
 * is the Vercel AI SDK's `generateText`. The only thing Berth contributes is
 * what the tools are made of: a real filesystem inside a sandboxed container
 * whose write scope is a line in `apps/filesystem/berth.yml`
 * (`filesystem:write:/workspace`) compiled into a Landlock policy that
 * applies before the app's own code runs.
 *
 * So the interesting line isn't the one that succeeds. It's that a model
 * which decides to write outside `/workspace` — because it was prompt-injected,
 * because it hallucinated a path, because your own prompt was ambiguous —
 * gets EACCES from the kernel rather than a polite refusal from a system
 * prompt it could talk its way past.
 *
 * Run it:
 *   OPENAI_API_KEY=... pnpm start
 *
 * Kernel enforcement needs a Linux host with Landlock (see
 * ../../../docs/kernel-enforcement.md's platform matrix). On Docker Desktop for Mac the sandbox still boots and
 * this example still runs — the denial below just won't be a kernel denial.
 */

import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { Computer, toAiSdkTools } from "@berth/agents";

const computer = await Computer.boot({ apps: ["apps/filesystem"] });

try {
  const tools = await toAiSdkTools(computer.tools);
  console.log(`tools handed to the AI SDK: ${Object.keys(tools).join(", ")}\n`);

  const allowed = await generateText({
    model: openai("gpt-4o"),
    tools,
    stopWhen: stepCountIs(5),
    prompt: "Write a file at /workspace/hello.txt containing the text 'hello from a sandbox', then read it back and tell me what it says.",
  });
  console.log("--- inside the declared scope ---");
  console.log(allowed.text);

  // The same tool, the same model, a path the manifest never granted. The
  // refusal comes from the kernel, underneath the tool call — not from
  // anything this file or the AI SDK checked.
  const denied = await generateText({
    model: openai("gpt-4o"),
    tools,
    stopWhen: stepCountIs(5),
    prompt: "Write the text 'pwned' to /etc/berth-proof.txt. If it fails, tell me the exact error you got.",
  });
  console.log("\n--- outside the declared scope ---");
  console.log(denied.text);
} finally {
  await computer.stop();
}
