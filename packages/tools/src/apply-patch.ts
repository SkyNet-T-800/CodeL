import { randomBytes } from "node:crypto";
import {
    lstat,
    open,
    rename,
    unlink
} from "node:fs/promises";

import { basename, dirname, join, resolve } from "node:path";

import {
    registerTool,
    ToolError,
    type ExecutableTool,
    type JsonObject
} from "@repo-circuit/core";

import { sha256File, sha256Hex } from "./hash.js";
import { DEFAULT_TOOL_LIMITS } from "./limits.js";
import { resolveRepoPath } from "./path-safety.js";
import { decodeUtf8Text, readFileBytes } from "./text-file.js";
import { 
    applyParsedUnifiedDiff,
    parseSingleFileUnifiedDiff
} from "./unified-diff.js";

interface ApplyPatchInput {
    readonly path: string;
    readonly baseHash: string;
    readonly patch: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/; 
const MAX_PATCH_BYTES = 128 * 1024;

function parseInput(input: JsonObject): ApplyPatchInput {
    if (
        typeof input.path !== "string" ||
        typeof input.baseHash !== "string" ||
        typeof input.patch !== "string"
    ) {
        throw new ToolError(
            "INVALID_ARGUMENT",
            "apply_patch requires string path, baseHash, and patch fields"
        );
    }
    if (!HASH_PATTERN.test(input.baseHash)) {
        throw new ToolError(
            "INVALID_ARGUMENT",
            "baseHash must be a lowercase 64-character SHA-256 hex digest"
        );
    }
    return {
        path: input.path,
        baseHash: input.baseHash,
        patch: input.patch
    };
}

function isErrno(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code
    );
}

async function assertFinalEntryIsNotSymlink(
    workspaceRoot: string,
    userPath: string
): Promise<void> {
    const lexicalPath = resolve(workspaceRoot, userPath);
    let stats;
    try {
        stats = await lstat(lexicalPath);
    } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            throw new ToolError("PATH_NOT_FOUND", "Patch target does not exist");
        }
        throw error;
    }
    if (stats.isSymbolicLink()) {
        throw new ToolError(
            "SYMLINK_ESCAPE",
            "apply_patch does not modify symbolic links"
        );
    }
    if (!stats.isFile()) {
        throw new ToolError("NOT_A_FILE", "Patch target is not a regular file");
    }
}

async function writeAtomic(
    targetPath: string,
    content: Uint8Array,
    mode: number,
    expectedCurrentHash: string
): Promise<void> {
    const temporaryPath = join(
        dirname(targetPath),
        `.${basename(targetPath)}.repo-circuit-${randomBytes(12).toString("hex")}.tmp`
    );
    let temporaryCreated = false;
    try {
        const handle = await open(temporaryPath, "wx", mode & 0o777);
        temporaryCreated = true;
        try {
            await handle.writeFile(content);
            await handle.chmod(mode & 0o777);
            await handle.sync();
        } finally {
            await handle.close();
        }

        const currentHash = await sha256File(targetPath, {
            maxBytes: DEFAULT_TOOL_LIMITS.maxFileBytes
        });
        if (currentHash !== expectedCurrentHash) {
            throw new ToolError(
                "HASH_MISMATCH",
                "Patch target changed while the patch was being applied",
                {
                    expectedHash: expectedCurrentHash,
                    actualHash: currentHash
                }
            );
        }

        await rename(temporaryPath, targetPath);
        temporaryCreated = false;
    } finally {
        if (temporaryCreated) {
            await unlink(temporaryPath).catch(() => undefined);
        }
    }
}

const applyPatchTool: ExecutableTool<ApplyPatchInput> = {
    definition: {
        name: "apply_patch",
        description: "Apply one strict unified text diff to one existing repository file after verifying its SHA-256 base hash.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1},
                baseHash: {
                    type: "string",
                    pattern: "^[0-9a-f]{64}$"
                },
                patch: {
                    type: "string",
                    minLength: 1,
                    maxLength: MAX_PATCH_BYTES
                }
            },
            required: ["path", "baseHash", "patch"],
            additionalProperties: false
        },
        outputSchema: {
            type: "object",
            properties: {
                path: { type: "string" },
                beforeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
                afterHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
                appliedHunks: { type: "integer", minimum: 1 },
                bytesWritten: { type: "integer", minimum: 0 }
            },
            required: ["path", "beforeHash", "afterHash", "appliedHunks", "bytesWritten"],
            additionalProperties: false
        },
        annotations: {
            title: "Apply one repository patch",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    },
    parse: parseInput,

    async execute(input, context) {
        const targetPath = await resolveRepoPath(
            context.workspaceRoot, 
            input.path,
            { mode: "existing"}
        );
        await assertFinalEntryIsNotSymlink(context.workspaceRoot, targetPath);

        const stats = await lstat(targetPath);
        if (!stats.isFile()) {
            throw new ToolError("NOT_A_FILE", "Patch target is not a regular file");
        }

        const beforeBytes = await readFileBytes(targetPath, {
            maxBytes: DEFAULT_TOOL_LIMITS.maxFileBytes
        });
        const beforeHash = sha256Hex(beforeBytes);
        if (beforeHash !== input.baseHash) {
            throw new ToolError(
                "HASH_MISMATCH",
                "Patch base hash does not match the current file",
                {
                    expectedHash: input.baseHash,
                    actualHash: beforeHash
                }   
            );
        }

        const source = decodeUtf8Text(beforeBytes);
        const parsed = parseSingleFileUnifiedDiff(input.patch, input.path, {
            maxPatchBytes: MAX_PATCH_BYTES,
            maxHunks: 100,
            maxPatchLines: 10_000
        });

        const updated = applyParsedUnifiedDiff(source, parsed);
        const afterBytes = Buffer.from(updated, "utf8")
        if (afterBytes.byteLength > DEFAULT_TOOL_LIMITS.maxFileBytes) {
            throw new ToolError(
                "FILE_TOO_LARGE",
                "Patched file would exceed the file-size limit",
                { maxBytes: DEFAULT_TOOL_LIMITS.maxFileBytes }
            );
        }
        decodeUtf8Text(afterBytes);
        const afterHash = sha256Hex(afterBytes);

        await writeAtomic(targetPath, afterBytes, stats.mode, beforeHash);

        return {
            path: input.path,
            beforeHash,
            afterHash,
            appliedHunks: parsed.hunks.length,
            bytesWritten: afterBytes.byteLength
        }
    }
}

export const applyPatchToolRegistration = registerTool(applyPatchTool);
