import { release } from "node:os";

import { ToolError } from "@repo-circuit/core";

import {
  captureProcess,
  type CapturedProcessResult,
  type ProcessRunOptions
} from "./process-runner.js";

export const DEFAULT_RIPGREP_TIMEOUT_MS = 20_000;
export const WSL_RIPGREP_TIMEOUT_MS = 60_000;
export const DEFAULT_RIPGREP_CAPTURE_BYTES = 20_000_000;

export function defaultRipgrepTimeoutMs(
  platform = process.platform,
  kernelRelease = release()
): number {
  return platform === "linux" && kernelRelease.toLowerCase().includes("microsoft")
    ? WSL_RIPGREP_TIMEOUT_MS
    : DEFAULT_RIPGREP_TIMEOUT_MS;
}

export type ProcessCapture = (
  options: ProcessRunOptions
) => Promise<CapturedProcessResult>;

export interface RipgrepResult {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

export interface RipgrepRunOptions {
  readonly binary: string;
  readonly args: readonly string[];
  readonly target: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Test seam for process outcomes; production callers use captureProcess. */
  readonly capture?: ProcessCapture;
}

export class RipgrepTimeoutError extends ToolError {
  readonly partialResults: readonly string[];

  constructor(timeoutMs: number, partialResults: readonly string[]) {
    super(
      "RIPGREP_TIMEOUT",
      `ripgrep did not finish within ${timeoutMs}ms; narrow the path or pattern`,
      { timeoutMs, partialResults }
    );
    this.name = "RipgrepTimeoutError";
    this.partialResults = partialResults;
  }
}

export function parseRipgrepLines(
  stdout: string,
  discardTrailingLine = false
): string[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const lines = trimmed
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  return discardTrailingLine && lines.length > 0 ? lines.slice(0, -1) : lines;
}

const RESOURCE_PRESSURE_MARKERS = [
  "os error 11",
  "Resource temporarily unavailable"
] as const;

function resourcePressureWasReported(outcome: CapturedProcessResult): boolean {
  const failed =
    outcome.termination !== "exited" ||
    (outcome.exitCode !== 0 && outcome.exitCode !== 1);
  return (
    failed &&
    RESOURCE_PRESSURE_MARKERS.some((marker) => outcome.stderr.includes(marker))
  );
}

function unavailableRipgrep(errorCode: string | undefined): never {
  if (errorCode === "ENOENT") {
    throw new ToolError(
      "RIPGREP_NOT_FOUND",
      "The ripgrep executable could not be found"
    );
  }
  if (errorCode === "EACCES" || errorCode === "EPERM") {
    throw new ToolError(
      "RIPGREP_ACCESS_DENIED",
      "The ripgrep executable could not be started due to file permissions"
    );
  }
  throw new ToolError(
    "RIPGREP_EXEC_FAILED",
    "The ripgrep process could not be started",
    errorCode === undefined ? undefined : { causeCode: errorCode }
  );
}

async function executeAttempt(
  options: RipgrepRunOptions,
  recoveryArguments: readonly string[]
): Promise<CapturedProcessResult> {
  const capture = options.capture ?? captureProcess;
  return await capture({
    command: options.binary,
    args: [
      ...recoveryArguments,
      ...options.args,
      options.target
    ],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? defaultRipgrepTimeoutMs(),
    maxOutputBytes:
      options.maxOutputBytes ?? DEFAULT_RIPGREP_CAPTURE_BYTES,
    label: "ripgrep",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

/**
 * Run one ripgrep query and normalize stdout to non-empty logical lines.
 * Exit 1 means a complete search with no matches. Resource exhaustion gets one
 * isolated single-thread retry; no global state is mutated.
 */
export async function runRipgrep(options: RipgrepRunOptions): Promise<RipgrepResult> {
  options.signal?.throwIfAborted();

  let outcome = await executeAttempt(options, []);
  if (resourcePressureWasReported(outcome)) {
    outcome = await executeAttempt(options, ["-j", "1"]);
  }

  if (outcome.termination === "aborted") {
    options.signal?.throwIfAborted();
    throw new ToolError("RIPGREP_ABORTED", "The ripgrep search was aborted");
  }

  if (outcome.termination === "spawn_failed") {
    unavailableRipgrep(outcome.errorCode);
  }

  if (outcome.termination === "exited") {
    if (outcome.exitCode === 0) {
      return { lines: parseRipgrepLines(outcome.stdout), truncated: false };
    }
    if (outcome.exitCode === 1) {
      return { lines: [], truncated: false };
    }
  }

  const incompleteTail =
    outcome.termination === "timed_out" ||
    outcome.termination === "output_limited";
  const partial = parseRipgrepLines(outcome.stdout, incompleteTail);

  if (outcome.termination === "timed_out" && partial.length === 0) {
    throw new RipgrepTimeoutError(
      options.timeoutMs ?? defaultRipgrepTimeoutMs(),
      partial
    );
  }

  // Match ripgrep's best-effort search semantics: an abnormal completion can
  // still yield complete lines collected before the failure. Invalid usage
  // without stdout therefore becomes an empty result, not a false partial.
  return { lines: partial, truncated: incompleteTail };
}
