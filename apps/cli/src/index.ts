import { randomUUID } from "node:crypto";
import {
  readFile,
  stat
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

import {
  parseTaskSpec,
  runAgent,
  type JsonObject,
  type ModelAdapter,
  type ModelResponse,
  type TaskSpec
} from "@repo-circuit/core";
import {
  OpenAICompatibleProvider,
  ScriptedMockProvider
} from "@repo-circuit/providers";
import {
  forkSession,
  inspectSession,
  listSessions,
  SessionEventSink,
  SessionStore
} from "@repo-circuit/session";

import { weekTwoToolRegistrations } from "@repo-circuit/tools";

import { W3_SYSTEM_PROMPT } from "./system-prompt.js";

interface RunArguments {
  readonly taskPath: string;
  readonly runId: string | undefined;
  readonly provider: "scripted" | "openai" | "deepseek";
  readonly scriptPath: string | undefined;
  readonly workspacePath: string | undefined;
  readonly maxSteps: number | undefined;
  readonly sessionsDir: string;
  readonly sessionId: string | undefined;
  readonly resumeSessionId: string | undefined;
  readonly atStep: number | undefined;
}

function usage(): string {
  return [
    "Usage:",
    "  codel run --task <task.json> [--provider scripted|openai|deepseek]",
    "    [--run-id <id>] [--workspace <copied-workspace>]",
    "    [--script <script.json>]",
    "    [--max-steps <positive-integer>]",
    "    [--sessions-dir <sessions>] [--session-id <id>]",
    "    [--resume-session <id> [--at-step <completed-step>]]",
    "  codel session list [--sessions-dir <sessions>]",
    "  codel session show|resume --session-id <id> [--sessions-dir <sessions>]",
    "  codel session rewind --session-id <id> --at-step <n>",
    "  codel session fork --session-id <id> [--at-step <n>]",
    "    [--child-session-id <id>] [--sessions-dir <sessions>]",
    "",
    "Real Provider environment:",
    "  openai: REPO_CIRCUIT_API_KEY, REPO_CIRCUIT_BASE_URL, REPO_CIRCUIT_MODEL",
    "  deepseek: DEEPSEEK_API_KEY (or REPO_CIRCUIT_API_KEY fallback)",
    "            defaults: https://api.deepseek.com, deepseek-v4-flash",
    "            optional: DEEPSEEK_BASE_URL, DEEPSEEK_MODEL,",
    "                      DEEPSEEK_PROVIDER_NAME, DEEPSEEK_MODEL_REVISION",
    "  openai optional: REPO_CIRCUIT_PROVIDER_NAME, REPO_CIRCUIT_MODEL_REVISION",
    "  shared optional:",
    "            REPO_CIRCUIT_REASONING_EFFORT (low|high|max),",
    "            REPO_CIRCUIT_THINKING (enabled|disabled),",
    "            REPO_CIRCUIT_TEMPERATURE (openai default 0; only available",
    "            when DeepSeek thinking is disabled)"
  ].join("\n");
}

function valueAfter(
  args: readonly string[],
  flag: string
): string | undefined {
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

function requiredValue(args: readonly string[], flag: string): string {
  const value = valueAfter(args, flag);
  if (value === undefined) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function optionalStep(args: readonly string[]): number | undefined {
  const raw = valueAfter(args, "--at-step");
  return raw === undefined
    ? undefined
    : nonNegativeInteger(raw, "--at-step");
}

function parseRunArguments(args: readonly string[]): RunArguments {
  const provider = valueAfter(args, "--provider") ?? "scripted";
  const maxSteps = valueAfter(args, "--max-steps");
  const sessionId = valueAfter(args, "--session-id");
  const resumeSessionId = valueAfter(args, "--resume-session");
  const atStep = optionalStep(args);
  if (
    provider !== "scripted" &&
    provider !== "openai" &&
    provider !== "deepseek"
  ) {
    throw new Error(`--provider must be scripted, openai, or deepseek`);
  }
  if (sessionId !== undefined && resumeSessionId !== undefined) {
    throw new Error("--session-id and --resume-session are mutually exclusive");
  }
  if (atStep !== undefined && resumeSessionId === undefined) {
    throw new Error("--at-step requires --resume-session");
  }
  return {
    taskPath: requiredValue(args, "--task"),
    runId: valueAfter(args, "--run-id"),
    provider,
    scriptPath: valueAfter(args, "--script"),
    workspacePath: valueAfter(args, "--workspace"),
    maxSteps:
      maxSteps === undefined
        ? undefined
        : positiveInteger(maxSteps, "--max-steps"),
    sessionsDir: valueAfter(args, "--sessions-dir") ?? "sessions",
    sessionId,
    resumeSessionId,
    atStep
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(value: unknown, field: string): JsonObject {
  if (!isRecord(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value as JsonObject;
}

function parseUsage(value: unknown, field: string) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.inputTokens) ||
    !Number.isSafeInteger(value.outputTokens) ||
    !Number.isSafeInteger(value.totalTokens) ||
    typeof value.complete !== "boolean"
  ) {
    throw new Error(`${field} must contain integer token counts and complete`);
  }
  const inputTokens = value.inputTokens as number;
  const outputTokens = value.outputTokens as number;
  const totalTokens = value.totalTokens as number;
  if (
    inputTokens < 0 ||
    outputTokens < 0 ||
    totalTokens !== inputTokens + outputTokens
  ) {
    throw new Error(`${field} token counts are inconsistent`);
  }
  return { inputTokens, outputTokens, totalTokens, complete: value.complete };
}

function parseScript(value: unknown): readonly ModelResponse[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Provider script must be a non-empty array");
  }
  return value.map((item, responseIndex): ModelResponse => {
    if (!isRecord(item)) {
      throw new Error(`script[${responseIndex}] must be an object`);
    }
    const responseUsage =
      item.usage === undefined
        ? undefined
        : parseUsage(item.usage, `script[${responseIndex}].usage`);
    if (item.kind === "end_turn" && typeof item.text === "string") {
      return {
        kind: "end_turn",
        text: item.text,
        ...(responseUsage === undefined ? {} : { usage: responseUsage })
      };
    }
    if (item.kind === "tool_use" && Array.isArray(item.calls)) {
      const calls = item.calls.map((call, callIndex) => {
        if (
          !isRecord(call) ||
          typeof call.id !== "string" ||
          typeof call.name !== "string"
        ) {
          throw new Error(
            `script[${responseIndex}].calls[${callIndex}] is invalid`
          );
        }
        return {
          id: call.id,
          name: call.name,
          input: parseJsonObject(
            call.input,
            `script[${responseIndex}].calls[${callIndex}].input`
          )
        };
      });
      return {
        kind: "tool_use",
        calls,
        ...(responseUsage === undefined ? {} : { usage: responseUsage })
      };
    }
    throw new Error(`script[${responseIndex}] has an invalid kind`);
  });
}

async function resolveWorkspace(
  task: TaskSpec,
  taskDirectory: string,
  override: string | undefined
): Promise<string> {
  if (override !== undefined) {
    const workspace = resolve(override);
    if (!(await stat(workspace)).isDirectory()) {
      throw new Error("--workspace must name a directory");
    }
    return workspace;
  }

  if (isAbsolute(task.workspace.root)) {
    throw new Error("Task workspace.root must be relative");
  }
  const workspace = resolve(taskDirectory, task.workspace.root);
  const fromTask = relative(taskDirectory, workspace);
  if (
    fromTask === ".." ||
    fromTask.startsWith(`..${sep}`) ||
    isAbsolute(fromTask)
  ) {
    throw new Error("Task workspace.root must stay inside the task directory");
  }
  if (!(await stat(workspace)).isDirectory()) {
    throw new Error("Task workspace root must be a directory");
  }
  return workspace;
}

function requiredEnvironment(
  name: string,
  provider: "openai" | "deepseek"
): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for --provider ${provider}`);
  }
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(`${name} must be non-empty when provided`);
  }
  return value;
}

function parseTemperature(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error("REPO_CIRCUIT_TEMPERATURE must be between 0 and 2");
  }
  return value;
}

type ReasoningEffort = "low" | "high" | "max";
type ThinkingType = "enabled" | "disabled";

function parseChoice<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback?: T
): T | undefined {
  const raw = optionalEnvironment(name);
  if (raw === undefined) {
    return fallback;
  }
  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

function deepSeekApiKey(): string {
  const providerKey = optionalEnvironment("DEEPSEEK_API_KEY");
  if (providerKey !== undefined) {
    return providerKey;
  }
  const fallbackKey = process.env.REPO_CIRCUIT_API_KEY;
  if (fallbackKey === undefined || fallbackKey.trim().length === 0) {
    throw new Error(
      "DEEPSEEK_API_KEY or REPO_CIRCUIT_API_KEY is required for --provider deepseek"
    );
  }
  return fallbackKey;
}

async function createProvider(
  args: RunArguments,
  taskDirectory: string
): Promise<ModelAdapter> {
  if (args.provider === "scripted") {
    const scriptPath = resolve(
      args.scriptPath ?? resolve(taskDirectory, "script.json")
    );
    const raw: unknown = JSON.parse(await readFile(scriptPath, "utf-8"));
    return new ScriptedMockProvider(parseScript(raw));
  }

  const realProvider = args.provider;
  const isDeepSeek = realProvider === "deepseek";
  const modelRevision = optionalEnvironment(
    isDeepSeek ? "DEEPSEEK_MODEL_REVISION" : "REPO_CIRCUIT_MODEL_REVISION"
  );
  const thinkingType = parseChoice<ThinkingType>(
    "REPO_CIRCUIT_THINKING",
    ["enabled", "disabled"],
    isDeepSeek ? "enabled" : undefined
  );
  const configuredReasoningEffort = parseChoice<ReasoningEffort>(
    "REPO_CIRCUIT_REASONING_EFFORT",
    ["low", "high", "max"]
  );
  if (
    thinkingType === "disabled" &&
    configuredReasoningEffort !== undefined
  ) {
    throw new Error(
      "REPO_CIRCUIT_REASONING_EFFORT cannot be set when REPO_CIRCUIT_THINKING=disabled"
    );
  }
  const reasoningEffort =
    configuredReasoningEffort ??
    (isDeepSeek && thinkingType === "enabled" ? "high" : undefined);
  const rawTemperature = optionalEnvironment("REPO_CIRCUIT_TEMPERATURE");
  if (
    isDeepSeek &&
    thinkingType === "enabled" &&
    rawTemperature !== undefined
  ) {
    throw new Error(
      "REPO_CIRCUIT_TEMPERATURE cannot be set when DeepSeek thinking is enabled"
    );
  }
  const temperature = parseTemperature(
    rawTemperature ?? (isDeepSeek ? undefined : "0")
  );
  const apiKey = isDeepSeek
    ? deepSeekApiKey()
    : requiredEnvironment("REPO_CIRCUIT_API_KEY", "openai");
  const baseUrl = isDeepSeek
    ? optionalEnvironment("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com"
    : optionalEnvironment("REPO_CIRCUIT_BASE_URL");
  const model = isDeepSeek
    ? optionalEnvironment("DEEPSEEK_MODEL") ?? "deepseek-v4-flash"
    : optionalEnvironment("REPO_CIRCUIT_MODEL");

  if (baseUrl === undefined) {
    throw new Error("REPO_CIRCUIT_BASE_URL is required for --provider openai");
  }
  if (model === undefined) {
    throw new Error("REPO_CIRCUIT_MODEL is required for --provider openai");
  }

  return new OpenAICompatibleProvider({
      apiKey,
      baseUrl,
      model,
      ...(modelRevision === undefined ? {} : { modelRevision }),
      providerName:
        optionalEnvironment(
          isDeepSeek
            ? "DEEPSEEK_PROVIDER_NAME"
            : "REPO_CIRCUIT_PROVIDER_NAME"
        ) ??
        (isDeepSeek ? "deepseek" : "openai-compatible"),
      ...(temperature === undefined ? {} : { temperature }),
      ...(isDeepSeek ? {} : { topP: 1 }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(thinkingType === undefined ? {} : { thinkingType })
    });
}

async function loadTask(taskPath: string): Promise<{
  readonly task: TaskSpec;
  readonly taskPath: string;
  readonly taskDirectory: string;
}> {
  const absoluteTaskPath = resolve(taskPath);
  const rawTask: unknown = JSON.parse(
    await readFile(absoluteTaskPath, "utf8")
  );
  return {
    task: parseTaskSpec(rawTask),
    taskPath: absoluteTaskPath,
    taskDirectory: dirname(absoluteTaskPath)
  }
}

async function runCommand(args: RunArguments): Promise<number> {
  const loaded = await loadTask(args.taskPath);
  const workspaceRoot = await resolveWorkspace(
    loaded.task,
    loaded.taskDirectory,
    args.workspacePath
  );
  const provider = await createProvider(
    args,
    loaded.taskDirectory
  );
  const tools = weekTwoToolRegistrations;
  const runId = args.runId ?? `${loaded.task.id}-${randomUUID()}`;
  const sessionsRoot = resolve(args.sessionsDir);
  const session = args.resumeSessionId === undefined
    ? await SessionStore.create({
        sessionsRoot,
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        workspaceRoot,
        task: loaded.task
      })
    : await SessionStore.openForResume({
        sessionsRoot,
        sessionId: args.resumeSessionId,
        workspaceRoot,
        task: loaded.task,
        ...(args.atStep === undefined ? {} : { atStep: args.atStep })
      });

  let state;
  try {
    state = await runAgent({
      runId,
      task: loaded.task,
      workspaceRoot,
      provider,
      tools,
      events: new SessionEventSink(session),
      systemPrompt: W3_SYSTEM_PROMPT,
      ...(session.preparation === undefined
        ? {}
        : { resumeState: session.preparation.state }),
      ...(args.maxSteps === undefined
        ? {}
        : { budget: { maxSteps: args.maxSteps } })
    });
  } finally {
    await session.dispose();
  }

  console.log(
    `${state.status === "completed" ? "✓" : "✗"} ${runId}: ${state.terminalReason}`
  );
  console.log(`Session: ${session.sessionId}`);
  console.log(`Transcript: ${session.path}`);
  if (state.status === "completed") {
    console.log(`Final: ${state.finalOutput}`);
    return 0;
  }
  console.error(`Run ended with ${state.error.code}: ${state.error.message}`);
  return 1;
}

function sessionsRootFrom(args: readonly string[]): string {
  return resolve(valueAfter(args, "--sessions-dir") ?? "sessions");
}

function sessionIdFrom(args: readonly string[]): string {
  return requiredValue(args, "--session-id");
}

async function sessionCommand(args: readonly string[]): Promise<number> {
  const operation = args[0];
  const rest = args.slice(1);
  const sessionsRoot = sessionsRootFrom(rest);
  switch (operation) {
    case "list":
      console.log(JSON.stringify(await listSessions(sessionsRoot), null, 2));
      return 0;
    case "show": {
      const inspection = await inspectSession(sessionsRoot, sessionIdFrom(rest));
      console.log(JSON.stringify(inspection, null, 2));
      return 0;
    }
    case "resume": {
      const preparation = await SessionStore.prepareResume(
        sessionsRoot,
        sessionIdFrom(rest)
      );
      console.log(JSON.stringify(preparation, null, 2));
      return preparation.status === "ready" ? 0 : 1;
    }
    case "rewind": {
      const atStep = optionalStep(rest);
      if (atStep === undefined) throw new Error("--at-step is required");
      const preparation = await SessionStore.prepareResume(
        sessionsRoot,
        sessionIdFrom(rest),
        atStep
      );
      console.log(JSON.stringify(preparation, null, 2));
      return 0;
    }
    case "fork": {
      const childSessionId = valueAfter(rest, "--child-session-id");
      const atStep = optionalStep(rest);
      const child = await forkSession({
        sessionsRoot,
        sourceSessionId: sessionIdFrom(rest),
        ...(childSessionId === undefined ? {} : { childSessionId }),
        ...(atStep === undefined ? {} : { atStep })
      });
      try {
        console.log(JSON.stringify({
          sessionId: child.sessionId,
          path: child.path,
          head: child.preparation?.head ?? null
        }, null, 2));
      } finally {
        await child.dispose();
      }
      return 0;
    }
    default:
      throw new Error("Expected session list, show, resume, rewind, or fork");
  }
}

async function main(args: readonly string[]): Promise<number> {
  try {
    switch (args[0]) {
      case "run":
        return await runCommand(parseRunArguments(args.slice(1)));
      case "session":
        return await sessionCommand(args.slice(1));
      default:
        throw new Error("Expected run or session");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
