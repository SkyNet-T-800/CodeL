import { realpath } from "fs/promises";
import { relative, sep } from "node:path";

import {
    registerTool,
    ToolError,
    type ExecutableTool,
    type JsonObject
} from "@repo-circuit/core";

import { DEFAULT_TOOL_LIMITS } from "./limits.js";
import { resolveRepoPath } from "./path-safety.js";
import { runProcess } from "./process-runner.js";

interface DiffInput {
    readonly paths: readonly string[];
    readonly contextLines: number;
}

const MAX_PATHS = 100;
const MAX_CONTEXT_LINES = 20;
const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat"
}

function parseInput(input: JsonObject): DiffInput {
    const pathsValue = input.paths;
    const contextValue = input.contextLines;
    const paths = pathsValue === undefined
        ? [] : Array.isArray(pathsValue) && pathsValue.every((item) => typeof item === "string")
        ? pathsValue
        : undefined;

    if (paths === undefined) {
        throw new ToolError("INVALID_ARGUMENT", "diff.paths must be string paths");
    }
    if (paths.length > MAX_PATHS) {
        throw new ToolError("INVALID_ARGUMENT", "diff.paths contains too many paths");
    }
    const contextLines = contextValue === undefined ? 3 : contextValue;
    if (
        typeof contextLines !== "number" ||
        !Number.isSafeInteger(contextLines) ||
        contextLines < 0 ||
        contextLines > MAX_CONTEXT_LINES
    ) {
        throw new ToolError(
            "INVALID_ARGUMENT", 
            `diff.contextLines must be an integer from 0 through ${MAX_CONTEXT_LINES}`
        );
    }
    return { paths, contextLines };
}

async function assertRepositoryRoot(workspaceRoot: string): Promise<string> {
    const realWorkspaceRoot = await realpath(workspaceRoot);
    const result = await runProcess({
       command: "git",
       args: ["rev-parse", "--show-toplevel"],
       cwd: realWorkspaceRoot,
       timeoutMs: DEFAULT_TOOL_LIMITS.execTimeoutMs,
       maxOutputBytes: 8 * 1024,
       env: GIT_ENVIRONMENT,
       label: "git rev-parse"
    });
    if (result.exitCode !== 0 || result.signal !== null) {
        throw new ToolError(
            "NOT_A_GIT_REPOSITORY",
            "Workspace root is not a Git repository"
        );
    }

    const reportedRoot = result.stdout.replace(/\r?\n$/, "");
    let realGitRoot: string;
    try {
        realGitRoot = await realpath(reportedRoot);
    } catch {
        throw new ToolError(
            "NOT_A_GIT_REPOSITORY",
            "Git reported an invalid repository root"
        );
    }
    if (realGitRoot !== realWorkspaceRoot) {
        throw new ToolError(
            "GIT_ROOT_MISMATCH",
            "Git top-level must equal the tool workspace root"
        );
    }
    return realWorkspaceRoot;
}

async function normalizePathspecs(
    realWorkspaceRoot: string,
    paths: readonly string[]
): Promise<readonly string[]> {
    const normalized: string[] = [];
    for (const userPath of paths) {
        const absolutePath = await resolveRepoPath(
            realWorkspaceRoot,
            userPath,
            { mode: "mayCreate" }
        );
        const relativePath = relative(realWorkspaceRoot, absolutePath);
        normalized.push(relativePath.split(sep).join("/"));
    }
    return normalized;
}

const diffTool: ExecutableTool<DiffInput> = {
    definition: {
        name: "diff",
        description: 
          "Return the bounded unified Git diff for the repository workspace or selected safe paths.",
        inputSchema: {
            type: "object",
            properties: {
                paths: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                    maxItems: MAX_PATHS,
                    uniqueItems: true
                },
                contextLines: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_CONTEXT_LINES
                },
            },
            additionalProperties: false
        },
        outputSchema: {
            type: "object",
            properties: {
                patch: { type: "string" },
                bytes: { type: "integer", minimum: 0 },
                changedFiles: { type: "integer", minimum: 0 }
            },
            required: ["patch", "bytes", "changedFiles"],
            additionalProperties: false
        },
        annotations: {
            title: "Show repository diff",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    },

    parse: parseInput,

    async execute(input, context) {
        const workspaceRoot = await assertRepositoryRoot(context.workspaceRoot);
        const pathspecs = await normalizePathspecs(workspaceRoot, input.paths);
        const result = await runProcess({
            command: "git",
            args: [
                "--literal-pathspecs",
                "-c",
                "core.quotepath=false",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
                `--unified=${input.contextLines}`,
                "--",
                ...pathspecs
            ],
            cwd: workspaceRoot,
            timeoutMs: DEFAULT_TOOL_LIMITS.execTimeoutMs,
            maxOutputBytes: DEFAULT_TOOL_LIMITS.maxOutputBytes,
            env: GIT_ENVIRONMENT,
            label: "git diff"
        });

        if (
            /^(?:Binary files .* differ|GIT binary patch)$/mu.test(result.stdout)
        ) {
            throw new ToolError(
                "BINARY_FILE",
                "Binary diffs are not supported"
            );
        }

        return {
            patch: result.stdout,
            bytes: Buffer.byteLength(result.stdout, "utf8"),
            changedFiles: result.stdout.match(/^diff --git /gmu)?.length ?? 0
        };
    }
};

export const diffToolRegistration = registerTool(diffTool);
