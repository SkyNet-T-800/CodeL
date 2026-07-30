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
    }
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
    readonly details?: JsonObject;
}

export type ToolExecutionResult = 
  | { readonly ok: true; readonly output: JsonValue}
  | { readonly ok: false; readonly error: AgentError}



export type AgentMessage = 
  | { readonly role: "user"; readonly content: string}
  | { readonly role: "assistant";
      readonly content: "";
      readonly toolCalls: readonly ToolCall[];
    }  
  | { readonly role: "assistant"; readonly content: string}  
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly result: ToolExecutionResult;
    };

export interface ProviderRequest {
    readonly task: TaskSpec;
    readonly messages: readonly AgentMessage[];
    readonly tools: readonly ToolDefinition[];
}    

export type ModelResponse = 
  | { readonly kind: "tool_use"; readonly calls: readonly ToolCall[];}
  | { readonly kind: "end_turn"; readonly text: string;}



export interface ModelAdapter {
    readonly name: string;
    complete(request: ProviderRequest): Promise<ModelResponse>;
}   

export interface ToolExecutionContext {
    readonly workspaceRoot: string;
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
        readonly reason: "tool_use" | "end_turn" | "error";
    };
    readonly "run.end": {
        readonly status: "completed";
        readonly steps: number;
    };
    readonly "run.error": {
        readonly steps: number;
        readonly error: AgentError;
    };
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
    append(event: AgentEvent): Promise<void>;
}

interface StateBase {
    readonly runId: string;
    readonly task: TaskSpec;
    readonly step: number;
    readonly messages: readonly AgentMessage[];
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

export type TerminalAgentState = CompletedAgentState | FailedAgentState;

export type AgentState = RunningAgentState | TerminalAgentState;

