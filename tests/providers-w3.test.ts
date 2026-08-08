import type {
    ModelStreamEvent,
    ProviderRequest,
    TokenUsage
} from "@repo-circuit/core";

import {
    FakeStreamingProvider,
    OpenAICompatibleProvider,
    OpenAICompatibleProviderError,
    ScriptedMockProvider
} from "@repo-circuit/providers";
import { describe, expect, it, vi } from "vitest";
import { compileFunction } from "vm";

const request: ProviderRequest = {
    task: {
        schemaVersion: 1,
        id: "provider-test",
        title: "Provider test",
        instruction: "Read one file.",
        workspace: { root: "." },
        constraints: {
            allowedTools: ["read_file"]
        },
        budget: { maxSteps: 4, tokenBudget: 1_000}
    },
    systemPrompt: "You are a coding agent.",
    messages: [{ role: "user", content: "Read README.md" }],
    tools: [
        {
            name: "read_file",
            description: "Read a UTF-8 file",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" }
                },
                required: ["path"]
            }
        }
    ]
};

async function collect(
  stream: AsyncIterable<ModelStreamEvent>
): Promise<ModelStreamEvent[]> {
    const events: ModelStreamEvent[] = [];
    for await (const event of stream) {
        events.push(event);
    }
    return events;
}

function sseResponse(events: readonly string[]): Response {
    const encoder = new TextEncoder();
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const event of events) {
                    controller.enqueue(encoder.encode(event));
                }
                controller.close();
            }
        }),
        {
            status: 200,
            headers: {
                "content-type": "text/event-stream"
            }
        }
    );
}

describe("FakeStreamingProvider", ()=> {
    it("emits configured deltas and seals configured usage", async () => {
        const usage: TokenUsage = {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
            complete: true
        };
        const provider = new FakeStreamingProvider({
            deltas: ["hel", "lo"],
            intervalMs: 0,
            usage,
            response: { kind: "end_turn", text: "hello" }
        });

        const events = await collect(
            provider.stream(request, new AbortController().signal)
        );

        expect(events).toEqual([
            { type: "text.delta", delta: "hel" },
            { type: "text.delta", delta: "lo" },
            {
                type: "response.completed",
                response: { kind: "end_turn", text: "hello", usage}
            }
        ]);

        expect(provider.requests).toEqual([request]);
    });

    it("stops an in-flight stream when its signal aborts", async () => {
        const provider = new FakeStreamingProvider({
            deltas: ["first", "second"],
            intervalMs: 10_000
        });
        const controller = new AbortController();
        const iterator = provider.stream(request, controller.signal)[
            Symbol.asyncIterator
        ]();

        await expect(iterator.next()).resolves.toMatchObject({
            value: { type: "text.delta", delta: "first" }
        });

        controller.abort(new Error("test abort"));
        await expect(iterator.next()).rejects.toThrow("test abort");
    });
});


describe("OpenAICompatibleProvider", () => {
    it("maps a non-streaming tool call and exact usage", async () => {
        let receivedInit: RequestInit | undefined;
        const fetch = vi.fn(async (_input, init?: RequestInit) => {
            receivedInit = init;
            return new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: null,
                                tool_calls: [
                                    {
                                        id: "call-1",
                                        type: "function",
                                        function: {
                                            name: "read_file",
                                            arguments: "{\"path\":\"README.md\"}"
                                        }
                                    }
                                ]
                            }
                        }
                    ],
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 4,
                        total_tokens: 16
                    }
                }),
                { status: 200}
            );
        });
        const provider = new OpenAICompatibleProvider({
            baseURL: "https://models.example.test/v1/",
            apiKey: "super-secret",
            model: "test-model",
            modelRevision: "test-model-2026-07-01",
            temperature: 0,
            topP: 1,
            fetch
        });
        const signal = new AbortController().signal;

        await expect(provider.complete(request, signal)).resolves.toEqual({
            kind: "tool_use",
            calls: [
                {
                    id: "call-1",
                    name: "read_file",
                    input: { path: "README.md" }
                }
            ],
            usage: {
                inputTokens: 12,
                outputTokens: 4,
                totalTokens: 16,
                complete: true
            }
        });

        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0]?.[0]).toBe(
            "https://models.example.test/v1/chat/completions"
        );
        expect(receivedInit?.signal).toBe(signal);
        expect(JSON.parse(String(receivedInit?.body))).toMatchObject({
            model: "test-model",
            temperature: 0,
            top_p: 1,
            stream: false,
            messages: [
                { role: "system", content: "You are a coding agent." },
                { role: "user", content: "Read README.md" }
            ]
        });
        expect(provider.descriptor).toEqual({
            provider: "openai-compatible",
            modelId: "test-model",
            modelRevision: "test-model-2026-07-01"
        });
        expect(JSON.stringify(provider)).not.toContain("super-secret");
    });

    it("parses fragmented SSE text and usage while passing the same signal", async () => {
        let receivedSignal: AbortSignal | null | undefined;
        const fetch = vi.fn(async (_input, init?: RequestInit) => {
            receivedSignal = init?.signal;
            return sseResponse([
                'data: {"choices":[{"delta":{"content":"hel"}}]}\r',
                '\n\r\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
                'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
                "data: [DONE]\n\n"
            ]);
        });
        const provider = new OpenAICompatibleProvider({
            endpoint: "https://models.example.test/chat/completions",
            model: "test-model",
            fetch
        });
        const signal = new AbortController().signal;

        const events = await collect(
            provider.stream(request, signal)
        );

        expect(receivedSignal).toBe(signal);
        expect(provider.descriptor.modelRevision).toBe("unknown");
        expect(events).toEqual([
            { type: "text.delta", delta: "hel" },
            { type: "text.delta", delta: "lo" },
            {
                type: "response.completed",
                response: {
                    kind: "end_turn",
                    text: "hello",
                    usage: {
                        inputTokens: 5,
                        outputTokens: 2,
                        totalTokens: 7,
                        complete: true
                    }
                }
            }
        ]);
    })

    it("rejects a clean EOF before the SSE completion marker", async () => {
        const fetch = vi.fn(async () =>
            sseResponse([
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            ])
        );
        const provider = new OpenAICompatibleProvider({
            model: "test-model",
            fetch
        });

        await expect(
            collect(provider.stream(request, new AbortController().signal))
        ).rejects.toMatchObject({
            code: "PROTOCOL_ERROR",
            message: "Provider event stream ended before the [DONE] marker"
        });
    });

    it("assembles fragmented streaming tool calls", async () => {
        const fetch = vi.fn(async () => 
            sseResponse([
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"README.md\\"}"}}]}}]}\n\n',
                "data: [DONE]\n\n"
            ])
        );
        const provider = new OpenAICompatibleProvider({
            model: "test-model",
            fetch
        });

        const events = await collect(
            provider.stream(request, new AbortController().signal)
        );

        expect(events).toEqual([
            {
                type: "response.completed",
                response: {
                    kind: "tool_use",
                    calls: [
                        {
                            id: "call-2",
                            name: "read_file",
                            input: { path: "README.md" }
                        }
                    ]
                }
            }
        ]);
    });

})


