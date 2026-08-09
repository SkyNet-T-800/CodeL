import { posix } from "node:path";

import { ToolError } from "@repo-circuit/core";

export interface UnifiedDiffLine {
    readonly kind: "context" | "delete" | "add";
    readonly text: string;
    readonly noNewline: boolean;
}

export interface UnifiedDiffHunk {
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
    readonly inferredStart: boolean;
    readonly lines: readonly UnifiedDiffLine[];
}

export interface ParsedUnifiedDiff {
    readonly path: string;
    readonly hunks: readonly UnifiedDiffHunk[];
}

export interface UnifiedDiffLimits {
    readonly maxPatchBytes: number;
    readonly maxHunks: number;
    readonly maxPatchLines: number;
}

const DEFAULT_LIMITS: UnifiedDiffLimits = {
    maxPatchBytes: 1024 * 1024,
    maxHunks: 100,
    maxPatchLines: 1000,
}

const HUNK_HEADER =
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function isHunkHeader(line: string | undefined): boolean {
    return line === "@@" || line?.startsWith("@@ ") === true;
}

function patchError(message: string): never {
    throw new ToolError("PATCH_INVALID", message);
}    

function normalizedPatchPath(path: string): string {
    if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
        patchError("Patch paths may not contain NULL or line breaks");
    }
    const slashPath = path.replaceAll("\\", "/");
    const normalized = posix.normalize(slashPath).replace(/^\.\//, "");
    if (
        normalized.length === 0 ||
        normalized === "." ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        posix.isAbsolute(normalized)
    ) {
        patchError("Patch path must name one relative repository file");
    }
    return normalized;
}

function decimal(value: string, field: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        patchError(`Invalid ${field} in hunk header`);
    }
    return parsed;
}

function parseHunk(
    lines: readonly string[],
    startIndex: number
): { readonly hunk: UnifiedDiffHunk; readonly nextIndex: number } {
    const header = lines[startIndex];
    if (header === undefined) {
        patchError("Missing hunk header");
    }
    const inferredStart = header === "@@";
    const match = inferredStart ? null : HUNK_HEADER.exec(header);
    if (!inferredStart && match === null) {
        patchError(`Invalid hunk header: ${header}`);
    }

    const oldStart = inferredStart
        ? 0
        : decimal(match?.[1] ?? "", "old start");
    const newStart = inferredStart
        ? 0
        : decimal(match?.[3] ?? "", "new start");
    if (!inferredStart) {
        decimal(match?.[2] ?? "1", "old count");
        decimal(match?.[4] ?? "1", "new count");
    }

    const hunkLines: Array<{
        kind: "context" | "delete" | "add";
        text: string;
        noNewline: boolean;
    }> = [];

    let oldLines = 0;
    let newLines = 0;
    let index = startIndex + 1;

    for(; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || isHunkHeader(line)) {
            break;
        }
        if (line.startsWith("diff --git ")) {
            patchError("A patch may modify only one file");
        }

        if (line === "\\ No newline at end of file") {
            const previous = hunkLines.at(-1);
            if (previous === undefined || previous.noNewline) {
                patchError("Misplaced no-newline marker");
            }
            previous.noNewline = true;
            continue;
        }

        const prefix = line[0];
        if (prefix === " ") {
            hunkLines.push({
                kind: "context",
                text: line.slice(1),
                noNewline: false
            });
            oldLines += 1;
            newLines += 1;
        } else if (prefix === "-") {
            hunkLines.push({
                kind: "delete",
                text: line.slice(1),
                noNewline: false
            });
            oldLines += 1;
        } else if (prefix === "+") {
            hunkLines.push({
                kind: "add",
                text: line.slice(1),
                noNewline: false
            });
            newLines += 1;
        } else if (line.length === 0 && index === lines.length - 1) {
            break;
        } else {
            patchError("Every hunk line must begin with space, +, or -");
        }
    }

    if (hunkLines.length === 0) {
        patchError("A hunk must contain at least one line");
    }
    if ((oldLines > 0 && oldStart === 0 && !inferredStart) ||
        (newLines > 0 && newStart === 0 && !inferredStart)) {
        patchError("A non-empty hunk range must start at line 1 or later");
    }

    return {
        hunk: {
            oldStart,
            oldCount: oldLines,
            newStart,
            newCount: newLines,
            inferredStart,
            lines: hunkLines
        },
        nextIndex: index
    };
}

