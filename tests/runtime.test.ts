import {
    registerTool,
    runAgent,
    type AgentEvent,
    type EventSink,
    type ModelAdapter,
    type ModelResponse,
    type ProviderRequest,
    type TaskSpec
} from "@repo-circuit/core";
import { describe, expect, it } from "vitest";

class MemoryEventSink implements EventSink {
    readonly events: AgentEvent[] = [];

    async append(event: AgentEvent): Promise<void> {
        this.events.push(event);
    }
}

class QueueProvider implements ModelAdapter {
    readonly name = "w3-queue";
    readonly requests: ProviderRequest[] = [];
    readonly #responses: ModelResponse[];

    constructor(responses: readonly ModelResponse[]) {
        this.#responses = [...responses];
    }

    async complete(
        request: ProviderRequest,
        signal?: AbortSignal): Promise<ModelResponse> {
            signal?.throwIfAborted();
            this.requests.push(request);
            const response = this.#responses.shift();
            if (response === undefined) {
                throw new Error("response queue exhausted");
            }
            return response;
        }
}

function task(overrrides: Partial<TaskSpec["budget"]> = {}): TaskSpec {
    return {
        schemaVersion: 1,
        id: "w3-runtime",
        title: "W3 runtime",
        instruction: "Use the echo tool, then finish.",
        workspace: { root: "." },
        constraints: { allowedTools: ["echo"] },
        budget: {
            maxSteps: 4,
            tokenBudget: 1_000,
            maxToolCalls: 4,
            wallClockBudgetMs: 2_000,
            ...overrrides
        }
    };
}

function usage(inputTokens = 10, outputTokens = 5) {
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        complete: true
    }
}

function echoTool(counter: { value: number }) {
    return registerTool({
        definition: {
            name: "echo",
            description: "Echo a string",
            inputSchema: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    }
                },
                required: ["text"],
                additionalProperties: false
            }
        },
        parse(input) {
            return { text: String(input.text) };
        },
        async execute(input) {
            counter.value += 1;
            return { text: input.text };
        }
    });
}

