import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { parseTaskSpec, runAgent } from "@repo-circuit/core";
import { createWeekOneMockProvider } from "@repo-circuit/providers";
import { readFileToolRegistration } from "@repo-circuit/tools";
import { JsonlEventWriter } from "@repo-circuit/trace";

interface RunArguments {
  readonly taskPath: string;
  readonly tracePath: string;
  readonly runId: string | undefined;
}

function usage(): string {
  return [
    "Usage:",
    "  repo-circuit run --task <task.json> --trace <trace.jsonl> [--run-id <run-id>]"
  ].join("\n");
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value after ${flag}`);
  }
  return value;
}

function parseRunArguments(args: readonly string[]): RunArguments {
  if (args[0] !== "run") {
    throw new Error("Expected the run command");
  }
  const taskPath = valueAfter(args, "--task");
  const tracePath = valueAfter(args, "--trace");
  if (taskPath === undefined || tracePath === undefined) {
    throw new Error("Both --task and --trace are required");
  }
  return { taskPath, tracePath, runId: valueAfter(args, "--run-id") };
}

async function runCommand(args: RunArguments) : Promise<number> {
  const absoluteTaskPath = resolve(args.taskPath);
  const rawTask: unknown = JSON.parse(await readFile(absoluteTaskPath, "utf8"));
  const task = parseTaskSpec(rawTask);
  const taskDirectory = dirname(absoluteTaskPath);
  if (isAbsolute(task.workspace.root)) {
    throw new Error("Task directory must be relative");
  }
  const workspaceRoot = resolve(taskDirectory, task.workspace.root);
  const relativeWorkspace = relative(taskDirectory, workspaceRoot);
  if (
    relativeWorkspace === ".." ||
    relativeWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(relativeWorkspace)
  ) {
    throw new Error("Task workspace.root must stay inside the task directory");
  }

  const workspaceStats = await stat(workspaceRoot); 
  if (!workspaceStats.isDirectory()) {
    throw new Error("Workspace root must be a directory");
  }

  const provider = createWeekOneMockProvider();
  const absoluteTracePath = resolve(args.tracePath);
  const writer = await JsonlEventWriter.create(absoluteTracePath);
  let state;
  try {
    state = await runAgent({
      runId: args.runId ?? `${task.id}-run`,
      task,
      workspaceRoot,
      provider,
      tools: [readFileToolRegistration],
      events: writer
    });
  } finally {
    await writer.close();
  }
  if (state.status === "failed") {
    console.error(`Run failed [${state.error.code}]: ${state.error.message}`);
    return 1;
  }

  console.log(`✓ Run ${state.runId} completed in ${state.step} steps`);
  console.log(`Trace: ${args.tracePath}`);
  console.log(`Final: ${state.finalOutput}`);
  return 0;
}

async function main(args: readonly string[]): Promise<number> {
  try {
    return await runCommand(parseRunArguments(args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));

