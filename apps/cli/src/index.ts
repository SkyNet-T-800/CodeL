import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  realpath,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  parseTaskSpec,
  runAgent,
  type JsonObject,
  type ModelAdapter,
  type ModelResponse,
  type RunOutcome,
  type TaskSpec,
  type TestResult,
  type VerificationResult,
} from "@repo-circuit/core";
import {
  CommandVerifier,
  evaluateBaselineEligibility,
  validateComparison,
  validateRunDirectory,
  type RunDirectoryValidationResult
} from "@repo-circuit/harness";
import {
  OpenAICompatibleProvider,
  ScriptedMockProvider
} from "@repo-circuit/providers";

import {
  createWeekTwoToolRegistrations
} from "@repo-circuit/tools";

import {
  RunRecorder,
  sha256Text
} from "@repo-circuit/trace";

import {
  createRunConfiguration,
  type ModelRunSettings
} from "./run-config.js"
import { W3_SYSTEM_PROMPT } from "./system-prompt.js";

const execFileAsync = promisify(execFile);
const implementationRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

interface RunArguments {
  readonly taskPath: string;
  readonly runsDir: string;
  readonly runId: string | undefined;
  readonly provider: "scripted" | "openai" | "deepseek";
  readonly scriptPath: string | undefined;
  readonly workspacePath: string | undefined;
  readonly comparisonId: string | null;
  readonly attemptIndex: number;
  readonly maxSteps: number | undefined;
}

