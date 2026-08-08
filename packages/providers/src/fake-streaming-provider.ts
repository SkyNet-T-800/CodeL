import type {
    ModelAdapter,
    ModelDescriptor,
    ModelResponse,
    ModelStreamEvent,
    ProviderRequest,
    TokenUsage
} from "@repo-circuit/core";

export interface FakeStreamingProviderOptions {

    readonly deltas?: readonly string[];

    readonly intervalMs?: number;

    readonly usage?: TokenUsage;

    readonly response?: ModelResponse;

    readonly descriptor?: ModelDescriptor;
}

function responseWithUsage(
    response: ModelResponse,
    usage: TokenUsage | undefined
): ModelResponse {
    if (usage === undefined) {
        return response;
    }

    if (response.kind === "tool_use") {
        return {
            kind: "tool_use",
            calls: response.calls,
            usage
        }
    }

    return {
        kind: "end_turn",
        text: response.text,
        usage
    }
}

async function waitForInterval(
    intervalMs: number,
    signal: AbortSignal
): Promise<void> {
    signal.throwIfAborted();
    if (intervalMs <= 0) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, intervalMs);

        const onAbort = (): void => {
            clearTimeout(timeout);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true});
    });
}

export class FakeStreamingProvider implements ModelAdapter {
    readonly name = "fake-streaming";
    readonly descriptor: ModelDescriptor;
    readonly #deltas: readonly string[];
    readonly #intervalMs: number;
    readonly #response: ModelResponse;
    readonly #requests: ProviderRequest[] = [];

    constructor(options: FakeStreamingProviderOptions) {
        const intervalMs = options.intervalMs ?? 0;
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
            throw new RangeError("Fake stream intervalMs must be a non-negative integer");
        }

        this.#deltas = [...(options.deltas ?? [])];
        this.#intervalMs = intervalMs;
        this.#response = responseWithUsage(
            options.response ?? {
                kind: "end_turn",
                text: this.#deltas.join("")
            },
            options.usage
        );
        this.descriptor = options.descriptor ?? {
            provider: "fake",
            modelId: "fake-streaming",
            modelRevision: "1"
        };
    }

    get requests(): readonly ProviderRequest[] {
        return this.#requests;
    }

    async complete(
        request: ProviderRequest,
        signal?: AbortSignal
    ): Promise<ModelResponse> {
        signal?.throwIfAborted();
        this.#requests.push(request);
        return this.#response;
    }

    async *stream(
        request: ProviderRequest,
        signal: AbortSignal
    ): AsyncIterable<ModelStreamEvent> {
        signal.throwIfAborted();
        this.#requests.push(request);

        for (let index = 0; index < this.#deltas.length; index++) {
            if (index > 0) {
                await waitForInterval(this.#intervalMs, signal);
            }
            signal.throwIfAborted();

            yield {
                type: "text.delta",
                delta: this.#deltas[index] ?? ""
            };
        }

        signal.throwIfAborted();
        yield {
            type: "response.completed",
            response: this.#response
        };
    }
}
