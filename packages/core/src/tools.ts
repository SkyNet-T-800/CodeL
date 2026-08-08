import type {
    AgentError,
    ExecutableTool,
    RegisteredTool,
    JsonObject
} from "./contracts.js";
import { validateJsonSchema } from "./json-schema.js";
import { ToolError } from "./tool-error.js";

function toAgentError(error: unknown): AgentError {
  if (error instanceof ToolError) {
    if (error.details === undefined) {
      return { code: error.code, message: error.message };
    }
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }
  return {
    code: "TOOL_INTERNAL_ERROR",
    message: "Tool execution failed"
  };
}

function issuesDetails(
    issues: readonly { readonly path: string; readonly message: string}[]
): JsonObject {
    return {
        issues: issues.map(issue => ({
            path: issue.path,
            message: issue.message
        }))
    };
}

export function registerTool<TInput>(tool: ExecutableTool<TInput>): RegisteredTool {
    return {
        definition: tool.definition,
        async invoke(input, context) {
            try {
                context.signal?.throwIfAborted();
                const inputIssues = validateJsonSchema(tool.definition.inputSchema, input);
                if (inputIssues.length > 0) {
                    throw new ToolError(
                        "INVALID_TOOL_INPUT",
                        `Input does not match the ${tool.definition.name} tool schema`,
                        issuesDetails(inputIssues)
                    );
                }
                const parsedInput = tool.parse(input);
                const output = await tool.execute(parsedInput, context);
                context.signal?.throwIfAborted();
                if (tool.definition.outputSchema !== undefined) {
                    const outputIssues = validateJsonSchema(
                        tool.definition.outputSchema,
                        output
                    );
                    if (outputIssues.length > 0) {
                        throw new ToolError(
                            "INVALID_TOOL_OUTPUT",
                            `Output does not match the ${tool.definition.name} tool schema`,
                            issuesDetails(outputIssues)
                        );
                    }
                }
                return { ok: true, output };
            } catch (error) {
                if (context.signal?.aborted === true) {
                    throw context.signal.reason;
                }
                return { ok: false, error: toAgentError(error) };
            }
        }
    }
}