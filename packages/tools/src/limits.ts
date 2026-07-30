import { ToolError } from "@repo-circuit/core";

export interface ToolLimits {
    readonly maxFileBytes: number;
    readonly maxOutputBytes: number;
    readonly maxTreeEntries: number;
    readonly maxSearchMatches: number;
    readonly execTimeoutMs: number;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = Object.freeze({
    maxFileBytes: 1024 * 1024,
    maxOutputBytes: 256 * 1024,
    maxTreeEntries: 2_000,
    maxSearchMatches: 500,
    execTimeoutMs: 10000,
});

export function assertPositiveSafeInteger(
    value: number,
    name: string
): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new ToolError(
            "INVALID_LIMIT",
            `${name} must be a positive safe integer`
        );
    }
    return value;
}

export function resolveToolLimits(
  overrides: Partial<ToolLimits> = {}
): ToolLimits {
  return {
    maxFileBytes: assertPositiveSafeInteger(
      overrides.maxFileBytes ?? DEFAULT_TOOL_LIMITS.maxFileBytes,
      "maxFileBytes"
    ),
    maxOutputBytes: assertPositiveSafeInteger(
      overrides.maxOutputBytes ?? DEFAULT_TOOL_LIMITS.maxOutputBytes,
      "maxOutputBytes"
    ),
    maxTreeEntries: assertPositiveSafeInteger(
      overrides.maxTreeEntries ?? DEFAULT_TOOL_LIMITS.maxTreeEntries,
      "maxTreeEntries"
    ),
    maxSearchMatches: assertPositiveSafeInteger(
      overrides.maxSearchMatches ?? DEFAULT_TOOL_LIMITS.maxSearchMatches,
      "maxSearchMatches"
    ),
    execTimeoutMs: assertPositiveSafeInteger(
      overrides.execTimeoutMs ?? DEFAULT_TOOL_LIMITS.execTimeoutMs,
      "execTimeoutMs"
    )
  };
}
