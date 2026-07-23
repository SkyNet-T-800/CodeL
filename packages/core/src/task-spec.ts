import type { TaskSpec } from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function fail(field: string, expectation: string): never {
  throw new Error(`Invalid TaskSpec: ${field} must be ${expectation}`);
}

export function parseTaskSpec(value: unknown): TaskSpec {
  if (!isRecord(value)) {
    return fail("root", "an object");
  }

  const { schemaVersion, id, title, instruction, workspace, constraints, budget } = value;

  if (schemaVersion !== 1) {
    return fail("schemaVersion", "1");
  }
  if (!isNonEmptyString(id) || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return fail("id", "a non-empty lowercase kebab-case string");
  }
  if (!isNonEmptyString(title)) {
    return fail("title", "a non-empty string");
  }
  if (!isNonEmptyString(instruction)) {
    return fail("instruction", "a non-empty string");
  }
  if (!isRecord(workspace) || !isNonEmptyString(workspace.root)) {
    return fail("workspace.root", "a non-empty string");
  }
  if (!isRecord(constraints) || !isStringArray(constraints.allowedTools)) {
    return fail("constraints.allowedTools", "an array of non-empty strings");
  }
  if (
    !isRecord(budget) ||
    typeof budget.maxSteps !== "number" ||
    !Number.isInteger(budget.maxSteps) ||
    budget.maxSteps < 1 ||
    budget.maxSteps > 100
  ) {
    return fail("budget.maxSteps", "an integer between 1 and 100");
  }

  return {
    schemaVersion,
    id,
    title,
    instruction,
    workspace: { root: workspace.root },
    constraints: { allowedTools: constraints.allowedTools },
    budget: { maxSteps: budget.maxSteps }
  };
}

