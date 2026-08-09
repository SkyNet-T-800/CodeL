import type {
    AgentError,
    AgentEvent,
    EventSink,
    ModelAdapter,
    ModelResponse,
    ProviderRequest,
    RegisteredTool,
    RunBudget,
    RunningAgentState,
    TaskSpec,
    TerminalAgentState,
    TokenUsage,
    ToolExecutionResult,
    Verifier
} from "./contracts.js"

const DEFAULT_TOKEN_BUDGET = 100_000;
const DEFAULT_MAX_TOOL_CALLS = 64;
const DEFAULT_WALL_CLOCK_BUDGET_MS = 5 * 60_000;

export interface RunAgentOptions {
    readonly runId: string;
    readonly task: TaskSpec;
    readonly workspaceRoot: string;
    readonly provider: ModelAdapter;
    readonly tools: readonly RegisteredTool[];
    readonly events: EventSink;
    readonly verifier?: Verifier;
    readonly signal?: AbortSignal;
    readonly systemPrompt?: string;
    readonly budget?: Partial<RunBudget>;
}

class LoopFailure extends Error {
    readonly agentError: AgentError;

    constructor(agentError: AgentError) {
        super(agentError.message);
        this.name = "LoopFailure";
        this.agentError = agentError;
    }
}

function loopFailure(
    code: string,
    message: string,
    phase: NonNullable<AgentError["phase"]>,
    details?: AgentError["details"]
): LoopFailure {
    return new LoopFailure({
        code,
        message,
        phase,
        retryable: false,
        ...(details === undefined ? {} : { details: details })
    });
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

export function resolveRunBudget(
  task: TaskSpec,
  override: Partial<RunBudget> = {}
): RunBudget {
  return {
    maxSteps: positiveInteger(
      override.maxSteps ?? task.budget.maxSteps,
      "maxSteps"
    ),
    tokenBudget: positiveInteger(
      override.tokenBudget ??
        task.budget.tokenBudget ??
        DEFAULT_TOKEN_BUDGET,
      "tokenBudget"
    ),
    maxToolCalls: positiveInteger(
      override.maxToolCalls ??
        task.budget.maxToolCalls ??
        DEFAULT_MAX_TOOL_CALLS,
      "maxToolCalls"
    ),
    wallClockBudgetMs: positiveInteger(
      override.wallClockBudgetMs ??
        task.budget.wallClockBudgetMs ??
        DEFAULT_WALL_CLOCK_BUDGET_MS,
      "wallClockBudgetMs"
    )
  };
}

function emptyUsage(complete: boolean): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    complete
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
    return {
        inputTokens: left.inputTokens + right.inputTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        totalTokens: left.totalTokens + right.totalTokens,
        complete: left.complete && right.complete
    }
}

function validateUsage(usage: TokenUsage): void {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0 ||
    usage.totalTokens < 0 ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    throw loopFailure(
      "PROVIDER_PROTOCOL_ERROR",
      "Provider returned invalid token usage",
      "provider"
    );
  }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function abortable<T>(
    operation: Promise<T>,
    signal: AbortSignal
): Promise<T> {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true});
        operation.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        )
    });
}

async function appendBeforeDeadline(
    events: EventSink,
    event: AgentEvent,
    signal: AbortSignal
): Promise<void> {
    signal.throwIfAborted();
    await abortable(events.append(event, signal), signal);
}

async function collectProviderResponse(
    provider: ModelAdapter,
    request: ProviderRequest,
    signal: AbortSignal,
    onDelta: (delta: string) => Promise<void>
): Promise<ModelResponse> {
    if (provider.stream === undefined) {
        return await abortable(provider.complete(request, signal), signal);
    }
    const iterator = provider.stream(request, signal)[Symbol.asyncIterator]();
    let completed: ModelResponse | undefined;
    try {
        while(true) {
            const item = await abortable(iterator.next(), signal);
            if (item.done) {
                break;
            }
            if (item.value.type === "text.delta") {
                await onDelta(item.value.delta);
                continue;
            }
            if (completed !== undefined) {
                throw loopFailure(
                    "PROVIDER_PROTOCOL_ERROR",
                    "Provider stream emitted more than one completed response",
                    "provider"
                );
            }
            completed = item.value.response;
        }
    } finally{
        if (signal.aborted) {
            void iterator.return?.();
        }
    }

    if (completed === undefined) {
        throw loopFailure(
            "PROVIDER_STREAM_INCOMPLETE",
            "Provider stream ended without a completed response",
            "provider"
        );
    }
    return completed;
}

