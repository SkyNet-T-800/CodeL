import { lstat, readdir } from "node:fs/promises";
import { relative, sep } from "node:path";

import { ToolError } from "@repo-circuit/core";

export type RepositoryEntryType =
    | "directory"
    | "file"
    | "symlink"
    | "other";

export interface RepositoryEntry {
    readonly absolutePath: string;
    readonly path: string;
    readonly type: RepositoryEntryType;
}    

export interface WalkRepositoryOptions {
    readonly maxDepth: number;
    readonly maxEntries: number;
    readonly ignoredDirectoryNames?: ReadonlySet<string>;
}

export interface WalkRepositoryResult {
    readonly entries: readonly RepositoryEntry[];
    readonly truncated: boolean;
}

export const DEFAULT_IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = 
    new Set([".git", "dist", "node_modules"]);

function compareNames(
    left: { readonly name: string },
    right: { readonly name: string}
): number {
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function portableRelative(root: string, target: string): string {
    const result = relative(root, target);
    return sep === "/" ? result : result.split(sep).join("/");
}

function classifyStats(stats: {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}): RepositoryEntryType {
    if (stats.isSymbolicLink()) {
        return "symlink";
    }
    if (stats.isDirectory()) {
        return "directory";
    }
    if (stats.isFile()) {
        return "file";
    }
    return "other";
}

export async function walkRepository(
    realRepoRoot: string,
    startPath: string,
    options: WalkRepositoryOptions
): Promise<WalkRepositoryResult> {
    if (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0) {
        throw new ToolError("INVALID_LIMIT", "maxDepth must be a non-negative integer");  
    }
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
        throw new ToolError("INVALID_LIMIT", "maxEntries must be a positive integer");  
    }

    const ignored = options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES;
    const entries: RepositoryEntry[] = [];
    let truncated = false;

    const append = (
        absolutePath: string,
        type: RepositoryEntryType
    ): boolean => {
        if (entries.length >= options.maxEntries) {
            truncated = true;
            return false;
        }

        entries.push({
            absolutePath,
            path: portableRelative(realRepoRoot, absolutePath),
            type,
        });
        return true;
    };

    const visitDirectory = async (directoryPath: string, depth: number): Promise<void> => {
        const children = (await readdir(directoryPath, { withFileTypes: true})).sort(compareNames);

        for (const child of children) {
            if (truncated) {
                return;
            }
            if (child.isDirectory() && ignored.has(child.name)) {
                continue;
            }

            const childPath = `${directoryPath}${sep}${child.name}`;
            const childStats = await lstat(childPath);
            const type = classifyStats(childStats);
            if (!append(childPath, type)) {
                return;
            }

            if (type === "directory" && depth < options.maxDepth) {
                await visitDirectory(childPath, depth + 1);
            }
        }
    };

    const startStats = await lstat(startPath);
    const startType = classifyStats(startStats);
    if (startType === "directory") {
        await visitDirectory(startPath, 1);
    } else {
        append(startPath, startType);
    }

    return {
        entries,
        truncated,
    };

}


