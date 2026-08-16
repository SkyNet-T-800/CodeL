import type {
    AgentMessage,
    JsonObject,
    ModelAdapter,
    ModelDescriptor,
    ModelResponse,
    ModelStreamEvent,
    ProviderRequest,
    TokenUsage,
    ToolCall
} from "@repo-circuit/core";

export type ProviderFetch = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>;

export interface OpenAICompatibleProviderOptions {
    readonly model: string;
    readonly modelRevision?: string;
    readonly providerName?: string;

    readonly endpoint?: string;
    readonly baseUrl?: string;

    readonly baseURL?: string;
    readonly apiKey?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly temperature?: number;
    readonly topP?: number;
    readonly thinkingType?: "enabled" | "disabled";
    readonly reasoningEffort?: "low" | "high" | "max";
    readonly fetch?: ProviderFetch;
}

export type OpenAICompatibleProviderErrorCode =
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "PROTOCOL_ERROR";

  
export class OpenAICompatibleProviderError extends Error {
    readonly code: OpenAICompatibleProviderErrorCode;
    readonly status: number | undefined;
    readonly retryable: boolean;

    constructor(code: OpenAICompatibleProviderErrorCode, message: string, options?: {
        readonly status?: number;
        readonly retryable?: boolean;
    }) {
        super(message);
        this.name = "OpenAICompatibleProviderError";
        this.code = code;
        this.status = options?.status;
        this.retryable = options?.retryable ?? false;
    }
}  

function protocolError(message: string): OpenAICompatibleProviderError {
    return new OpenAICompatibleProviderError("PROTOCOL_ERROR", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function firstInteger(
  record: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = nonNegativeInteger(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawInput = firstInteger(value, ["prompt_tokens", "input_tokens"]);
  const rawOutput = firstInteger(value, [
    "completion_tokens",
    "output_tokens"
  ]);
  const rawTotal = firstInteger(value, ["total_tokens"]);

  if (
    rawInput === undefined &&
    rawOutput === undefined &&
    rawTotal === undefined
  ) {
    return undefined;
  }

  let inputTokens = rawInput ?? 0;
  let outputTokens = rawOutput ?? 0;
  if (rawTotal !== undefined) {
    if (rawInput !== undefined && rawOutput === undefined) {
      outputTokens = Math.max(0, rawTotal - rawInput);
    } else if (rawInput === undefined && rawOutput !== undefined) {
      inputTokens = Math.max(0, rawTotal - rawOutput);
    } else if (rawInput === undefined && rawOutput === undefined) {
      outputTokens = rawTotal;
    }
  }

  const totalTokens = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    complete:
      rawInput !== undefined &&
      rawOutput !== undefined &&
      (rawTotal === undefined || rawTotal === totalTokens)
  };
}

function parseTextContent(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!isRecord(part)) {
          return "";
        }
        return typeof part.text === "string" ? part.text : "";
      })
      .join("");
  }
  throw protocolError("Provider returned unsupported message content");
}

function parseToolInput(value: unknown): JsonObject {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            throw protocolError("Provider returned invalid tool arguments JSON");
          }
        })()
      : value;

  if (!isRecord(parsed)) {
    throw protocolError("Provider tool arguments must be a JSON object");
  }
  return parsed as JsonObject;
}

function parseToolCall(value: unknown, index: number): ToolCall {
  if (!isRecord(value)) {
    throw protocolError(`Provider returned invalid tool call at index ${index}`);
  }
  const fn = value.function;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isRecord(fn) ||
    typeof fn.name !== "string" ||
    fn.name.length === 0
  ) {
    throw protocolError(`Provider returned incomplete tool call at index ${index}`);
  }

  return {
    id: value.id,
    name: fn.name,
    input: parseToolInput(fn.arguments)
  };
}

type ResponseWithoutUsage =
  | {
      readonly kind: "tool_use";
      readonly calls: readonly ToolCall[];
      readonly text?: string;
      readonly reasoningContent?: string;
    }
  | {
      readonly kind: "end_turn";
      readonly text: string;
      readonly reasoningContent?: string;
    };

function withUsage(
  response: ResponseWithoutUsage,
  usage: TokenUsage | undefined
): ModelResponse {
  return usage === undefined ? response : { ...response, usage };
}