function interruptedError(
    externalSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal
): AgentError {
    if (externalSignal?.aborted === true) {
        return {
            code: "RUN_ABORTED",
            message: `Run was aborted ${errorMessage(externalSignal.reason)}`,
            phase: "loop",
            retryable: false
        };
    }
    if (timeoutSignal.aborted) {
        return {
            code: "WALL_CLOCK_BUDGET_EXHAUSTED",
            message: "Run exceeded its wall-clock budget",
            phase: "loop",
            retryable: false
        }
    }
    return {
        code: "RUN_ABORTED",
        message: "Run was aborted",
        phase: "loop",
        retryable: false
    };
}


export async function runAgent(options: RunAgentOptions): Promise<TerminalAgentState> {
    const { runId, task, workspaceRoot, provider, tools, events, verifier } = options;
    const budget = resolveRunBudget(task, options.budget);
    const timeoutSignal = AbortSignal.timeout(budget.wallClockBudgetMs);
    const signal = AbortSignal.any(
        options.signal === undefined
        ? [timeoutSignal]
        : [options.signal, timeoutSignal]
    );

    let seq = 0;
    let stepOpen = false;
    let state: RunningAgentState = {
        runId,
        task,
        step: 0,
        messages: [{ role: "user", content: task.instruction }],
        status: "running",
        usage: emptyUsage(true),
        toolCallCount: 0,
        terminalReason: "running",
        verification: undefined
    };

    const nextEnvelope = () => ({
        schemaVersion: 1 as const,
        runId,
        seq: seq + 1
    });

    const appendEvent = async (
        event: AgentEvent,
        eventSignal?: AbortSignal
    ): Promise<void> => {
        if (eventSignal === undefined) {
            await events.append(event);
        } else {
            await appendBeforeDeadline(events, event, eventSignal);
        }
        seq = event.seq;
    };

    const toolsByName = new Map(
        tools.map((tool) => [tool.definition.name, tool])
    );

    const visibleTools = tools
        .filter((tool) => 
            task.constraints.allowedTools.includes(tool.definition.name)
        )
        .map((tool) => tool.definition);
    
    const seenCallIds = new Set<string>();

    try {
        await appendEvent(
            {
                ...nextEnvelope(),
                type: "run.begin",
                data: {
                    taskId: task.id,
                    instruction: task.instruction
                }
            },
            signal
        );

        for (let step = 1; step <= budget.maxSteps; step += 1) {
            signal.throwIfAborted();
            if (state.usage.totalTokens >= budget.tokenBudget) {
                throw loopFailure(
                    "TOKEN_BUDGET_EXHAUSTED",
                    `Run reached its ${budget.tokenBudget}-token budget`,
                    "loop",
                    {
                        tokenBudget: budget.tokenBudget,
                        totalTokens: state.usage.totalTokens
                    }
                );
            }

            state = { ...state, step };
            await appendEvent(
                {
                    ...nextEnvelope(),
                    type: "step.begin",
                    data: {
                        step
                    }
                },
                signal
            );
            stepOpen = true;

            const request: ProviderRequest = {
                task,
                ...(options.systemPrompt === undefined
                    ? {}
                    : { systemPrompt: options.systemPrompt }
                ),
                messages: state.messages,
                tools: visibleTools
            };

            let response: ModelResponse;
            try {
                response = await collectProviderResponse(
                    provider,
                    request,
                    signal,
                    async (delta) => {
                        signal.throwIfAborted();
                        await appendEvent(
                            {
                                ...nextEnvelope(),
                                type: "text.delta",
                                data: { step, delta }
                            },
                            signal
                        );
                    }
                );
            } catch (error) {
                state = {
                    ...state,
                    usage: {
                        ...state.usage,
                        complete: false
                    }
                };
                if (signal.aborted) {
                    throw error;
                }
                if (error instanceof LoopFailure) {
                    throw error;
                }
                throw loopFailure(
                    "PROVIDER_FAILED",
                    errorMessage(error),
                    "provider"
                );
            }

            if (response.usage !== undefined) {
                validateUsage(response.usage);
                const cumulative = addUsage(state.usage, response.usage);
                state = { ...state, usage: cumulative };
                await appendEvent(
                    {
                        ...nextEnvelope(),
                        type: "usage.recorded",
                        data: {
                            step,
                            usage: response.usage,
                            cumulative
                        }
                    },
                    signal
                );
            } else {
                state = {
                    ...state,
                    usage: {
                        ...state.usage,
                        complete: false
                    }
                };
            }

            if (response.kind === "end_turn") {
                state = {
                    ...state,
                    messages: [
                        ...state.messages,
                        {
                            role: "assistant",
                            content: response.text,
                            ...(response.reasoningContent === undefined
                                ? {}
                                : { reasoningContent: response.reasoningContent })
                        }
                    ]
                };
                await appendEvent(
                    {
                        ...nextEnvelope(),
                        type: "assistant.final",
                        data: { step, text: response.text }
                    },
                    signal
                );

                if (verifier === undefined) {
                    await appendEvent(
                        {
                            ...nextEnvelope(),
                            type: "step.end",
                            data: { step, reason: "end_turn" }
                        },
                        signal
                    );
                    stepOpen = false;
                    await appendEvent({
                        ...nextEnvelope(),
                        type: "run.end",
                        data: { status: "completed", steps: step }
                    });
                    return {
                        ...state,
                        status: "completed",
                        terminalReason: "end_turn",
                        finalOutput: response.text
                    };
                }

                signal.throwIfAborted();
                await appendEvent(
                    {
                        ...nextEnvelope(),
                        type: "verify.begin",
                        data: {
                            step,
                            verifierVersion: verifier.version
                        }
                    },
                    signal
                );

                let verification;
                try {
                    verification = await verifier.verify({
                        task,
                        workspaceRoot,
                        signal
                    });
                } catch(error) {
                    if (signal.aborted) {
                        throw error;
                    }
                    throw loopFailure(
                        "VERIFIER_FAILED",
                        errorMessage(error),
                        "verifier"
                    );
                }

                state = {
                    ...state,
                    verification,
                    messages: [
                        ...state.messages,
                        {
                            role: "verifier",
                            result: verification
                        }
                    ]
                };
                await appendEvent(
                    {
                        ...nextEnvelope(),
                        type: "verify.result",
                        data: {
                            step,
                            result: verification
                        }
                    },
                    signal
                );

                if (verification.passed) {
                    await appendEvent(
                        {
                            ...nextEnvelope(),
                            type: "step.end",
                            data: { step, reason: "end_turn" }
                        },
                        signal
                    );
                    stepOpen = false;
                    await appendEvent({
                        ...nextEnvelope(),
                        type: "run.end",
                        data: {
                            status: "completed",
                            steps: step,
                            terminalReason: "verified"
                        }
                    });
                    return {
                        ...state,
                        status: "completed",
                        terminalReason: "verified",
                        finalOutput: response.text
                    };
                }

                await appendEvent(
                    {
                        ...nextEnvelope(),
                        type: "step.end",
                        data: { step, reason: "verification_failed" }
                    },
                    signal
                );
                stepOpen = false;
                continue;
            }

            if (response.calls.length === 0) {
                throw loopFailure(
                    "INVALID_PROVIDER_RESPONSE",
                    "tool_use must contain at least one tool call",
                    "provider"
                );
            }

            state = {
                ...state,
                messages: [
                    ...state.messages,
                    {
                        role: "assistant",
                        content: response.text ?? "",
                        toolCalls: response.calls,
                        ...(response.reasoningContent === undefined
                            ? {}
                            : { reasoningContent: response.reasoningContent })
                    }
                ]
            };

            for(const call of response.calls) {
                signal.throwIfAborted();
                if (state.toolCallCount >= budget.maxToolCalls) {
                    throw loopFailure(
                        "TOOL_CALL_BUDGET_EXHAUSTED",
                        `Run reached its ${budget.maxToolCalls}-tool-call budget`,
                        "loop",
                        {
                            maxToolCalls: budget.maxToolCalls,
                            toolCallCount: state.toolCallCount
                        }
                    );
                }

                state = {
                    ...state,
                    toolCallCount: state.toolCallCount + 1
                };

                await appendEvent(
                    {
                        ...nextEnvelope(),
                        type: "tool.call",
                        data: {
                            step,
                            callId: call.id,
                            name: call.name,
                            input: call.input
                        }
                    },
                    signal
                );

                let result: ToolExecutionResult;
                if (seenCallIds.has(call.id)) {
                    result = {
                        ok: false,
                        error: {
                            code: "DUPLICATE_TOOL_CALL_ID",
                            message: `Tool call id was already used: ${call.id}`,
                            phase: "tool",
                            retryable: false
                        }
                    };
                } else {
                    seenCallIds.add(call.id);
                    const tool = toolsByName.get(call.name);
                    if (!task.constraints.allowedTools.includes(call.name)) {
                        result = {
                            ok: false,
                            error: {
                                code: "TOOL_NOT_ALLOWED",
                                message: `TaskSpec does not allow tool: ${call.name}`,
                                phase: "tool",
                                retryable: false
                            }
                        };
                    } else if (tool === undefined) {
                        result = {
                            ok: false,
                            error: {
                                code: "TOOL_NOT_FOUND",
                                message: `No registered tool named: ${call.name}`,
                                phase: "tool",
                                retryable: false
                            }
                        };
                    } else {
                        try {
                            result = await tool.invoke(call.input, {
                                workspaceRoot,
                                signal
                            });
                        } catch (error) {
                            if (signal.aborted) {
                                throw error;
                            }
                            result = {
                                ok: false,
                                error: {
                                    code: "TOOL_INVOCATION_FAILED",
                                    message: `Registered tool threw: ${call.name}`,
                                    phase: "tool",
                                    retryable: false
                                }
                            };
                        }
                    }
                }

                await appendEvent(
                    {
                        ...nextEnvelope(),
                        type: "tool.result",
                        data: {
                            step,
                            callId: call.id,
                            name: call.name,
                            result
                        }
                    },
                    signal
                );

                state = {
                    ...state,
                    messages: [
                        ...state.messages,
                        {
                            role: "tool",
                            callId: call.id,
                            name: call.name,
                            result
                        }
                    ]
                };
            }

            await appendEvent(
                {
                    ...nextEnvelope(),
                    type: "step.end",
                    data: { step, reason: "tool_use" }
                },
                signal
            );
            stepOpen = false;
        }

        throw loopFailure(
            "STEP_BUDGET_EXHAUSTED",
            `Run did not finish within ${budget.maxSteps} steps`,
            "loop",
            { maxSteps: budget.maxSteps }
        );
    } catch (error) {
        if (signal.aborted) {
            const agentError = interruptedError(options.signal, timeoutSignal);
            await appendEvent({
                ...nextEnvelope(),
                type: "turn.interrupted",
                data: {
                    steps: state.step,
                    error: agentError
                }
            });
            return {
                ...state,
                status: "interrupted",
                terminalReason: 
                  agentError.code === "WALL_CLOCK_BUDGET_EXHAUSTED"
                    ? "wall_clock_budget_exhausted"
                    : "aborted",
                error: agentError    
            };
        }

        const agentError = 
          error instanceof LoopFailure
            ? error.agentError
            : {
                code: "LOOP_FAILED",
                message: errorMessage(error),
                phase: "loop" as const,
                retryable: false
            };

        if (stepOpen) {
            await appendEvent({
                ...nextEnvelope(),
                type: "step.end",
                data: {
                    step: state.step,
                    reason: agentError.code.includes("BUDGET")
                      ? "budget_exhausted"
                      : "error"
                }
            });
        }    

        await appendEvent({
            ...nextEnvelope(),
            type: "run.error",
            data: {
                error: agentError,
                steps: state.step
            }
        });
        return {
            ...state,
            status: "failed",
            terminalReason: agentError.code.toLowerCase(),
            error: agentError    
        };

    }
}
