import {
    registerTool,
    ToolError,
    type ExecutableTool,
    type JsonObject,
    type RegisteredTool
} from "@repo-circuit/core";

import { sha256Hex } from "./hash.js";
import { DEFAULT_TOOL_LIMITS } from "./limits.js";
import { resolveRepoPath } from "./path-safety.js";
import { decodeUtf8Text, readFileBytes } from "./text-file.js";

interface ReadInput {
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
}

const inputSchema: JsonObject = {
    type: "object",
    properties: {
        path: { type: "string", minLength: 1, maxLength: 4_096 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
};

const outputSchema: JsonObject = {
    type: "object",
    properties: {
        path: { type: "string" },
        content: { type: "string" },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        byteLength: { type: "integer", minimum: 0 },
        startLine: { type: "integer", minimum: 0 },
        endLine: { type: "integer", minimum: 0 },
        totalLines: { type: "integer", minimum: 0 }
    },
    required: [
        "path",
        "content",
        "sha256",
        "byteLength",
        "startLine",
        "endLine",
        "totalLines"
    ],
    additionalProperties: false,
};

const legacyOutputSchema: JsonObject = {
    type: "object",
    properties: {
        path: { type: "string" },
        content: { type: "string" }
    },
    required: ["path", "content"],
    additionalProperties: false    
};

function parseReadInput(input: JsonObject): ReadInput {
    const path = input.path as string;
    const startLine = typeof input.startLine === "number" ? input.startLine : undefined;
    const endLine = typeof input.endLine === "number" ? input.endLine : undefined;

    return {
        path,
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine })
    };
}

function splitLinesPreservingEndings(content: string): readonly string[] {
    if (content.length === 0) {
        return [];
    }
    return content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}


function createReadTool(name: "read" | "read_file"): ExecutableTool<ReadInput> {
    return {
        definition: {
            name,
            description: 
                "Read a bounded UTF-8 text file inside the repository and return its SHA-256 hash.",
            inputSchema,
            outputSchema: name === "read" ? outputSchema : legacyOutputSchema,
            annotations: {
                title: name === "read" ? "Read repository file" : "Read file (W1 alias)",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },

        parse: parseReadInput,

        async execute(input, context) {
            const filePath = await resolveRepoPath(context.workspaceRoot, input.path);
            const bytes = await readFileBytes(filePath, {
                maxBytes: DEFAULT_TOOL_LIMITS.maxFileBytes
            });
            const fullContent = decodeUtf8Text(bytes);
            const lines = splitLinesPreservingEndings(fullContent);
            const totalLines = lines.length;

            if (
                input.startLine !== undefined && 
                (totalLines === 0 || input.startLine > totalLines) 
            ) {
                throw new ToolError(
                    "INVALID_RANGE",
                    "startLine is outside the file"
                );
            }
            if (
                input.endLine !== undefined && 
                (totalLines === 0 || input.endLine > totalLines)
            ) {
                throw new ToolError(
                    "INVALID_RANGE",
                    "endLine is outside the file"
                );
            }
            const startLine = totalLines === 0 ? 0 : (input.startLine ?? 1);
            const endLine = totalLines === 0 ? 0 : (input.endLine ?? totalLines);
            if (startLine > endLine) {
                throw new ToolError(
                    "INVALID_RANGE",
                    "startLine must not be greater than endLine"
                );
            }

            const content = totalLines === 0 ? "" : lines.slice(startLine - 1, endLine).join("");
            if (
                Buffer.byteLength(content, "utf-8") > DEFAULT_TOOL_LIMITS.maxOutputBytes
            ) {
                throw new ToolError(
                    "OUTPUT_TOO_LARGE",
                    `Read output exceeds the ${DEFAULT_TOOL_LIMITS.maxOutputBytes}-byte limit`,
                    { maxBytes: DEFAULT_TOOL_LIMITS.maxOutputBytes }
                );
            }

            if (name === "read_file") {
                return { path: input.path, content };
            }

            return {
                path: input.path,
                content,
                sha256: sha256Hex(bytes),
                byteLength: bytes.byteLength,
                startLine,
                endLine,
                totalLines
            }
        }
    }
}

export const readToolRegistration: RegisteredTool = registerTool(
    createReadTool("read")
);

export const readFileToolRegistration: RegisteredTool = registerTool(
    createReadTool("read_file")
);
