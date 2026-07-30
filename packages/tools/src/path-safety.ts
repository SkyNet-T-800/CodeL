import { lstat, realpath, stat } from "fs/promises";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    posix,
    relative,
    resolve,
    sep,
    win32
} from "node:path";

import { ToolError } from "@repo-circuit/core";

export type ResolveRepoPathMode = "existing" | "mayCreate";

export interface ResolveRepoPathOptions {
    readonly mode?: ResolveRepoPathMode;
    readonly rejectFinalSymlink?: boolean;
}

function isErrno(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code
    );
}

export function isPathInside(root: string, target: string): boolean {
    const relativePath = relative(root, target);
    return (
        relativePath === "" ||
        (relativePath !== ".." &&
            !relativePath.startsWith(`..${sep}`) &&
            !isAbsolute(relativePath)
        )
    );
}

function rejectInvalidUserPath(userPath: string): void {
    if (typeof userPath !== "string" || userPath.trim().length === 0) {
        throw new ToolError("INVALID_PATH", "Path must be a non-empty string");
    }
    if (userPath.includes("\0")) {
        throw new ToolError("INVALID_PATH", "Path must not contain a NUL byte");
    }

    if (
        isAbsolute(userPath) || 
        posix.isAbsolute(userPath) || 
        win32.parse(userPath).root.length > 0
    ) {
        throw new ToolError(
            "PATH_OUTSIDE_ROOT",
            "Absolute paths are not allowed",
            { reason: "absolute_path" }
        );
    }
}

async function canonicalDirectory(
    path: string,
    missingMessage: string
): Promise<string> {
    let canonical: string;
    try {
        canonical = await realpath(path);
    } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            throw new ToolError("PATH_NOT_FOUND", missingMessage);
        }
        throw error;
    }

    const pathStats = await stat(canonical);
    if (!pathStats.isDirectory()) {
        throw new ToolError("NOT_A_DIRECTORY", "Expected a directory path");
    }
    return canonical;
}

async function pathEntryExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            return false;
        }
        throw error;
    }
}

async function canonicalExistingTarget(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            throw new ToolError("SYMLINK_ESCAPE", "The path contains an unresolved symbolic link");
        }
        throw error;
    }
}

export async function resolveRepoPath(
    root: string,
    userPath: string,
    options: ResolveRepoPathOptions = {}
): Promise<string> {
    rejectInvalidUserPath(userPath);

    const mode = options.mode ?? "existing";
    const lexicalRoot = resolve(root);
    const lexicalTarget = resolve(lexicalRoot, userPath);

    if (!isPathInside(lexicalRoot, lexicalTarget)) {
        throw new ToolError(
            "PATH_OUTSIDE_ROOT",
            "Path escapes the repository root"
        );
    }

    const realRoot = await canonicalDirectory(
        lexicalRoot,
        "Repository root does not exist"
    );
    if (lexicalTarget === lexicalRoot) {
        return realRoot;
    }

    const lexicalParent = dirname(lexicalTarget);
    const realParent = await canonicalDirectory(
        lexicalParent,
        "Parent directory does not exist"
    );
    if (!isPathInside(realRoot, realParent)) {
        throw new ToolError(
            "SYMLINK_ESCAPE",
            "A symbolic link resolves outside the repository root"
        );
    }

    const targetExists = await pathEntryExists(lexicalTarget);
    if (!targetExists) {
        if (mode === "existing") {
            throw new ToolError(
                "PATH_NOT_FOUND",
                "Repository path does not exist"
            );
        }
        return join(realParent, basename(lexicalTarget));
    }

    const realTarget = await canonicalExistingTarget(lexicalTarget);
    if (!isPathInside(realRoot, realTarget)) {
        throw new ToolError(
            "SYMLINK_ESCAPE",
            "A symbolic link resolves outside the repository root"
        );
    }
    if (options.rejectFinalSymlink === true) {
        const targetStats = await lstat(lexicalTarget);
        if (targetStats.isSymbolicLink()) {
            throw new ToolError(
                "SYMLINK_FORBIDDEN",
                "This tool does not follow a final symbolic link"
            );
        }
    }
    return realTarget;
}