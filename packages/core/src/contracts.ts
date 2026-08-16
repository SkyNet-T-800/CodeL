export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive 
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface JsonObject {
    readonly [key: string]: JsonValue;
}  

export interface TaskSpec {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly title: string;
    readonly instruction: string;
    readonly workspace: {
        readonly root: string;
    }
    readonly constraints: {
        readonly allowedTools: readonly string[];
    }
    readonly budget: {
        readonly maxSteps: number;
        readonly tokenBudget?: number;
        readonly maxToolCalls?: number;
        readonly wallClockBudgetMs?: number;
    };
    readonly attribution?: {
        readonly baseSha: string;
        readonly fixtureVersion: string;
    };
}

export interface TokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly complete: boolean;
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    complete: false,
}

export interface RunBudget {
    readonly maxSteps: number;
    readonly tokenBudget: number;
    readonly maxToolCalls: number;
    readonly wallClockBudgetMs: number;
}

export interface ToolCall {
    readonly id: string;
    readonly name: string;
    readonly input: JsonObject;
}

export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
    readonly outputSchema?: JsonObject;
    readonly annotations?: JsonObject;
}

export interface AgentError {
    readonly code: string;
    readonly message: string;
    readonly phase?: "provider" | "tool" | "loop";
    readonly retryable?: boolean;
    readonly details?: JsonObject;
}

export type ToolExecutionResult = 
  | { readonly ok: true; readonly output: JsonValue}
  | { readonly ok: false; readonly error: AgentError};

export type AgentMessage = 
  | { readonly role: "user"; readonly content: string}
  | { readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
      readonly reasoningContent?: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly reasoningContent?: string;
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly result: ToolExecutionResult;
    }; 

export interface ProviderRequest {
    readonly task: TaskSpec;
    readonly systemPrompt?: string;
    readonly messages: readonly AgentMessage[];
    readonly tools: readonly ToolDefinition[];
}    

interface ModelResponseBase {
    readonly usage?: TokenUsage;
    readonly reasoningContent?: string;
}

export type ModelResponse =
    | (
        ModelResponseBase & {
            readonly kind: "tool_use";
            readonly calls: readonly ToolCall[];
            readonly text?: string;
        })
    | ( ModelResponseBase & {
        readonly kind: "end_turn";
        readonly text: string;
    });    

export type ModelStreamEvent = 
    | {
        readonly type: "text.delta";
        readonly delta: string;
      }   
    | {
        readonly type: "response.completed";
        readonly response: ModelResponse;
      };
      
export interface ModelDescriptor {
    readonly provider: string;
    readonly modelId: string;
    readonly modelRevision: string;
}  

export interface ModelAdapter {
    readonly name: string;
    readonly descriptor?: ModelDescriptor;
    complete(request: 
        ProviderRequest,
        signal?: AbortSignal
    ): Promise<ModelResponse>;
    stream?(
        request: ProviderRequest,
        signal: AbortSignal
    ): AsyncIterable<ModelStreamEvent>;
}   

export interface ToolExecutionContext {
    readonly workspaceRoot: string;
    readonly signal?: AbortSignal;
}

export interface ExecutableTool<TInput> {
    readonly definition: ToolDefinition;
    parse(input: JsonObject): TInput;
    execute(input: TInput, context: ToolExecutionContext): Promise<JsonValue>;
}

export interface RegisteredTool {
    readonly definition: ToolDefinition;
    invoke(
        input: JsonObject,
        context: ToolExecutionContext
    ): Promise<ToolExecutionResult>;
}

export interface AgentEventData {
    readonly "run.begin": {
        readonly taskId: string;
        readonly instruction: string;
    };
    readonly "step.begin": { readonly step: number};
    readonly "text.delta": {
        readonly step: number;
        readonly delta: string;
    };
    readonly "usage.recorded": {
        readonly step: number;
        readonly usage: TokenUsage;
        readonly cumulative: TokenUsage;
    };
    readonly "tool.call": {
        readonly step: number;
        readonly callId: string;
        readonly name: string;
        readonly input: JsonObject;
    };
    readonly "tool.result": {
        readonly step: number;
        readonly callId: string;
        readonly name: string;
        readonly result: ToolExecutionResult;
    };
    readonly "assistant.final": {
        readonly step: number;
        readonly text: string;
    };
    readonly "step.end": { 
        readonly step: number;
        readonly reason: "tool_use" | "end_turn" | "budget_exhausted" | "error";
    };
    readonly "run.end": {
        readonly status: "completed";
        readonly steps: number;
        readonly terminalReason?: "end_turn";
    };
    readonly "run.error": {
        readonly steps: number;
        readonly error: AgentError;
    };
    readonly "turn.interrupted": {
        readonly taskId: string;
        readonly instruction: string;
        readonly steps: number;
        readonly error: AgentError;
    }
}

export type AgentEventType = keyof AgentEventData;

interface EventEnvelope {
    readonly schemaVersion: 1;
    readonly runId: string;
    readonly seq: number;
}

export type AgentEvent = {
    readonly [Type in AgentEventType]: EventEnvelope & {
        readonly type: Type;
        readonly data: AgentEventData[Type];
    }
}[AgentEventType]

export interface EventSink {
    append(event: AgentEvent, signal?: AbortSignal): Promise<void>;
}

export interface AgentResumeState {
    readonly messages: readonly AgentMessage[];
    readonly usage: TokenUsage;
    readonly toolCallCount: number;
    readonly lastCompletedStep: number;
    readonly seenCallIds: readonly string[];
}

interface StateBase {
    readonly runId: string;
    readonly task: TaskSpec;
    readonly step: number;
    readonly messages: readonly AgentMessage[];
    readonly usage: TokenUsage;
    readonly toolCallCount: number;
    readonly terminalReason: string;
}

export type RunningAgentState = StateBase & {
    readonly status: "running";
}

export type CompletedAgentState = StateBase & {
    readonly status: "completed";
    readonly finalOutput: string;
}

export type FailedAgentState = StateBase & {
    readonly status: "failed";
    readonly error: AgentError;
}

export type InterruptedAgentState = StateBase & {
    readonly status: "interrupted";
    readonly error: AgentError;
}

export type TerminalAgentState = CompletedAgentState | FailedAgentState | InterruptedAgentState;

export type AgentState = RunningAgentState | TerminalAgentState;