export function parseSingleFileUnifiedDiff(
    patch: string,
    expectedPath: string,
    limits: UnifiedDiffLimits = DEFAULT_LIMITS
): ParsedUnifiedDiff {
    if (Buffer.byteLength(patch, "utf8") > limits.maxPatchBytes) {
        throw new ToolError("PATCH_TOO_LARGE", "Patch exceeds its byte limit", {
            maxPatchBytes: limits.maxPatchBytes
        });
    }
    if (patch.includes("\0")) {
        patchError("Patch may not contain NUL");
    }

    const lines = patch.split("\n");
    if (lines.length > limits.maxPatchLines) {
        throw new ToolError("PATCH_TOO_LARGE", "Patch has too many lines", {
            maxPatchLines: limits.maxPatchLines
        })
    }

    const normalizedPath = normalizedPatchPath(expectedPath);
    const oldHeaderPath = `a/${normalizedPath}`;
    const newHeaderPath = `b/${normalizedPath}`;

    const expectedDiffHeader = `diff --git ${oldHeaderPath} ${newHeaderPath}`;
    let index = 0;

    if (lines[0]?.startsWith("diff --git ")) {
        if (lines[0] !== expectedDiffHeader) {
            patchError("diff --git header does not match apply_patch.path");
        }
        index = 1;
        if (lines[index]?.startsWith("index")) {
            if (!/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(lines[index] ?? "")) {
                patchError("Invalid index header");
            }
            index += 1;
        }

        if (lines[index] !== `--- ${oldHeaderPath}`) {
            patchError("--- header does not match apply_patch.path");
        }
        index += 1;
        if (lines[index] !== `+++ ${newHeaderPath}`) {
            patchError("+++ header does not match apply_patch.path");
        }
        index += 1;
    } else if (lines[0]?.startsWith("--- ")) {
        if (
            lines[0] !== `--- ${oldHeaderPath}` &&
            lines[0] !== `--- ${normalizedPath}`
        ) {
            patchError("--- header does not match apply_patch.path");
        }
        if (
            lines[1] !== `+++ ${newHeaderPath}` &&
            lines[1] !== `+++ ${normalizedPath}`
        ) {
            patchError("+++ header does not match apply_patch.path");
        }
        index = 2;
    } else if (!isHunkHeader(lines[0])) {
        patchError(
            "Patch must start with a diff --git header, ---/+++ headers, or an @@ hunk header"
        );
    }
    
    const hunks: UnifiedDiffHunk[] = [];
    while (index < lines.length) {
        if (lines[index] === "" && index === lines.length - 1) {
            index += 1;
            break;
        }
        if (!isHunkHeader(lines[index])) {
            patchError(`Unexpected patch metadata: ${lines[index] ?? ""}`);
        }
        if (hunks.length >= limits.maxHunks) {
            throw new ToolError("PATCH_TOO_LARGE", "Patch has too many hunks", {
                maxHunks: limits.maxHunks
            });
        }
        const parsed = parseHunk(lines, index);
        hunks.push(parsed.hunk);
        index = parsed.nextIndex;
    }

    if (hunks.length === 0) {
        patchError("Patch must contain at least one hunk");
    }

    return { path: normalizedPath, hunks };
}

interface FileLines {
    readonly lines: readonly string[];
    readonly finalNewline: boolean;
}

function splitFile(text: string): FileLines {
    if (text.length === 0) {
        return { lines: [], finalNewline: false };
    }
    const finalNewline = text.endsWith("\n");
    const body = finalNewline ? text.slice(0, -1) : text;
    return { lines: body.split("\n"), finalNewline };
}

function hunkIndex(start: number, count: number): number {
    return count === 0 ? start : start - 1;
}

function mismatch(kind: "context" | "delete", lineNumber: number): never {
    throw new ToolError(
        "PATCH_CONTEXT_MISMATCH",
        `Patch ${kind} does not match the file at line ${lineNumber}`
    )
}

