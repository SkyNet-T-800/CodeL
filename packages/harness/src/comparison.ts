import type { RunMeta } from "@repo-circuit/core";

import {
  assertRunMeta,
  evaluateBaselineEligibility
} from "./run-meta.js";

export type ComparisonStatus =
  | "valid_for_attribution"
  | "invalid_for_attribution";

export interface ComparisonManifest {
  readonly schemaVersion: 1;
  readonly comparisonId: string;
  readonly runAId: string;
  readonly runBId: string;
  readonly changedVariables: readonly string[];
  readonly status: ComparisonStatus;
  readonly reasons: readonly string[];
}

const IGNORED_PATHS = new Set([
  "runId",
  "identity.startedAt",
  "outcome",
  "artifacts"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(left, key) &&
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameJsonValue(left[key], right[key])
    );
  }
  return false;
}

function collectChangedVariables(
  left: unknown,
  right: unknown,
  path: string,
  target: string[]
): void {
  if (IGNORED_PATHS.has(path) || sameJsonValue(left, right)) {
    return;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    target.push(path);
    return;
  }

  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      collectChangedVariables(left[key], right[key], childPath, target);
    }
    return;
  }

  target.push(path);
}

function baselineReasons(
  side: "run_a" | "run_b",
  runMeta: RunMeta
): readonly string[] {
  const gate = evaluateBaselineEligibility(runMeta);
  return gate.reasons.map(
    (reason) => `${side}_not_baseline_eligible: ${reason.path} ${reason.message}`
  );
}

/**
 * Builds the manifest from the two immutable Run Meta records.
 *
 * Callers cannot hand-author `changedVariables`; the Harness derives it from
 * the frozen configuration. Execution identity/time and all outcome/artifact
 * evidence are intentionally excluded from the comparison.
 */
export function validateComparison(
  runAValue: unknown,
  runBValue: unknown
): ComparisonManifest {
  const runA = assertRunMeta(runAValue);
  const runB = assertRunMeta(runBValue);
  const changedVariables: string[] = [];
  collectChangedVariables(runA, runB, "", changedVariables);

  const reasons = [
    ...baselineReasons("run_a", runA),
    ...baselineReasons("run_b", runB)
  ];

  if (runA.runId === runB.runId) {
    reasons.push("run_ids_must_be_distinct");
  }

  if (
    runA.comparisonId === null ||
    runB.comparisonId === null ||
    runA.comparisonId !== runB.comparisonId
  ) {
    reasons.push("comparison_id_must_be_the_same_non_null_value");
  }

  if (changedVariables.length !== 1) {
    reasons.push(
      `changed_variables_must_contain_exactly_one_item: received_${changedVariables.length}`
    );
  }

  const comparisonId =
    runA.comparisonId ?? runB.comparisonId ?? "unscoped-comparison";

  return {
    schemaVersion: 1,
    comparisonId,
    runAId: runA.runId,
    runBId: runB.runId,
    changedVariables,
    status:
      reasons.length === 0
        ? "valid_for_attribution"
        : "invalid_for_attribution",
    reasons
  };
}