function usage(): string {
  return [
    "Usage:",
    "  repo-circuit run --task <task.json> [--provider scripted|openai|deepseek]",
    "    [--runs-dir <runs>] [--run-id <id>] [--workspace <copied-workspace>]",
    "    [--script <script.json>] [--comparison-id <id>] [--attempt-index <n>]",
    "    [--max-steps <positive-integer>]",
    "  repo-circuit compare --a <run-meta.json> --b <run-meta.json>",
    "    [--output <manifest.json>] [--meta-only]",
    "  repo-circuit baseline-check --meta <run-meta.json>",
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

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseRunArguments(args: readonly string[]): RunArguments {
  const provider = valueAfter(args, "--provider") ?? "scripted";
  const maxSteps = valueAfter(args, "--max-steps");
  if (
    provider !== "scripted" &&
    provider !== "openai" &&
    provider !== "deepseek"
  ) {
    throw new Error(`--provider must be scripted, openai, or deepseek`);
  }
  return {
    taskPath: requiredValue(args, "--task"),
    runsDir: valueAfter(args, "--runs-dir") ?? "runs",
    runId: valueAfter(args, "--run-id"),
    provider,
    scriptPath: valueAfter(args, "--script"),
    workspacePath: valueAfter(args, "--workspace"),
    comparisonId: valueAfter(args, "--comparison-id") ?? null,
    attemptIndex: nonNegativeInteger(
      valueAfter(args, "--attempt-index") ?? "0",
      "--attempt-index"
    ),
    maxSteps:
      maxSteps === undefined
        ? undefined
        : positiveInteger(maxSteps, "--max-steps")
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
): Promise<{
  readonly provider: ModelAdapter;
  readonly modelSettings: ModelRunSettings;
}> {
  if (args.provider === "scripted") {
    const scriptPath = resolve(
      args.scriptPath ?? resolve(taskDirectory, "script.json")
    );
    const raw: unknown = JSON.parse(await readFile(scriptPath, "utf-8"));
    return {
      provider: new ScriptedMockProvider(parseScript(raw)),
      modelSettings: {
        reasoningEffort: "unsupported",
        temperature: "unsupported",
        topP: "unsupported",
        seed: "unsupported"
      }
    }
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

  return {
    provider: new OpenAICompatibleProvider({
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
    }),
    modelSettings: {
      reasoningEffort:
        thinkingType === "disabled"
          ? "disabled"
          : (reasoningEffort ?? (isDeepSeek ? "unknown" : "unsupported")),
      temperature: isDeepSeek
        ? thinkingType === "enabled"
          ? "unsupported"
          : (temperature ?? 1)
        : (temperature ?? 0),
      topP: isDeepSeek
        ? thinkingType === "enabled"
          ? "unsupported"
          : 1
        : "unsupported",
      seed: "unsupported"
    }
  }
}

interface WorkspaceIdentity {
  readonly baseSha: string;
  readonly repositoryRoot: string;
}

async function inspectCleanWorkspace(
  workspaceRoot: string,
  declaredBaseSha: string | undefined
): Promise<WorkspaceIdentity> {
  const physicalWorkspace = await realpath(workspaceRoot);
  const [{ stdout: topLevelOutput }, { stdout: baseShaOutput }] =
    await Promise.all(
      [
        execFileAsync("git", ["rev-parse", "--show-toplevel"], {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1024
        }),
        execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1024
        })
      ]
    );
  const repositoryRoot = await realpath(topLevelOutput.trim());
  if (physicalWorkspace !== repositoryRoot) {
    throw new Error(
      "Run workspace must be the Git repository root so Patch scope is unambiguous"
    )
  }  

  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
  if (status.trim().length > 0) {
    throw new Error(
      "Run workspace must be clean before configuration is frozen"
    );
  }

  const baseSha = baseShaOutput.trim();

  if (baseSha.length === 0) {
    throw new Error("Run workspace HEAD is empty");
  }
  if (declaredBaseSha !== undefined && declaredBaseSha !== baseSha) {
    throw new Error(
      `Task attribution.baseSha does not match workspace HEAD: expected ${declaredBaseSha}, received ${baseSha}`
    );
  }
  return { baseSha, repositoryRoot };
}

async function capturePatch(workspaceRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "HEAD",
      "--"
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
  return stdout;
}

function notRunVerification(): VerificationResult {
  return {
    passed: false,
    summary: "Verifier was not run",
    testResult: {
      status: "not_run",
      exitCode: null,
      summary: "Verifier was not run",
      durationMs: 0
    }
  };
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
  const workspaceIdentity = await inspectCleanWorkspace(
    workspaceRoot,
    loaded.task.attribution?.baseSha
  );

  const { provider, modelSettings } = await createProvider(
    args,
    loaded.taskDirectory
  );
  const verifierPath = resolve(loaded.taskDirectory, "verifier.mjs");
  const verifierScriptHash = sha256Text(
    await readFile(verifierPath, "utf8")
  );

  const verifierVersion =
    `w3-command-verifier-v1+sha256:${verifierScriptHash}`;
  const verifier = new CommandVerifier({
    scriptPath: verifierPath,
    version: verifierVersion,
    scriptSha256: verifierScriptHash,
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024
  });
  const tools = createWeekTwoToolRegistrations([
    {
      id: "verify",
      description: "Run the deterministic public smoke tests",
      command: process.execPath,
      args: [verifierPath],
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024
    }
  ]);
  const startedAt = new Date().toISOString();
  const runId = args.runId ?? `${loaded.task.id}-${randomUUID()}`;
  const configuration = await createRunConfiguration({
    runId,
    comparisonId: args.comparisonId,
    attemptIndex: args.attemptIndex,
    startedAt,
    task: loaded.task,
    provider,
    tools,
    systemPrompt: W3_SYSTEM_PROMPT,
    verifierVersion: verifier.version,
    modelSettings,
    ...(args.maxSteps === undefined
      ? {}
      : { budget: { maxSteps: args.maxSteps } }),
    repositoryRoot: implementationRoot,
    baseSha: workspaceIdentity.baseSha
  });
  const recorder = await RunRecorder.begin(resolve(args.runsDir), configuration);

  const start = performance.now();
  const state = await runAgent({
    runId,
    task: loaded.task,
    workspaceRoot,
    provider,
    tools,
    events: recorder,
    verifier,
    systemPrompt: W3_SYSTEM_PROMPT,
    budget: configuration.budget
  });
  const predictionPatch = await capturePatch(workspaceRoot);
  const verification = state.verification ?? notRunVerification();
  const outcome: RunOutcome = {
    endedAt: new Date().toISOString(),
    usage: state.usage,
    steps: state.step,
    toolCallCount: state.toolCallCount,
    latencyMs: Math.max(0, Math.round(performance.now() - start)),
    terminalReason: state.terminalReason,
    patchHash: sha256Text(predictionPatch),
    testResult: verification.testResult
  };
  const runMeta = await recorder.finalize({
    outcome,
    predictionPatch,
    verifierResult: verification
  });

  console.log(
    `${state.status === "completed" ? "✓" : "✗"} ${runId}: ${state.terminalReason}`
  );
  console.log(`Run Meta: ${recorder.runMetaPath}`);
  console.log(`Trace: ${resolve(recorder.runDirectory, runMeta.artifacts.tracePath)}`);
  if (state.status === "completed") {
    console.log(`Final: ${state.finalOutput}`);
    return 0;
  }
  console.error(`Run ended with ${state.error.code}: ${state.error.message}`);
  return 1;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

function evidenceError(
  label: string,
  result: RunDirectoryValidationResult
): Error {
  return new Error(
    `${label} evidence bundle is invalid: ${result.issues
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("; ")}`
  );
}

async function readComparisonRun(
  path: string,
  metaOnly: boolean,
  label: string
): Promise<unknown> {
  if (metaOnly) {
    return await readJson(path);
  }
  const absolute = resolve(path);
  if (basename(absolute) !== "run-meta.json") {
    throw new Error(
      `${label} must be a runs/<runId>/run-meta.json path unless --meta-only is used`
    );
  }
  const result = await validateRunDirectory(dirname(absolute));
  if (!result.valid || result.runMeta === undefined) {
    throw evidenceError(label, result);
  }
  return result.runMeta;
}

async function compareCommand(args: readonly string[]): Promise<number> {
  const metaOnly = args.includes("--meta-only");
  const manifest = validateComparison(
    await readComparisonRun(requiredValue(args, "--a"), metaOnly, "Run A"),
    await readComparisonRun(requiredValue(args, "--b"), metaOnly, "Run B")
  );
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const output = valueAfter(args, "--output");
  if (output === undefined) {
    process.stdout.write(serialized);
  } else {
    await writeFile(resolve(output), serialized, {
      encoding: "utf8",
      flag: "wx"
    });
    console.log(`Comparison: ${resolve(output)}`);
  }
  return manifest.status === "valid_for_attribution" ? 0 : 1;
}

async function baselineCommand(args: readonly string[]): Promise<number> {
  const metaPath = resolve(requiredValue(args, "--meta"));
  if (basename(metaPath) !== "run-meta.json") {
    throw new Error("--meta must name a runs/<runId>/run-meta.json file");
  }
  const evidence = await validateRunDirectory(dirname(metaPath));
  if (!evidence.valid || evidence.runMeta === undefined) {
    const result = {
      eligible: false,
      reasons: evidence.issues.map((issue) => ({
        code: "EVIDENCE_BUNDLE_INVALID",
        path: issue.path,
        message: issue.message
      }))
    };
    console.log(JSON.stringify(result, null, 2));
    return 1;
  }
  const result = evaluateBaselineEligibility(evidence.runMeta);
  console.log(JSON.stringify(result, null, 2));
  return result.eligible ? 0 : 1;
}

async function main(args: readonly string[]): Promise<number> {
  try {
    switch (args[0]) {
      case "run":
        return await runCommand(parseRunArguments(args.slice(1)));
      case "compare":
        return await compareCommand(args.slice(1));
      case "baseline-check":
        return await baselineCommand(args.slice(1));
      default:
        throw new Error("Expected run, compare, or baseline-check");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