function parseReasoningContent(
  value: unknown,
  context: "completion" | "stream"
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw protocolError(
      `Provider returned unsupported reasoning_content in ${context}`
    );
  }
  return value;
}

function sealCompletionPayload(value: unknown): ModelResponse {
    if (!isRecord(value) || !Array.isArray(value.choices)) {
        throw protocolError("Provider returned a malformed completion");
    }
    const choice = value.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) {
        throw protocolError("Provider completion has no assistant message");
    }
    const message = choice.message;
    const usage = parseUsage(value.usage);
    const reasoningContent = parseReasoningContent(
      message.reasoning_content,
      "completion"
    );
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const text = parseTextContent(message.content);
        return withUsage(
            {
                kind: "tool_use",
                calls: message.tool_calls.map(parseToolCall),
                ...(text.length === 0 ? {} : { text }),
                ...(reasoningContent === undefined ? {} : { reasoningContent })
            },
            usage
        );
    }

    return withUsage(
        {
            kind: "end_turn",
            text: parseTextContent(message.content),
            ...(reasoningContent === undefined ? {} : { reasoningContent })
        },
        usage
    );
}

interface PendingToolCall {
    readonly index: number;
    id: string;
    name: string;
    arguments: string;
}

function appendToolCallDeltas(
    value: unknown,
    pending: Map<number, PendingToolCall>
): void {
    if (!Array.isArray(value)) {
        return;
    }

    for (const [position, rawCall] of value.entries()) {
        if (!isRecord(rawCall)) {
            throw protocolError(`Provider streamed an invalid tool call`);
        }
        const index = nonNegativeInteger(rawCall.index) ?? position;
        const current = pending.get(index) ?? {
            index,
            id: "",
            name: "",
            arguments: ""
        };
        if (typeof rawCall.id === "string") {
            current.id += rawCall.id;
        }
        if (isRecord(rawCall.function)) {
            if (typeof rawCall.function.name === "string") {
                current.name += rawCall.function.name;
            }
            if (typeof rawCall.function.arguments === "string") {
                current.arguments += rawCall.function.arguments
            }
        }
        pending.set(index, current);
    }
}

function sealStreamResponse(
    text: string,
    reasoningContent: string | undefined,
    pending: Map<number, PendingToolCall>,
    usage: TokenUsage | undefined
): ModelResponse {
    if (pending.size === 0) {
        return withUsage(
          {
            kind: "end_turn",
            text,
            ...(reasoningContent === undefined ? {} : { reasoningContent })
          },
          usage
        );
    }

    const calls = [...pending.values()]
      .sort((left, right) => left.index - right.index)
      .map((call, index): ToolCall => {
        if (call.id.length === 0 || call.name.length === 0) {
            throw protocolError(
                `Provider streamed incomplete tool call at index ${index}`
            );
        }
        return {
            id: call.id,
            name: call.name,
            input: parseToolInput(call.arguments)
        };
      });
    return withUsage(
      {
        kind: "tool_use",
        calls,
        ...(text.length === 0 ? {} : { text }),
        ...(reasoningContent === undefined ? {} : { reasoningContent })
      },
      usage
    );
}

function serializeToolResult(message: Extract<AgentMessage, { role: "tool" }>) {
    return JSON.stringify(message.result);
}

function toChatMessage(message: AgentMessage): Record<string, unknown> {
    switch (message.role) {
        case "user":
          return { role: "user", content: message.content };
        case "assistant":
          if ("toolCalls" in message) {
            return {
              role: "assistant",  
              content: message.content,
              ...(message.reasoningContent === undefined
                ? {}
                : { reasoning_content: message.reasoningContent }),
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input)
                }
              }))
            };
          }
          return {
            role: "assistant",
            content: message.content,
            ...(message.reasoningContent === undefined
              ? {}
              : { reasoning_content: message.reasoningContent })
          };
        case "tool":
          return {
            role: "tool",
            tool_call_id: message.callId,
            content: serializeToolResult(message)
          };
      }
    throw new Error("Unsupported Agent message role");
}

