import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  registerTool,
  ToolError,
  type ExecutableTool,
  type JsonObject,
  type RegisteredTool
} from "@repo-circuit/core";

import { isPathInside, resolveRepoPath } from "./path-safety.js";
import {
  DEFAULT_RIPGREP_CAPTURE_BYTES,
  defaultRipgrepTimeoutMs,
  runRipgrep,
  type RipgrepResult,
  type RipgrepRunOptions
} from "./ripgrep.js";

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepQuery {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly type?: string;
  readonly mode: GrepOutputMode;
  readonly before?: number;
  readonly after?: number;
  readonly contextAlias?: number;
  readonly context?: number;
  readonly lineNumbers: boolean;
  readonly ignoreCase: boolean;
  readonly headLimit?: number;
  readonly offset: number;
  readonly multiline: boolean;
}

export interface GrepToolRegistrationOptions {
  /** Host-pinned binary for hardened compositions; defaults to PATH lookup. */
  readonly ripgrepBinary?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly runner?: (options: RipgrepRunOptions) => Promise<RipgrepResult>;
  readonly statFile?: (path: string) => Promise<{ readonly mtimeMs?: number }>;
}

const VERSION_CONTROL_DIRECTORIES = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl"
] as const;

export const DEFAULT_GREP_HEAD_LIMIT = 250;

const semanticNumberSchema: JsonObject = {
  anyOf: [
    { type: "number" },
    { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" }
  ]
};

const semanticBooleanSchema: JsonObject = {
  anyOf: [
    { type: "boolean" },
    { type: "string", enum: ["true", "false"] }
  ]
};

const inputSchema: JsonObject = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    glob: { type: "string" },
    output_mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"]
    },
    "-B": semanticNumberSchema,
    "-A": semanticNumberSchema,
    "-C": semanticNumberSchema,
    context: semanticNumberSchema,
    "-n": semanticBooleanSchema,
    "-i": semanticBooleanSchema,
    type: { type: "string" },
    head_limit: semanticNumberSchema,
    offset: semanticNumberSchema,
    multiline: semanticBooleanSchema
  },
  required: ["pattern"],
  additionalProperties: false
};

const outputSchema: JsonObject = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"]
    },
    numFiles: { type: "number" },
    filenames: { type: "array", items: { type: "string" } },
    content: { type: "string" },
    numLines: { type: "number" },
    numMatches: { type: "number" },
    appliedLimit: { type: "number" },
    appliedOffset: { type: "number" },
    truncated: { type: "boolean" }
  },
  required: ["mode", "numFiles", "filenames", "truncated"],
  additionalProperties: false
};

function semanticNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new ToolError(
    "INVALID_ARGUMENT",
    `${field} must be a finite decimal number`
  );
}

function semanticBoolean(
  value: unknown,
  field: string,
  fallback: boolean
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ToolError(
    "INVALID_ARGUMENT",
    `${field} must be a boolean or the string true/false`
  );
}

function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || typeof value === "string") {
    return value;
  }
  throw new ToolError("INVALID_ARGUMENT", `${key} must be a string`);
}

