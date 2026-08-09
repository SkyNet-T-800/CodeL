import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  resolveRunBudget,
  type FrozenRunConfiguration,
  type ModelAdapter,
  type RegisteredTool,
  type RunBudget,
  type TaskSpec
} from "@repo-circuit/core";

const execFileAsync = promisify(execFile);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

async function currentCommit(cwd: string): Promise<string> {
  try {
    const [{ stdout: revision }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024
      }),
      execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        {
          cwd,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 2 * 1024 * 1024
        }
      )
    ]);
    const commit = revision.trim();
    if (commit.length === 0) {
      return "unknown";
    }
    return status.trim().length === 0 ? commit : `${commit}+dirty`;
  } catch {
    return "unknown";
  }
}

export interface ModelRunSettings {
  readonly reasoningEffort: string;
  readonly temperature: number | "unknown" | "unsupported";
  readonly topP: number | "unknown" | "unsupported";
  readonly seed: number | "unknown" | "unsupported";
}

export interface CreateRunConfigurationInput {
  readonly runId: string;
  readonly comparisonId: string | null;
  readonly attemptIndex: number;
  readonly startedAt: string;
  readonly task: TaskSpec;
  readonly provider: ModelAdapter;
  readonly tools: readonly RegisteredTool[];
  readonly systemPrompt: string;
  readonly verifierVersion: string;
  readonly modelSettings: ModelRunSettings;
  readonly budget?: Partial<RunBudget>;
  readonly repositoryRoot: string;
  readonly baseSha: string;
}

export async function createRunConfiguration(
  input: CreateRunConfigurationInput
): Promise<FrozenRunConfiguration> {
  const commit = await currentCommit(input.repositoryRoot);
  const enabledTools = input.tools
    .map((tool) => tool.definition.name)
    .filter((name) => input.task.constraints.allowedTools.includes(name))
    .sort();
  const toolDefinitions = input.tools
    .filter((tool) => enabledTools.includes(tool.definition.name))
    .map((tool) => tool.definition)
    .sort((left, right) => left.name.localeCompare(right.name));
  const descriptor = input.provider.descriptor;

  const configuration: FrozenRunConfiguration = {
    schemaVersion: 1,
    runId: input.runId,
    comparisonId: input.comparisonId,
    attemptIndex: input.attemptIndex,
    identity: {
      taskId: input.task.id,
      baseSha: input.baseSha,
      fixtureVersion:
        input.task.attribution?.fixtureVersion ?? "unknown",
      startedAt: input.startedAt,
      agentCommit: commit,
      harnessCommit: commit
    },
    model: {
      provider: descriptor?.provider ?? input.provider.name,
      modelId: descriptor?.modelId ?? input.provider.name,
      modelRevision: descriptor?.modelRevision ?? "unknown",
      reasoningEffort: input.modelSettings.reasoningEffort,
      temperature: input.modelSettings.temperature,
      topP: input.modelSettings.topP,
      seed: input.modelSettings.seed
    },
    prompt: {
      systemPromptHash: createHash("sha256")
        .update(input.systemPrompt)
        .digest("hex")
    },
    tools: {
      toolSchemaHash: sha256Json(toolDefinitions),
      enabledTools,
      toolPolicyHash: sha256Json({
        allowedTools: [...input.task.constraints.allowedTools].sort()
      })
    },
    context: {
      contextStrategy: "full-transcript-v1",
      maxContextTokens: "unsupported"
    },
    budget: resolveRunBudget(input.task, input.budget),
    evaluation: {
      verifierVersion: input.verifierVersion,
      evaluatorCommit: commit,
      scorer: "deterministic-command-v1"
    }
  };

  return deepFreeze(configuration);
}
