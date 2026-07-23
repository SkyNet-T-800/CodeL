import type {
    AgentError,
    ExecutableTool,
    RegisteredTool
} from "./contracts.js";

function toAgentError(error: unknown): AgentError {
    if (error instanceof Error) {
        return { code: "tool_execution_failed", message: error.message };
    }
    return { code: "tool_execution_failed", message: String(error) };
}

export function registerTool<TInput>(tool: ExecutableTool<TInput>): RegisteredTool {
    return {
        definition: tool.definition,
        async invoke(input, context) {
            try {
                const parsedInput = tool.parse(input);
                const output = await tool.execute(parsedInput, context);
                return { ok: true, output };
            } catch (error) {
                return { ok: false, error: toAgentError(error) };
            }
        }
    }
}