function parseQuery(input: JsonObject): GrepQuery {
  if (typeof input.pattern !== "string") {
    throw new ToolError("INVALID_ARGUMENT", "grep.pattern must be a string");
  }
  const rawMode = input.output_mode ?? "files_with_matches";
  if (
    rawMode !== "content" &&
    rawMode !== "files_with_matches" &&
    rawMode !== "count"
  ) {
    throw new ToolError("INVALID_ARGUMENT", "grep.output_mode is invalid");
  }

  const path = optionalString(input, "path");
  const glob = optionalString(input, "glob");
  const type = optionalString(input, "type");
  const before = semanticNumber(input["-B"], "-B");
  const after = semanticNumber(input["-A"], "-A");
  const contextAlias = semanticNumber(input["-C"], "-C");
  const context = semanticNumber(input.context, "context");
  const headLimit = semanticNumber(input.head_limit, "head_limit");

  return {
    pattern: input.pattern,
    mode: rawMode,
    lineNumbers: semanticBoolean(input["-n"], "-n", true),
    ignoreCase: semanticBoolean(input["-i"], "-i", false),
    offset: semanticNumber(input.offset, "offset") ?? 0,
    multiline: semanticBoolean(input.multiline, "multiline", false),
    ...(path === undefined ? {} : { path }),
    ...(glob === undefined ? {} : { glob }),
    ...(type === undefined ? {} : { type }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(contextAlias === undefined ? {} : { contextAlias }),
    ...(context === undefined ? {} : { context }),
    ...(headLimit === undefined ? {} : { headLimit })
  };
}

export function splitGlobExpression(expression: string): string[] {
  const patterns: string[] = [];
  for (const token of expression.split(/\s+/)) {
    if (token.includes("{") && token.includes("}")) {
      patterns.push(token);
    } else {
      patterns.push(...token.split(",").filter((part) => part.length > 0));
    }
  }
  return patterns.filter((pattern) => pattern.length > 0);
}

function contextArguments(query: GrepQuery): readonly string[] {
  if (query.mode !== "content") {
    return [];
  }
  const symmetric = query.context ?? query.contextAlias;
  if (symmetric !== undefined) {
    return ["-C", String(symmetric)];
  }
  return [
    ...(query.before === undefined ? [] : ["-B", String(query.before)]),
    ...(query.after === undefined ? [] : ["-A", String(query.after)])
  ];
}

function outputArguments(query: GrepQuery): readonly string[] {
  switch (query.mode) {
    case "files_with_matches":
      return ["-l"];
    case "count":
      return ["-c", "--with-filename"];
    case "content":
      // Force a filename for file targets as well as directory targets so the
      // result record format is stable and count aggregation stays unambiguous.
      return [...(query.lineNumbers ? ["-n"] : []), "--with-filename"];
  }
}

function patternArguments(pattern: string): readonly string[] {
  return pattern.startsWith("-") ? ["-e", pattern] : [pattern];
}

function callerFilterArguments(query: GrepQuery): readonly string[] {
  return [
    ...(query.type ? ["--type", query.type] : []),
    ...(query.glob
      ? splitGlobExpression(query.glob).flatMap((pattern) => [
          "--glob",
          pattern
        ])
      : [])
  ];
}

function repositoryPolicyArguments(): readonly string[] {
  return VERSION_CONTROL_DIRECTORIES.flatMap((directory) => [
    "--glob",
    `!${directory}`
  ]);
}

function rejectVersionControlTarget(
  workspaceRoot: string,
  requestedPath: string
): void {
  const lexicalTarget = resolve(workspaceRoot, requestedPath);
  if (!isPathInside(workspaceRoot, lexicalTarget)) {
    return;
  }
  const blockedDirectory = relative(workspaceRoot, lexicalTarget)
    .split(sep)
    .find((segment) =>
      VERSION_CONTROL_DIRECTORIES.includes(
        segment as (typeof VERSION_CONTROL_DIRECTORIES)[number]
      )
    );
  if (blockedDirectory !== undefined) {
    throw new ToolError(
      "POLICY_DENIED",
      "Searching version-control metadata is not allowed",
      { directory: blockedDirectory }
    );
  }
}

export function buildRipgrepArguments(query: GrepQuery): string[] {
  const featureArguments = [
    ...(query.multiline ? ["-U", "--multiline-dotall"] : []),
    ...(query.ignoreCase ? ["-i"] : [])
  ];

  return [
    "--hidden",
    "--max-columns",
    "500",
    ...featureArguments,
    ...outputArguments(query),
    ...contextArguments(query),
    ...patternArguments(query.pattern),
    ...callerFilterArguments(query),
    // ripgrep gives later overlapping globs precedence. Repository policy is
    // emitted last so caller filters can narrow the search but cannot expose
    // VCS control data.
    ...repositoryPolicyArguments()
  ];
}

export interface GrepPage<T> {
  readonly items: readonly T[];
  readonly appliedLimit?: number;
}

export function paginateGrepResults<T>(
  items: readonly T[],
  limit: number | undefined,
  offset = 0
): GrepPage<T> {
  if (limit === 0) {
    return { items: items.slice(offset) };
  }
  const effectiveLimit = limit ?? DEFAULT_GREP_HEAD_LIMIT;
  const page = items.slice(offset, offset + effectiveLimit);
  return {
    items: page,
    ...(items.length - offset > effectiveLimit
      ? { appliedLimit: effectiveLimit }
      : {})
  };
}

function portablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function relativeSearchPath(workspaceRoot: string, candidate: string): string {
  if (!isAbsolute(candidate) || !isPathInside(workspaceRoot, candidate)) {
    return candidate;
  }
  return portablePath(relative(workspaceRoot, candidate));
}

function relativizeContentLine(workspaceRoot: string, line: string): string {
  const nativePrefix = `${workspaceRoot}${sep}`;
  if (!line.startsWith(nativePrefix)) {
    return line;
  }
  const body = line.slice(nativePrefix.length);
  // rg uses ':' for matching records and '-' for context records. In both
  // forms the separator immediately precedes a decimal line number.
  const recordSeparator = /([:-])\d+\1/.exec(body);
  if (recordSeparator?.index === undefined) {
    return line;
  }
  return `${portablePath(body.slice(0, recordSeparator.index))}${body.slice(recordSeparator.index)}`;
}

function relativizeCountLine(workspaceRoot: string, line: string): string {
  const separator = line.lastIndexOf(":");
  if (separator <= 0) {
    return line;
  }
  const path = relativeSearchPath(workspaceRoot, line.slice(0, separator));
  return `${path}${line.slice(separator)}`;
}

export async function sortGrepFiles(
  paths: readonly string[],
  statFile: (path: string) => Promise<{ readonly mtimeMs?: number }> = stat,
  order: "modified" | "path" = "modified"
): Promise<string[]> {
  const stats = await Promise.allSettled(paths.map(async (path) => statFile(path)));
  return paths
    .map((path, index) => {
      const result = stats[index];
      return {
        path,
        mtime:
          result?.status === "fulfilled" ? (result.value.mtimeMs ?? 0) : 0
      };
    })
    .sort((left, right) => {
      if (order === "path") {
        return left.path.localeCompare(right.path);
      }
      return right.mtime - left.mtime || left.path.localeCompare(right.path);
    })
    .map(({ path }) => path);
}

function pageFields(
  page: GrepPage<string>,
  offset: number
): JsonObject {
  return {
    ...(page.appliedLimit === undefined
      ? {}
      : { appliedLimit: page.appliedLimit }),
    ...(offset > 0 ? { appliedOffset: offset } : {})
  };
}

function contentOutput(
  results: readonly string[],
  query: GrepQuery,
  workspaceRoot: string,
  ripgrepTruncated: boolean
): JsonObject {
  const page = paginateGrepResults(results, query.headLimit, query.offset);
  const lines = page.items.map((line) =>
    relativizeContentLine(workspaceRoot, line)
  );
  return {
    mode: "content",
    numFiles: 0,
    filenames: [],
    content: lines.join("\n"),
    numLines: lines.length,
    truncated: ripgrepTruncated || page.appliedLimit !== undefined,
    ...pageFields(page, query.offset)
  };
}

function countOutput(
  results: readonly string[],
  query: GrepQuery,
  workspaceRoot: string,
  ripgrepTruncated: boolean
): JsonObject {
  const page = paginateGrepResults(results, query.headLimit, query.offset);
  const lines = page.items.map((line) =>
    relativizeCountLine(workspaceRoot, line)
  );
  let numFiles = 0;
  let numMatches = 0;
  for (const line of lines) {
    const separator = line.lastIndexOf(":");
    if (separator <= 0) {
      continue;
    }
    const count = Number.parseInt(line.slice(separator + 1), 10);
    if (!Number.isNaN(count)) {
      numFiles += 1;
      numMatches += count;
    }
  }
  return {
    mode: "count",
    numFiles,
    filenames: [],
    content: lines.join("\n"),
    numMatches,
    truncated: ripgrepTruncated || page.appliedLimit !== undefined,
    ...pageFields(page, query.offset)
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

export function createGrepToolRegistration(
  options: GrepToolRegistrationOptions = {}
): RegisteredTool {
  if (
    options.ripgrepBinary !== undefined &&
    !isAbsolute(options.ripgrepBinary)
  ) {
    throw new Error("Injected ripgrepBinary must be an absolute path");
  }
  const binary = options.ripgrepBinary ?? "rg";
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? defaultRipgrepTimeoutMs(),
    "timeoutMs"
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_RIPGREP_CAPTURE_BYTES,
    "maxOutputBytes"
  );
  const runner = options.runner ?? runRipgrep;
  const statFile = options.statFile ?? stat;

  const tool: ExecutableTool<GrepQuery> = {
    definition: {
      name: "grep",
      description:
        "Search repository file contents with ripgrep regexes; return matching files, lines, or per-file counts.",
      inputSchema,
      outputSchema,
      annotations: {
        title: "Search repository contents",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    parse: parseQuery,
    async execute(query, context) {
      context.signal?.throwIfAborted();
      const workspaceRoot = await resolveRepoPath(context.workspaceRoot, ".");
      const requestedPath =
        query.path === undefined || query.path.trim().length === 0
          ? "."
          : query.path;
      rejectVersionControlTarget(workspaceRoot, requestedPath);
      const target = await resolveRepoPath(workspaceRoot, requestedPath);
      const { lines, truncated: ripgrepTruncated } = await runner({
        binary,
        args: buildRipgrepArguments(query),
        target,
        cwd: workspaceRoot,
        timeoutMs,
        maxOutputBytes,
        ...(context.signal === undefined ? {} : { signal: context.signal })
      });

      if (query.mode === "content") {
        return contentOutput(lines, query, workspaceRoot, ripgrepTruncated);
      }
      if (query.mode === "count") {
        return countOutput(lines, query, workspaceRoot, ripgrepTruncated);
      }

      const sorted = await sortGrepFiles(lines, statFile);
      const page = paginateGrepResults(sorted, query.headLimit, query.offset);
      const filenames = page.items.map((path) =>
        relativeSearchPath(workspaceRoot, path)
      );
      return {
        mode: "files_with_matches",
        numFiles: filenames.length,
        filenames,
        truncated: ripgrepTruncated || page.appliedLimit !== undefined,
        ...pageFields(page, query.offset)
      };
    }
  };

  return registerTool(tool);
}

export const grepToolRegistration = createGrepToolRegistration();
