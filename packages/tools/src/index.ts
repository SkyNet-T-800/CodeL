import type { RegisteredTool } from "@repo-circuit/core";

import { applyPatchToolRegistration } from "./apply-patch.js";
import { diffToolRegistration } from "./diff.js";
import {
  createExecToolRegistration,
  type ExecProfile,
  type ExecToolOptions
} from "./exec.js";
import { grepToolRegistration } from "./grep.js";
import {
  readFileToolRegistration,
  readToolRegistration
} from "./read.js";
import { symbolsToolRegistration } from "./symbols.js";
import { treeToolRegistration } from "./tree.js";

export * from "./apply-patch.js";
export * from "./diff.js";
export * from "./exec.js";
export * from "./grep.js";
export * from "./hash.js";
export * from "./limits.js";
export * from "./path-safety.js";
export * from "./process-runner.js";
export * from "./read.js";
export * from "./ripgrep.js";
export * from "./symbols.js";
export * from "./text-file.js";
export * from "./tree.js";
export * from "./unified-diff.js";

/**
 * The seven static repository capabilities. `exec` is constructed by the
 * Host because command, argv, environment and limits must never come from the
 * model.
 */
export const weekTwoToolRegistrations: readonly RegisteredTool[] = [
  treeToolRegistration,
  symbolsToolRegistration,
  readToolRegistration,
  readFileToolRegistration,
  grepToolRegistration,
  applyPatchToolRegistration,
  diffToolRegistration
];

export function createWeekTwoToolRegistrations(
  execProfiles: readonly ExecProfile[],
  execOptions: ExecToolOptions = {}
): readonly RegisteredTool[] {
  return [
    ...weekTwoToolRegistrations,
    createExecToolRegistration(execProfiles, execOptions)
  ];
}
