import { stat } from "node:fs/promises";

import { 
    registerTool,
    ToolError,
    type ExecutableTool,
    type JsonObject
} from "@repo-circuit/core";

import { DEFAULT_TOOL_LIMITS } from "./limits.js";
import { resolveRepoPath } from "./path-safety.js";
import { walkRepository } from "./walk.js";

interface TreeInput {
    readonly path: string;
    readonly maxDepth: number;
    readonly maxEntries: number;
}

const treeTool: ExecutableTool<TreeInput> = {
    definition: {
        name: "tree",
        description: "List a deterministic, bounded repository tree without following symlinks.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1, maxLength: 4_096 },
                maxDepth: { type: "integer", minimum: 1, maximum: 8 },
                maxEntries: {
                    type: "integer",
                    minimum: 1,
                    maximum: DEFAULT_TOOL_LIMITS.maxTreeEntries,
                }
            },
            additionalProperties: false,
        },
        outputSchema: {
            type: "object",
            properties: {
                root: { type: "string" },
                entries: { 
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                           path: { type: "string" },
                           type: {
                               type: "string",
                               enum: ["directory", "file", "symlink", "other"],
                           }
                        },
                        required: ["path", "type"],
                        additionalProperties: false,
                    }
                },
                truncated: { type: "boolean" },
            },
            required: ["root", "entries", "truncated"],
            additionalProperties: false,
        },
        annotations: {
            titile: "List repository tree",
            readonlyOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    },

    parse(input) {
        return {
            path: typeof input.path === "string" ? input.path : ".",
            maxDepth: typeof input.maxDepth === "number" ? input.maxDepth : 3,
            maxEntries:
                typeof input.maxEntries === "number"
                ? input.maxEntries
                : DEFAULT_TOOL_LIMITS.maxTreeEntries
        };
    },

    async execute(input, context) {
        const [realRoot, startPath] = await Promise.all(
            [
                resolveRepoPath(context.workspaceRoot, "."),
                resolveRepoPath(context.workspaceRoot, input.path, {
                    rejectFinalSymlink: true,
                })
            ]
        );
        if (!(await stat(startPath)).isDirectory()) {
            throw new ToolError("NOT_A_DIRECTORY", "tree.path must be a directory");
        }

        const walked = await walkRepository(realRoot, startPath, {
            maxDepth: input.maxDepth,
            maxEntries: input.maxEntries,
        });
        const output = {
            root: input.path,
            entries: walked.entries.map(({ path, type }) => ({ path, type })),
            truncated: walked.truncated
        };
        if (Buffer.byteLength(JSON.stringify(output), "utf-8") > DEFAULT_TOOL_LIMITS.maxOutputBytes) {
            throw new ToolError(
                "OUTPUT_TOO_LARGE",
                "Tree output exceeds the configured byte limit"
            );
        }
        return output;
    }
};

export const treeToolRegistration = registerTool(treeTool);