function createBody(
    request: ProviderRequest,
    model: string,
    temperature: number | undefined,
    topP: number | undefined,
    thinkingType: "enabled" | "disabled" | undefined,
    reasoningEffort: "low" | "high" | "max" | undefined,
    stream: boolean
): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (request.systemPrompt !== undefined) {
        messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push(...request.messages.map(toChatMessage));

    return {
        model,
        messages,
        tools: request.tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema
            }
        })),
        ...(temperature === undefined ? {} : { temperature }),
        ...(topP === undefined ? {} : { top_p: topP }),
        ...(thinkingType === undefined
          ? {}
          : { thinking: { type: thinkingType } }),
        ...(reasoningEffort === undefined
          ? {}
          : { reasoning_effort: reasoningEffort }),
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {})
    };
}

async function readWithAbort(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
        const onAbort = (): void => {
            void reader.cancel(signal.reason);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        reader.read().then(
            (result) => {
                signal.removeEventListener("abort", onAbort);
                resolve(result);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });    
}

async function* readServerSentEvents(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal
): AsyncIterable<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    let reachedEnd = false;

    const consumeLine = (rawLine: string): string | undefined => {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) {
            if (dataLines.length === 0) {
                return undefined;
            }
            const event = dataLines.join("\n");
            dataLines = [];
            return event;
        }
        if (line === "data") {
            dataLines.push("");
        } else if (line.startsWith("data:")) {
            const data = line.slice(5);
            dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
        }
        return undefined;
    };

    try {
        while(true) {
            let item: ReadableStreamReadResult<Uint8Array>;
            try {
                item = await readWithAbort(reader, signal);
            } catch {
                if (signal.aborted) {
                    signal.throwIfAborted();
                }
                throw new OpenAICompatibleProviderError(
                    "NETWORK_ERROR",
                    "OpenAI-compatible event stream ended with a transport error",
                    { retryable: true }
                );
            }
            if (item.done) {
                reachedEnd = true;
                buffer += decoder.decode();
                break;
            }
            buffer += decoder.decode(item.value, { stream: true });

            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
                const event = consumeLine(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                if (event !== undefined) {
                    yield event;
                }
                newline = buffer.indexOf("\n");
            }
        }

        if (buffer.length > 0) {
            const event = consumeLine(buffer);
            if (event !== undefined) {
                yield event;
            }
        }
        if (dataLines.length > 0) {
            yield dataLines.join("\n");
        }
    } finally {
        if (!reachedEnd) {
            try {
                await reader.cancel();
            } catch {

            }
        }
        reader.releaseLock();
    }
}

export class OpenAICompatibleProvider implements ModelAdapter {
    readonly name = "openai-compatible";
    readonly descriptor: ModelDescriptor;
    readonly #endpoint: string;
    readonly #apiKey: string | undefined;
    readonly #headers: Readonly<Record<string, string>>;
    readonly #model: string;
    readonly #temperature: number | undefined;
    readonly #topP: number | undefined;
    readonly #thinkingType: "enabled" | "disabled" | undefined;
    readonly #reasoningEffort: "low" | "high" | "max" | undefined;
    readonly #fetch: ProviderFetch;

