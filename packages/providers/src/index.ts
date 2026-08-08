import type {
  AgentMessage,
  ModelAdapter,
  ModelResponse,
  ProviderRequest
} from "@repo-circuit/core";

export class ScriptedMockProvider implements ModelAdapter {
  readonly name = "scripted-mock";
  readonly #responses: readonly ModelResponse[];
  readonly #requests: ProviderRequest[] = [];
  #cursor = 0;

  constructor(responses: readonly ModelResponse[]) {
    this.#responses = responses;
  }

  get requests(): readonly ProviderRequest[] {
    return this.#requests;
  }

  async complete(request: ProviderRequest): Promise<ModelResponse> {
    this.#requests.push(request);
    const response = this.#responses[this.#cursor];
    if (response === undefined) {
      throw new Error(`Mock response script exhausted at call ${this.#cursor + 1}`);
    }
    this.#cursor += 1;
    return response;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ToolMessage = Extract<AgentMessage, { readonly role: "tool" }>;

function isReadmeToolMessage(message: AgentMessage): message is ToolMessage {
  return message.role === "tool" && message.callId === "call-read-readme";
}

export class WeekOneMockProvider implements ModelAdapter {
  readonly name = "week-one-mock";
  readonly #requests: ProviderRequest[] = [];

  get requests(): readonly ProviderRequest[] {
    return this.#requests;
  }

  async complete(request: ProviderRequest): Promise<ModelResponse> {
    this.#requests.push(request);
    const toolMessage = [...request.messages].reverse().find(isReadmeToolMessage);
    
    if (toolMessage === undefined) {
      return {
        kind: "tool_use",
        calls: [
          {
            id: "call-read-readme",
            name: "read_file",
            input: {
              path: "README.md"
            }
          }
        ]
      }
    }

    if (!toolMessage.result.ok) {
      throw new Error("Mock expected a successful read_file result");
    }

    const output = toolMessage.result.output;
    if (!isRecord(output) || typeof output.content !== "string") {
      throw new Error("Mock expected read_file output with text content");
    }

    const projectName = /^#\s+(.+)$/m.exec(output.content)?.[1]?.trim();
    if (projectName === undefined || projectName.length === 0) {
      throw new Error("Mock could not find a Markdown H1 in README.md");
    }

    return {
      kind: "end_turn",
      text: `Fixture README read successfully: ${projectName}.`
    };
  }
}

export function createWeekOneMockProvider(): WeekOneMockProvider {
  return new WeekOneMockProvider();
}

export * from "./fake-streaming-provider.js";
export * from "./openai-compatible-provider.js";

