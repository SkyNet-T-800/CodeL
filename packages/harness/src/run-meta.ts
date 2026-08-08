import {
  validateJsonSchema,
  type JsonSchemaIssue,
  type JsonValue,
  type RunMeta
} from "@repo-circuit/core";

import { RUN_META_SCHEMA } from "./run-meta-schema.js";

export interface RunMetaValidationResult {
  readonly valid: boolean;
  readonly issues: readonly JsonSchemaIssue[];
}

export class RunMetaValidationError extends Error {
  readonly issues: readonly JsonSchemaIssue[];

  constructor(issues: readonly JsonSchemaIssue[]) {
    super(
      `Invalid RunMeta: ${issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`
    );
    this.name = "RunMetaValidationError";
    this.issues = issues;
  }
}

function semanticIssues(runMeta: RunMeta): readonly JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  const { usage } = runMeta.outcome;

  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    issues.push({
      path: "$.outcome.usage.totalTokens",
      message: "must equal inputTokens + outputTokens"
    });
  }

  if (new Set(runMeta.tools.enabledTools).size !== runMeta.tools.enabledTools.length) {
    issues.push({
      path: "$.tools.enabledTools",
      message: "must not contain duplicate tool names"
    });
  }

  if (runMeta.outcome.patchHash !== runMeta.artifacts.patchSha256) {
    issues.push({
      path: "$.artifacts.patchSha256",
      message: "must equal outcome.patchHash"
    });
  }

  return issues;
}

/**
 * Validates both the JSON shape and cross-field invariants of a Run Meta value.
 */
export function validateRunMeta(value: unknown): RunMetaValidationResult {
  const schemaIssues = validateJsonSchema(
    RUN_META_SCHEMA,
    value as JsonValue
  );
  if (schemaIssues.length > 0) {
    return {
      valid: false,
      issues: schemaIssues
    };
  }

  const issues = semanticIssues(value as RunMeta);
  return {
    valid: issues.length === 0,
    issues
  };
}

export function isRunMeta(value: unknown): value is RunMeta {
  return validateRunMeta(value).valid;
}

export function assertRunMeta(value: unknown): RunMeta {
  const result = validateRunMeta(value);
  if (!result.valid) {
    throw new RunMetaValidationError(result.issues);
  }
  return value as RunMeta;
}

export type BaselineGateReasonCode =
  | "RUN_META_INVALID"
  | "TOKEN_USAGE_INCOMPLETE"
  | "CRITICAL_VALUE_UNKNOWN"
  | "DIRTY_COMMIT";

export interface BaselineGateReason {
  readonly code: BaselineGateReasonCode;
  readonly path: string;
  readonly message: string;
}

export interface BaselineGateResult {
  readonly eligible: boolean;
  readonly reasons: readonly BaselineGateReason[];
}

/**
 * Baseline admission is deliberately stricter than archival admission.
 *
 * Every Run should still be retained, including failures. A Run only enters a
 * comparable Baseline when all critical fields validate and the Provider
 * supplied exact token accounting.
 */
export function evaluateBaselineEligibility(
  value: unknown
): BaselineGateResult {
  const validation = validateRunMeta(value);
  if (!validation.valid) {
    return {
      eligible: false,
      reasons: validation.issues.map((issue) => ({
        code: "RUN_META_INVALID",
        path: issue.path,
        message: issue.message
      }))
    };
  }

  const runMeta = value as RunMeta;
  const reasons: BaselineGateReason[] = [];
  if (!runMeta.outcome.usage.complete) {
    reasons.push({
      code: "TOKEN_USAGE_INCOMPLETE",
      path: "$.outcome.usage.complete",
      message: "exact token usage is required for Baseline admission"
    });
  }

  const criticalValues = [
    ["$.identity.baseSha", runMeta.identity.baseSha],
    ["$.identity.fixtureVersion", runMeta.identity.fixtureVersion],
    ["$.identity.agentCommit", runMeta.identity.agentCommit],
    ["$.identity.harnessCommit", runMeta.identity.harnessCommit],
    ["$.model.provider", runMeta.model.provider],
    ["$.model.modelId", runMeta.model.modelId],
    ["$.model.modelRevision", runMeta.model.modelRevision],
    ["$.model.reasoningEffort", runMeta.model.reasoningEffort],
    ["$.model.temperature", runMeta.model.temperature],
    ["$.model.topP", runMeta.model.topP],
    ["$.model.seed", runMeta.model.seed],
    ["$.context.contextStrategy", runMeta.context.contextStrategy],
    ["$.evaluation.verifierVersion", runMeta.evaluation.verifierVersion],
    ["$.evaluation.evaluatorCommit", runMeta.evaluation.evaluatorCommit],
    ["$.evaluation.scorer", runMeta.evaluation.scorer]
  ] as const;
  for (const [path, fieldValue] of criticalValues) {
    if (fieldValue === "unknown") {
      reasons.push({
        code: "CRITICAL_VALUE_UNKNOWN",
        path,
        message: "critical control variables must be known for Baseline admission"
      });
    }
  }

  for (const [path, commit] of [
    ["$.identity.agentCommit", runMeta.identity.agentCommit],
    ["$.identity.harnessCommit", runMeta.identity.harnessCommit],
    ["$.evaluation.evaluatorCommit", runMeta.evaluation.evaluatorCommit]
  ] as const) {
    if (commit.endsWith("+dirty")) {
      reasons.push({
        code: "DIRTY_COMMIT",
        path,
        message: "dirty implementations are retained but cannot enter Baseline"
      });
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

export const gateRunForBaseline = evaluateBaselineEligibility;