    constructor(options: OpenAICompatibleProviderOptions) {
        if (options.model.trim().length === 0) {
            throw new TypeError("OpenAI-compatible model must not be empty");
        }
        if (
            options.temperature !== undefined &&
            (!Number.isFinite(options.temperature) ||
              options.temperature < 0 ||
              options.temperature > 2)
        ){
            throw new TypeError("temperature must be between 0 and 2");
        }
        if (
            options.topP !== undefined &&
            (!Number.isFinite(options.topP) ||
                options.topP < 0 ||
                options.topP > 1)
        ) {
            throw new TypeError("topP must be between 0 and 1");
        }
        if (
            options.thinkingType !== undefined &&
            options.thinkingType !== "enabled" &&
            options.thinkingType !== "disabled"
        ) {
            throw new TypeError("thinkingType must be enabled or disabled");
        }
        if (
            options.reasoningEffort !== undefined &&
            options.reasoningEffort !== "low" &&
            options.reasoningEffort !== "high" &&
            options.reasoningEffort !== "max"
        ) {
            throw new TypeError("reasoningEffort must be low, high, or max");
        }
        if (
            options.baseUrl !== undefined &&
            options.baseURL !== undefined &&
            options.baseUrl !== options.baseURL
        ) {
            throw new TypeError("Specify only one of baseUrl or baseURL");
        }

        const baseUrl = 
          options.baseUrl ?? options.baseURL ?? "https://api.openai.com/v1";
          this.#endpoint =
            options.endpoint ?? `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
          this.#apiKey = options.apiKey;
          this.#headers = { ...(options.headers ?? {}) };
          this.#model = options.model;
          this.#temperature = options.temperature;
          this.#topP = options.topP;
          this.#thinkingType = options.thinkingType;
          this.#reasoningEffort = options.reasoningEffort;
          this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
          this.descriptor = {
            provider: options.providerName ?? "openai-compatible",
            modelId: options.model,
            modelRevision: options.modelRevision ?? "unknown"
          };  
    }

    async #post(
        request: ProviderRequest,
        stream: boolean,
        signal?: AbortSignal
    ): Promise<Response> {
        signal?.throwIfAborted();
        const headers = new Headers(this.#headers);
        headers.set("content-type", "application/json");
        headers.set("accept", stream ? "text/event-stream" : "application/json");
        if (this.#apiKey !== undefined && this.#apiKey.length > 0) {
            headers.set("authorization", `Bearer ${this.#apiKey}`);
        }

        let response: Response;
        try {
            response = await this.#fetch(this.#endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(
                    createBody(
                        request,
                        this.#model,
                        this.#temperature,
                        this.#topP,
                        this.#thinkingType,
                        this.#reasoningEffort,
                        stream
                    )
                ),
                ...(signal === undefined ? {} : { signal })
            });
        } catch {
            if (signal?.aborted === true) {
                signal.throwIfAborted();
            }
            throw new OpenAICompatibleProviderError(
                "NETWORK_ERROR",
                "OpenAI-compatible request failed before receiving a response",
                { retryable: true }
            );
        }

        if (!response.ok) {
            const status = response.status;
            throw new OpenAICompatibleProviderError(
                "HTTP_ERROR",
                `OpenAI-compatible request failed with status ${status}`,
                { 
                    status,
                    retryable:
                      status === 408 || status === 409 || status === 429 || status >= 500
                }
            );
        }
        return response;
    }

    async complete(
        request: ProviderRequest,
        signal?: AbortSignal
    ): Promise<ModelResponse> {
        const response = await this.#post(request, false, signal);
        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            throw protocolError("Provider returned invalid completion JSON");
        }
        return sealCompletionPayload(payload);
    }

    async *stream(
        request: ProviderRequest,
        signal: AbortSignal
    ): AsyncIterable<ModelStreamEvent> {
        const response = await this.#post(request, true, signal);
        if (response.body === null) {
            throw protocolError("Provider returned an empty stream");
        }

        let text = "";
        let reasoningContent: string | undefined;
        let usage: TokenUsage | undefined;
        let completed = false;
        const pending = new Map<number, PendingToolCall>();

        for await (const data of readServerSentEvents(response.body, signal)) {
            signal.throwIfAborted();
            if (data.trim() === "[DONE]") {
                completed = true;
                break;
            }

            let payload: unknown;
            try {
                payload = JSON.parse(data) as unknown;
            } catch {
                throw protocolError("Provider streamed invalid event JSON")
            }
            if (!isRecord(payload)) {
                throw protocolError("Provider streamed a malformed event");
            }
            if (payload.error !== undefined) {
                throw protocolError("Provider reported a streaming error");
            }

            usage = parseUsage(payload.usage) ?? usage;
            if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
                continue;
            }
            const choice = payload.choices[0];
            if (!isRecord(choice) || !isRecord(choice.delta)) {
                throw protocolError("Provider streamed a malformed choice");
            }

            const delta = parseTextContent(choice.delta.content);
            if (delta.length > 0) {
                text += delta;
                yield { type: "text.delta", delta };
            }
            const reasoningDelta = parseReasoningContent(
              choice.delta.reasoning_content,
              "stream"
            );
            if (reasoningDelta !== undefined) {
              reasoningContent = (reasoningContent ?? "") + reasoningDelta;
            }
            appendToolCallDeltas(choice.delta.tool_calls, pending);
        }

        signal.throwIfAborted();
        if (!completed) {
            throw protocolError("Provider event stream ended before the [DONE] marker");
        }
        yield {
            type: "response.completed",
            response: sealStreamResponse(
              text,
              reasoningContent,
              pending,
              usage
            )
        };
    }
}

