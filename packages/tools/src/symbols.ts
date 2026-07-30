import { extname } from "node:path";
import { stat } from "node:fs/promises";

import {
    registerTool,
    ToolError,
    type ExecutableTool
} from "@repo-circuit/core";

import { DEFAULT_TOOL_LIMITS } from "./limits.js";
import { resolveRepoPath } from "./path-safety.js";
import { readTextFile } from "./text-file.js";
import { walkRepository } from "./walk.js";

interface SymbolInput {
    readonly path: string;
    readonly query: string | undefined;
    readonly maxResults: number;
}

type SymbolKind = 
    | "class"
    | "enum"
    | "function"
    | "interface"
    | "type"
    | "variable";

const SUPPORTED_EXTENSIONS = new Set([
    ".cjs",
    ".js",
    ".jsx",
    ".mjs",
    ".ts",
    ".tsx"
]);   

const DECLARATION_PATTERNS: readonly {
    readonly kind: SymbolKind;
    readonly pattern: RegExp;
}[] = [
  {
    kind: "function",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
  },
  {
    kind: "class",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
  },
  {
    kind: "interface",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/
  },
  {
    kind: "type",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/
  },
  {
    kind: "enum",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/
  },
  {
    kind: "variable",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
  }
];

const symbolsTool: ExecutableTool<SymbolInput> = {
    definition: {
        name: "symbols",
        description: "Extract deterministic top-level JavaScript and TypeScript declarations without loading project plugins.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1, maxLength: 4_096 },
                query: { type: "string", minLength: 1, maxLength: 256 },
                maxResults: {
                    type: "integer",
                    minimum: 1,
                    maximum: DEFAULT_TOOL_LIMITS.maxSearchMatches
                }
            },
            additionalProperties: false,
        },
        outputSchema: {
            type: "object",
            properties: {
                symbols: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            kind: {
                                type: "string",
                                enum: [
                                    "class",
                                    "enum",
                                    "function",
                                    "interface",
                                    "type",
                                    "variable"
                                ]
                            },
                            path : { type: "string" },
                            line: { type: "integer", minimum: 1 },
                            column: { type: "integer", minimum: 1 },
                            signature: { type: "string" }
                        },
                        required: ["name", "kind", "path", "line", "column", "signature"],
                        additionalProperties: false,
                    }
                },
                filesScanned: { type: "integer", minimum: 1 },
                skippedUnsupported: { type: "integer", minimum: 0 },
                truncated: { type: "boolean" },
                parser: { type: "string" , enum: ["w2-declaration-scanner"]}
            },
            required: ["symbols", "filesScanned", "skippedUnsupported", "truncated", "parser"],
            additionalProperties: false,
        },
        annotations: {
            title: "List source symbols",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    },

    parse(input) {
        return {
            path: typeof input.path === "string" ? input.path : ".",
            query: typeof input.query === "string" ? input.query : undefined,
            maxResults:
                typeof input.maxResults === "number"
                ? input.maxResults
                : Math.min(200, DEFAULT_TOOL_LIMITS.maxSearchMatches)
        };
    },

    async execute(input, context) {
        const [realRoot, startPath] = await Promise.all(
            [
                resolveRepoPath(context.workspaceRoot, "."),
                resolveRepoPath(context.workspaceRoot, input.path)
            ]
        );
        const startIsFile = (await stat(startPath)).isFile();
        if (startIsFile && !SUPPORTED_EXTENSIONS.has(extname(startPath))) {
            throw new ToolError(
                "UNSUPPORTED_FILE_TYPE",
                "symbols supports JavaScript and TypeScript files only"
            );
        }

        const walked = await walkRepository(realRoot, startPath, {
            maxDepth: 32,
            maxEntries: DEFAULT_TOOL_LIMITS.maxTreeEntries
        });
        const symbols: {
            name: string;
            kind: SymbolKind;
            path: string;
            line: number;
            column: number;
            signature: string;
        }[] = [];
        let filesScanned = 0;
        let skippedUnsupported = 0;
        let truncated = walked.truncated;
        const normalizeQuery = input.query?.toLocaleLowerCase("en-US");

        outer: for (const entry of walked.entries) {
            if (entry.type !== "file") {
                continue;
            }
            if (!SUPPORTED_EXTENSIONS.has(extname(entry.path).toLowerCase())) {
                skippedUnsupported += 1;
                continue;
            }

            const { content } = await readTextFile(entry.absolutePath, {
                maxBytes: DEFAULT_TOOL_LIMITS.maxFileBytes
            });

            filesScanned += 1;
            const lines = content.split(/\r\n|\n|\r/);

            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                const line = lines[lineIndex] ?? "";
                for (const declaration of DECLARATION_PATTERNS) {
                    const match = declaration.pattern.exec(line);
                    const name = match?.[1];
                    if (name === undefined) {
                        continue;
                    }
                    if (normalizeQuery !== undefined && 
                        !name.toLocaleLowerCase("en-US").includes(normalizeQuery)
                    ) {
                        break;
                    }
                    if (symbols.length >= input.maxResults) {
                        truncated = true;
                        break outer;
                    }
                    symbols.push({
                        name,
                        kind: declaration.kind,
                        path: entry.path,
                        line: lineIndex + 1,
                        column: line.indexOf(name) + 1,
                        signature:
                            line.length <= 240 ? line.trim() : `${line.trim().slice(0, 239)}…`
                    });
                    break;
                }
            }
        }

        const output = {
            symbols,
            filesScanned,
            skippedUnsupported,
            truncated,
            parser: "w2-declaration-scanner"
        };

        if (Buffer.byteLength(JSON.stringify(output), "utf8") > DEFAULT_TOOL_LIMITS.maxOutputBytes) {
            throw new ToolError(
                "OUTPUT_TOO_LARGE",
                "Symbol output exceeds the configured byte limit"
            );
        }
        return output;
    }
};

export const symbolsToolRegistration = registerTool(symbolsTool);