async function execute(
    provider: ModelAdapter,
    options: {
        readonly task?: TaskSpec;
        readonly signal?: AbortSignal;
        readonly counter?: { value: number };
    } = {}
) {
    const sink = new MemoryEventSink();
    const counter = options.counter ?? { value: 0 };
    const state = await runAgent({
        runId: "w3-runtime-run",
        task: options.task ?? task(),
        workspaceRoot: process.cwd(),
        provider,
        tools: [echoTool(counter)],
        events: sink,
        ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    return { counter, sink, state };
}

describe("W3 agent loop", () => {
    it("records Usage before Tool, observes the result, then completes", async () => {
        const provider = new QueueProvider([
            {
                kind: "tool_use",
                calls: [{ id: "call-1", name: "echo", input: { text: "hello" } }],
                usage: usage()
            },
            {
                kind: "end_turn",
                text: "done",
                usage: usage(12, 3)
            }
        ]);

        const { counter, sink, state } = await execute(provider);

        expect(state.status).toBe("completed");
        expect(state.terminalReason).toBe("end_turn");
        expect(counter.value).toBe(1);
        const types = sink.events.map((event) => event.type);
        expect(types.indexOf("usage.recorded")).toBeLessThan(
            types.indexOf("tool.call")
        );
        expect(types.at(-1)).toBe("run.end");
    });

    it("preserves reasoning content in subsequent Provider requests", async () => {
        const toolCall = {
            id: "reasoning-call",
            name: "echo",
            input: { text: "hello" }
        } as const;
        const provider = new QueueProvider([
            {
                kind: "tool_use",
                calls: [toolCall],
                text: "I will inspect with the tool.",
                reasoningContent: "I should inspect with the echo tool.",
                usage: usage()
            },
            {
                kind: "end_turn",
                text: "first answer",
                reasoningContent: "The tool result is sufficient.",
                usage: usage()
            }
        ]);

        const { state } = await execute(provider);

        expect(state.status).toBe("completed");
        expect(provider.requests[1]?.messages).toContainEqual({
            role: "assistant",
            content: "I will inspect with the tool.",
            toolCalls: [toolCall],
            reasoningContent: "I should inspect with the echo tool."
        });
    });

    it("returns a typed observation for a forbidden tool call", async () => {
        const provider = new QueueProvider([
            {
                kind: "tool_use",
                calls: [
                    { id: "bad-call", name: "delete_everything", input: {} }
                ],
                usage: usage()
            },
            { kind: "end_turn", text: "recovered", usage: usage() }
        ]);

        const { sink, state } = await execute(provider);
        const result = sink.events.find(
            (event) => event.type === "tool.result"
        );

        expect(state.status).toBe("completed");
        expect(result?.type).toBe("tool.result");
        if (result?.type === "tool.result") {
            expect(result.data.result).toMatchObject({
                ok: false,
                error: { code: "TOOL_NOT_ALLOWED" }
            });
        }
    });

    it("never executes the same tool call id twice", async () => {
        const repeated = {
            kind: "tool_use" as const,
            calls: [{ id: "same-id", name: "echo", input:{ text: "once"}}],
            usage: usage()
        };
        const counter = { value: 0 };
        const { sink, state } = await execute(
            new QueueProvider([
                repeated,
                repeated,
                { kind: "end_turn", text: "done", usage: usage() }
            ]),
            { counter }
        );

        expect(state.status).toBe("completed");
        expect(counter.value).toBe(1);
        expect(
            sink.events
            .filter((event) => event.type === "tool.result")
            .at(-1)
        ).toMatchObject({
            data: {
                result: {
                    ok: false,
                    error: { code: "DUPLICATE_TOOL_CALL_ID" }
                }
            }
        })
    });

      it("stops an otherwise infinite loop at the step budget", async () => {
        const responses = Array.from({ length: 2 }, (_, index) => ({
        kind: "tool_use" as const,
        calls: [
            {
            id: `step-${index}`,
            name: "echo",
            input: { text: "again" }
            }
        ],
        usage: usage()
        }));

        const { state } = await execute(new QueueProvider(responses), {
        task: task({ maxSteps: 2 })
        });

        expect(state).toMatchObject({
            status: "failed",
            error: { code: "STEP_BUDGET_EXHAUSTED" }
        });
    });

      it("records the current Tool result but starts no new Step at token budget", async () => {
    const { sink, state } = await execute(
      new QueueProvider([
        {
          kind: "tool_use",
          calls: [{ id: "token-call", name: "echo", input: { text: "x" } }],
          usage: usage(7, 3)
        }
      ]),
      { task: task({ tokenBudget: 10 }) }
    );

    expect(state).toMatchObject({
      status: "failed",
      error: { code: "TOKEN_BUDGET_EXHAUSTED" }
    });
    expect(
      sink.events.filter((event) => event.type === "step.begin")
    ).toHaveLength(1);
  });

  it("rejects an over-budget Tool batch before executing any call", async () => {
    const counter = { value: 0 };
    const { state } = await execute(
      new QueueProvider([
        {
          kind: "tool_use",
          calls: [
            { id: "allowed", name: "echo", input: { text: "first" } },
            { id: "blocked", name: "echo", input: { text: "second" } }
          ],
          usage: usage()
        }
      ]),
      {
        counter,
        task: task({ maxToolCalls: 1 })
      }
    );

    expect(counter.value).toBe(0);
    expect(state).toMatchObject({
      status: "failed",
      toolCallCount: 0,
      error: { code: "TOOL_CALL_BUDGET_EXHAUSTED" }
    });
  });

  it("interrupts an in-flight Provider at the wall-clock budget", async () => {
    const provider: ModelAdapter = {
      name: "wall-clock-blocking",
      async complete(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        });
        throw new Error("unreachable");
      }
    };

    const { sink, state } = await execute(provider, {
      task: task({ wallClockBudgetMs: 25 })
    });

    expect(state).toMatchObject({
      status: "interrupted",
      error: { code: "WALL_CLOCK_BUDGET_EXHAUSTED" }
    });
    expect(
      sink.events.filter((event) => event.type === "turn.interrupted")
    ).toHaveLength(1);
  });

  it("commits exactly one interrupted terminal and no synthetic step.end", async () => {
    const controller = new AbortController();
    const provider: ModelAdapter = {
      name: "blocking",
      async complete(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        });
        throw new Error("unreachable");
      }
    };
    setTimeout(() => controller.abort(new Error("user cancelled")), 20);

    const { sink, state } = await execute(provider, {
      signal: controller.signal
    });

    expect(state.status).toBe("interrupted");
    expect(
      sink.events.filter((event) => event.type === "turn.interrupted")
    ).toHaveLength(1);
    expect(
      sink.events.filter((event) => event.type === "step.end")
    ).toHaveLength(0);
    expect(state.usage.complete).toBe(false);
  });

  it("does not append run.begin when the Run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before start"));

    const { sink, state } = await execute(
      new QueueProvider([
        { kind: "end_turn", text: "unreachable", usage: usage() }
      ]),
      { signal: controller.signal }
    );

    expect(state.status).toBe("interrupted");
    expect(sink.events.map((event) => event.type)).toEqual([
      "turn.interrupted"
    ]);
    expect(sink.events.map((event) => event.seq)).toEqual([1]);
  });

  it("marks Usage incomplete when a Provider attempt fails before accounting", async () => {
    const provider: ModelAdapter = {
      name: "failed-before-usage",
      async complete() {
        throw new Error("connection dropped");
      }
    };

    const { state } = await execute(provider);

    expect(state).toMatchObject({
      status: "failed",
      usage: { complete: false },
      error: { code: "PROVIDER_FAILED" }
    });
  });

  it("waits for an in-flight Tool to settle before committing interruption", async () => {
    let announceStarted!: () => void;
    let releaseTool!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const counter = { value: 0 };
    const slowTool = registerTool({
      definition: {
        name: "slow_side_effect",
        description: "Complete one delayed side effect",
        inputSchema: {
          type: "object",
          additionalProperties: false
        }
      },
      parse() {
        return {};
      },
      async execute() {
        announceStarted();
        await released;
        counter.value += 1;
        return { value: counter.value };
      }
    });
    const sink = new MemoryEventSink();
    const controller = new AbortController();
    const run = runAgent({
      runId: "settled-tool-abort",
      task: {
        ...task({ wallClockBudgetMs: 2_000 }),
        constraints: { allowedTools: ["slow_side_effect"] }
      },
      workspaceRoot: process.cwd(),
      provider: new QueueProvider([
        {
          kind: "tool_use",
          calls: [{ id: "slow-1", name: "slow_side_effect", input: {} }],
          usage: usage()
        }
      ]),
      tools: [slowTool],
      events: sink,
      signal: controller.signal
    });
    let runSettled = false;
    void run.finally(() => {
      runSettled = true;
    });

    await started;
    controller.abort(new Error("stop after Tool start"));
    await Promise.resolve();
    expect(runSettled).toBe(false);
    expect(counter.value).toBe(0);

    releaseTool();
    const state = await run;

    expect(counter.value).toBe(1);
    expect(state).toMatchObject({
      status: "interrupted",
      error: { code: "RUN_ABORTED" }
    });
    expect(sink.events.at(-1)?.type).toBe("turn.interrupted");
  });

})
