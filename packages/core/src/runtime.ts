import type {
    AgentError,
    EventSink,
    ModelAdapter,
    RegisteredTool,
    RunningAgentState,
    TaskSpec,
    TerminalAgentState,
    ToolExecutionResult
} from "./contracts.js"

export interface RunAgentOptions {
    readonly runId: string;
    readonly task: TaskSpec;
    readonly workspaceRoot: string;
    readonly provider: ModelAdapter;
    readonly tools: readonly RegisteredTool[];
    readonly events: EventSink;
}

export async function runAgent(options: RunAgentOptions): Promise<TerminalAgentState> {
    const { runId, task, workspaceRoot, provider, tools, events } = options;
    let seq = 0;
    let state: RunningAgentState = {
        runId,
        task,
        step: 0,
        messages: [{ role: "user", content: task.instruction }],
        status: "running",
    }

    const nextEnvelope = () => ({
        schemaVersion: 1 as const,
        runId,
        seq: ++seq
    });

    const toolsByName = new Map(tools.map(tool => [tool.definition.name, tool]));
    const visibleTools = tools
        .filter(tool => task.constraints.allowedTools.includes(tool.definition.name))
        .map((tool) => tool.definition);

    await events.append(
        {
            ...nextEnvelope(),
            type: "run.begin",
            data: {
                taskId: task.id,
                instruction: task.instruction,
            }
        }
    );
    
    for (let step = 1; step <= task.budget.maxSteps; step += 1) {
        state = { ...state, step };
        await events.append({
            ...nextEnvelope(),
            type: "step.begin",
            data: { step },
        });

        let response;
        try {
            response = await provider.complete({
                task,
                messages: state.messages,
                tools: visibleTools,
            });
        } catch (error) {
            const agentError: AgentError = {
                code: "provider_failed",
                message: error instanceof Error ? error.message : String(error)
            };
            await events.append(
                {
                    ...nextEnvelope(),
                    type: "step.end",
                    data: { step, reason: "error" }
                }
            );
            await events.append({
                ...nextEnvelope(),
                type: "run.error",
                data: { error: agentError, steps: step},
            });
            return {
                ...state,
                status: "failed",
                error: agentError,
            };
        }

        if (response.kind === "end_turn") {
            state = {
                ...state,
                messages: [
                    ...state.messages,
                    { role: "assistant", content: response.text },
                ]
            };
            await events.append({
                ...nextEnvelope(),
                type: "assistant.final",
                data: { step, text: response.text },
            });
            await events.append({
                ...nextEnvelope(),
                type: "step.end",
                data: { step, reason: "end_turn" },
            });
            await events.append({
                ...nextEnvelope(),
                type: "run.end",
                data: { status: "completed", steps: step },
            });
            return {
                ...state,
                status: "completed",
                finalOutput: response.text,
            };
        }

        if (response.calls.length === 0) {
            const agentError: AgentError = {
                code: "invalid_provider_response",
                message: "tool_use must contain at least one tool call"
            };
            await events.append({
                ...nextEnvelope(),
                type: "step.end",
                data: { step, reason: "error" }
            });
            await events.append({
                ...nextEnvelope(),
                type: "run.error",
                data: { error: agentError, steps: step }
            });
            return {
                ...state,
                status: "failed",
                error: agentError
            };
        }

        state = {
            ...state,
            messages: [
                ...state.messages,
                { role: "assistant", content: "", toolCalls: response.calls },
            ]
        };

        for (const call of response.calls) {
            await events.append(
                {
                    ...nextEnvelope(),
                    type: "tool.call",
                    data: {
                        step,
                        callId: call.id,
                        name: call.name,
                        input: call.input
                    }
                }
            );

            let result: ToolExecutionResult;
            const tool = toolsByName.get(call.name);
            if (!task.constraints.allowedTools.includes(call.name)) {
                result = {
                    ok: false,
                    error: {
                        code: "tool_not_allowed",
                        message: `Tool is not allowed By TaskSpec ${call.name}`
                    }
                };
            } else if (tool == undefined) {
                result = {
                    ok: false,
                    error: {
                        code: "tool_not_found",
                        message: `No registered tool named: ${call.name}`
                    }
                };
            } else {
                try {
                    result = await tool.invoke(call.input, { workspaceRoot });
                } catch (error) {
                    result = {
                        ok: false,
                        error: {
                            code: "tool_invocation_failed",
                            message: `Registered tool rejected: ${call.name}`
                        }
                    };
                }
            }

            await events.append(
                {
                    ...nextEnvelope(),
                    type: "tool.result",
                    data: {
                        step,
                        callId: call.id,
                        name: call.name,
                        result
                    }
                }
            );

            state = {
                ...state,
                messages: [
                    ...state.messages,
                    { role: "tool", callId: call.id, name: call.name, result }
                ]
            };
        }

        await events.append({
            ...nextEnvelope(),
            type: "step.end",
            data: { step, reason: "tool_use"}
        });
    }

    const error: AgentError = {
        code: "budget_exhausted",
        message: `Run did not finish within ${task.budget.maxSteps} steps`
    }

    await events.append({
        ...nextEnvelope(),
        type: "run.error",
        data: { error, steps: task.budget.maxSteps }
    });
    return {
        ...state,
        status: "failed",
        error
    };
}
