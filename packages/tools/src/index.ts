import { readFile } from "node:fs/promises";

import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  registerTool,
  type ExecutableTool,
  type JsonObject
} from "@repo-circuit/core";

interface ReadFileInput {
  readonly path: string;
}

const readFileTool: ExecutableTool<ReadFileInput> = {
  definition: {
    name: "read_file",
    description: "Read one UTF-8 text file relative to the task workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1}
      },
      required: ["path"],
      additionalProperties: false
    }
  },

  parse(input: JsonObject): ReadFileInput {
    const keys = Object.keys(input);
    if (
      keys.length !== 1 ||
      keys[0] !== "path" ||
      typeof input.path !== "string" ||
      input.path.trim().length === 0
    ) {
      throw new Error("read_file.path must be a non-empty string");
    }
    return { path: input.path };
  },

  async execute(input, context) {
    const workspaceRoot = resolve(context.workspaceRoot);
    const filePath = resolve(workspaceRoot, input.path);
    const relativePath = relative(workspaceRoot, filePath);
    const escapesWorkspace =
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath);

    if (escapesWorkspace) {
      throw new Error(`Path escapes task workspace: ${input.path}`);
    }

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (error) {
      throw new Error(`Failed to read file: ${input.path}`);
    }

    return { path: input.path, content };
  }
};

export const readFileToolRegistration = registerTool(readFileTool);

