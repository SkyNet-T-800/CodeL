import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

import type { RunMeta } from "@repo-circuit/core";

import { validateRunMeta } from "./run-meta.js";

export interface RunDirectoryIssue {
  readonly path: string;
  readonly message: string;
}

export interface RunDirectoryValidationResult {
  readonly valid: boolean;
  readonly runMeta: RunMeta | undefined;
  readonly issues: readonly RunDirectoryIssue[];
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
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

function safeArtifactPath(
  runDirectory: string,
  artifactPath: string
): string | undefined {
  if (isAbsolute(artifactPath)) {
    return undefined;
  }
  const root = resolve(runDirectory);
  const absolute = resolve(root, artifactPath);
  const fromRoot = relative(root, absolute);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return undefined;
  }
  return absolute;
}

async function readArtifact(
  runDirectory: string,
  artifactPath: string,
  expectedHash: string,
  issuePath: string,
  issues: RunDirectoryIssue[]
): Promise<Uint8Array | undefined> {
  const absolute = safeArtifactPath(runDirectory, artifactPath);
  if (absolute === undefined) {
    issues.push({
      path: issuePath,
      message: "must stay inside the Run directory"
    });
    return undefined;
  }
  try {
    const bytes = await readFile(absolute);
    const actual = sha256(bytes);
    if (actual !== expectedHash) {
      issues.push({
        path: issuePath,
        message: `SHA-256 mismatch: expected ${expectedHash}, received ${actual}`
      });
    }
    return bytes;
  } catch (error) {
    issues.push({
      path: issuePath,
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function validateTrace(
  bytes: Uint8Array,
  runId: string,
  issues: RunDirectoryIssue[]
): void {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n")) {
    issues.push({
      path: "$.artifacts.tracePath",
      message: "Trace must end with a newline"
    });
  }
  const lines = text.trimEnd().split("\n").filter((line) => line.length > 0);
  let terminalCount = 0;
  for (const [index, line] of lines.entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      issues.push({
        path: `trace:${index + 1}`,
        message: "must be an independently parseable JSON object"
      });
      continue;
    }
    if (
      typeof event !== "object" ||
      event === null ||
      Array.isArray(event)
    ) {
      issues.push({
        path: `trace:${index + 1}`,
        message: "must be a JSON object"
      });
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.runId !== runId) {
      issues.push({
        path: `trace:${index + 1}.runId`,
        message: `must equal ${runId}`
      });
    }
    if (record.seq !== index + 1) {
      issues.push({
        path: `trace:${index + 1}.seq`,
        message: `must equal ${index + 1}`
      });
    }
    if (
      record.type === "run.end" ||
      record.type === "run.error" ||
      record.type === "turn.interrupted"
    ) {
      terminalCount += 1;
      if (index !== lines.length - 1) {
        issues.push({
          path: `trace:${index + 1}.type`,
          message: "terminal event must be the final Trace event"
        });
      }
    }
  }
  if (terminalCount !== 1) {
    issues.push({
      path: "$.artifacts.tracePath",
      message: `Trace must contain exactly one terminal event; received ${terminalCount}`
    });
  }
}

/**
 * Checks the evidence bundle, not just the Run Meta JSON shape.
 */
export async function validateRunDirectory(
  runDirectory: string
): Promise<RunDirectoryValidationResult> {
  const issues: RunDirectoryIssue[] = [];
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(resolve(runDirectory, "run-meta.json"), "utf8")
    ) as unknown;
  } catch (error) {
    return {
      valid: false,
      runMeta: undefined,
      issues: [
        {
          path: "$.runMeta",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }

  const metaValidation = validateRunMeta(value);
  if (!metaValidation.valid) {
    return {
      valid: false,
      runMeta: undefined,
      issues: metaValidation.issues
    };
  }
  const runMeta = value as RunMeta;
  if (basename(resolve(runDirectory)) !== runMeta.runId) {
    issues.push({
      path: "$.runId",
      message: "must equal the Run directory name"
    });
  }

  try {
    const runConfig = JSON.parse(
      await readFile(resolve(runDirectory, "run-config.json"), "utf8")
    ) as unknown;
    const {
      outcome: _outcome,
      artifacts: _artifacts,
      ...configuration
    } = runMeta;
    if (canonicalJson(runConfig) !== canonicalJson(configuration)) {
      issues.push({
        path: "$.runConfig",
        message: "must exactly match the frozen configuration in Run Meta"
      });
    }
  } catch (error) {
    issues.push({
      path: "$.runConfig",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  const trace = await readArtifact(
    runDirectory,
    runMeta.artifacts.tracePath,
    runMeta.artifacts.traceSha256,
    "$.artifacts.tracePath",
    issues
  );
  await readArtifact(
    runDirectory,
    runMeta.artifacts.patchPath,
    runMeta.artifacts.patchSha256,
    "$.artifacts.patchPath",
    issues
  );
  await readArtifact(
    runDirectory,
    runMeta.artifacts.verifierResultPath,
    runMeta.artifacts.verifierResultSha256,
    "$.artifacts.verifierResultPath",
    issues
  );
  if (trace !== undefined) {
    validateTrace(trace, runMeta.runId, issues);
  }

  return {
    valid: issues.length === 0,
    runMeta,
    issues
  };
}