function inferHunkIndex(
    originalLines: readonly string[],
    hunk: UnifiedDiffHunk,
    minimumIndex: number
): number {
    const expected = hunk.lines
        .filter((line) => line.kind !== "add")
        .map((line) => line.text);
    if (expected.length === 0) {
        throw new ToolError(
            "PATCH_APPLY_FAILED",
            "A bare @@ insertion needs numbered ranges because it has no source context"
        );
    }

    const matches: number[] = [];
    const lastStart = originalLines.length - expected.length;
    for (let start = minimumIndex; start <= lastStart; start += 1) {
        if (expected.every((line, offset) => originalLines[start + offset] === line)) {
            matches.push(start);
        }
    }
    if (matches.length === 0) {
        throw new ToolError(
            "PATCH_CONTEXT_MISMATCH",
            "Bare @@ hunk source lines do not match the file"
        );
    }
    if (matches.length > 1) {
        throw new ToolError(
            "PATCH_APPLY_FAILED",
            "Bare @@ hunk source lines are ambiguous; use numbered ranges or more context"
        );
    }
    return matches[0] as number;
}

export function applyParsedUnifiedDiff(
    source: string,
    parsed: ParsedUnifiedDiff
): string {
    const original = splitFile(source);
    const output: string[] = [];
    const newlineMarkers: Array<boolean | undefined> = [];
    let oldCursor = 0;

    for (const hunk of parsed.hunks) {
        const oldIndex = hunk.inferredStart
            ? inferHunkIndex(original.lines, hunk, oldCursor)
            : hunkIndex(hunk.oldStart, hunk.oldCount);
        if (oldIndex < oldCursor || oldIndex > original.lines.length) {
            throw new ToolError(
                "PATCH_APPLY_FAILED",
                "Patch hunks overlap or start outside the file"
            );
        }
        if (
            !hunk.inferredStart &&
            hunkIndex(hunk.newStart, hunk.newCount) !==
                output.length + (oldIndex - oldCursor)
        ) {
            throw new ToolError(
                "PATCH_APPLY_FAILED",
                "New-file hunk positions are inconsistent"
            );
        }

        while (oldCursor < oldIndex) {
            const line = original.lines[oldCursor];
            if (line === undefined) {
                throw new ToolError("PATCH_APPLY_FAILED", "Hunk starts outside the file");
            }
            output.push(line);
            newlineMarkers.push(undefined);
            oldCursor += 1;
        }

        for(const line of hunk.lines) {
            if (line.kind === "add") {
                output.push(line.text);
                newlineMarkers.push(!line.noNewline);
                continue;
            }

            const actual = original.lines[oldCursor];
            if (actual !== line.text) {
                mismatch(line.kind, oldCursor + 1);
            }
            const isOriginalLastLine = oldCursor === original.lines.length - 1;
            if (
                line.noNewline !== (isOriginalLastLine && !original.finalNewline)
            ) {
                throw new ToolError(
                "PATCH_CONTEXT_MISMATCH",
                "Patch newline marker does not match the file"
                );
            }
            oldCursor += 1;

            if (line.kind === "context") {
                output.push(line.text);
                newlineMarkers.push(!line.noNewline);
            }
        }
    }

    while (oldCursor < original.lines.length) {
        const line = original.lines[oldCursor];
        if (line === undefined) {
            break;
        }
        output.push(line);
        newlineMarkers.push(undefined);
        oldCursor += 1;
    }

    const noNewlineMarkerIndex = newlineMarkers.findIndex(
            (marker) => marker === false
    );
    if (
        noNewlineMarkerIndex !== -1 &&
        noNewlineMarkerIndex !== output.length - 1
    ) {
        throw new ToolError(
        "PATCH_APPLY_FAILED",
        "A no-newline marker may only describe the final output line"
        );
    }
    if (output.length === 0) {
        return "";
    }
    const finalNewline =
        newlineMarkers.at(-1) === undefined
        ? original.finalNewline
        : newlineMarkers.at(-1);
    return output.join("\n") + (finalNewline === true ? "\n" : "");
}
