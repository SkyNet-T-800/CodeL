import type { JsonObject } from "@repo-circuit/core";

const NON_EMPTY_STRING = {
  type: "string",
  minLength: 1
} as const;

const NON_NEGATIVE_INTEGER = {
  type: "integer",
  minimum: 0
} as const;

const POSITIVE_INTEGER = {
  type: "integer",
  minimum: 1
} as const;

const SHA256 = {
  type: "string",
  pattern: "^[0-9a-f]{64}$"
} as const;

const TOKEN_USAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["inputTokens", "outputTokens", "totalTokens", "complete"],
  properties: {
    inputTokens: NON_NEGATIVE_INTEGER,
    outputTokens: NON_NEGATIVE_INTEGER,
    totalTokens: NON_NEGATIVE_INTEGER,
    complete: { type: "boolean" }
  }
} as const;

const TEST_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "exitCode", "summary", "durationMs"],
  properties: {
    status: {
      type: "string",
      enum: ["passed", "failed", "not_run", "infra_error"]
    },
    exitCode: {
      anyOf: [{ type: "integer" }, { type: "null" }]
    },
    summary: NON_EMPTY_STRING,
    durationMs: NON_NEGATIVE_INTEGER
  }
} as const;

/**
 * The executable form of schemas/run-meta.schema.json.
 *
 * It deliberately contains no `$ref`: the small validator in core can therefore
 * validate the same contract without pulling a third-party JSON Schema runtime
 * into the Harness.
 */
export const RUN_META_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://repo-circuit.dev/schemas/run-meta.schema.json",
  title: "RepoCircuit Run Meta",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "runId",
    "comparisonId",
    "attemptIndex",
    "identity",
    "model",
    "prompt",
    "tools",
    "context",
    "budget",
    "evaluation",
    "outcome",
    "artifacts"
  ],
  properties: {
    schemaVersion: { const: 1 },
    runId: NON_EMPTY_STRING,
    comparisonId: {
      anyOf: [NON_EMPTY_STRING, { type: "null" }]
    },
    attemptIndex: NON_NEGATIVE_INTEGER,
    identity: {
      type: "object",
      additionalProperties: false,
      required: [
        "taskId",
        "baseSha",
        "fixtureVersion",
        "startedAt",
        "agentCommit",
        "harnessCommit"
      ],
      properties: {
        taskId: NON_EMPTY_STRING,
        baseSha: NON_EMPTY_STRING,
        fixtureVersion: NON_EMPTY_STRING,
        startedAt: NON_EMPTY_STRING,
        agentCommit: NON_EMPTY_STRING,
        harnessCommit: NON_EMPTY_STRING
      }
    },
    model: {
      type: "object",
      additionalProperties: false,
      required: [
        "provider",
        "modelId",
        "modelRevision",
        "reasoningEffort",
        "temperature",
        "topP",
        "seed"
      ],
      properties: {
        provider: NON_EMPTY_STRING,
        modelId: NON_EMPTY_STRING,
        modelRevision: NON_EMPTY_STRING,
        reasoningEffort: NON_EMPTY_STRING,
        temperature: {
          anyOf: [
            { type: "number", minimum: 0 },
            { const: "unknown" },
            { const: "unsupported" }
          ]
        },
        topP: {
          anyOf: [
            { type: "number", minimum: 0, maximum: 1 },
            { const: "unknown" },
            { const: "unsupported" }
          ]
        },
        seed: {
          anyOf: [
            { type: "integer" },
            { const: "unknown" },
            { const: "unsupported" }
          ]
        }
      }
    },
    prompt: {
      type: "object",
      additionalProperties: false,
      required: ["systemPromptHash"],
      properties: {
        systemPromptHash: SHA256
      }
    },
    tools: {
      type: "object",
      additionalProperties: false,
      required: ["toolSchemaHash", "enabledTools", "toolPolicyHash"],
      properties: {
        toolSchemaHash: SHA256,
        enabledTools: {
          type: "array",
          items: NON_EMPTY_STRING,
          uniqueItems: true
        },
        toolPolicyHash: SHA256
      }
    },
    context: {
      type: "object",
      additionalProperties: false,
      required: ["contextStrategy", "maxContextTokens"],
      properties: {
        contextStrategy: NON_EMPTY_STRING,
        maxContextTokens: {
          anyOf: [POSITIVE_INTEGER, { const: "unsupported" }]
        }
      }
    },
    budget: {
      type: "object",
      additionalProperties: false,
      required: [
        "maxSteps",
        "tokenBudget",
        "maxToolCalls",
        "wallClockBudgetMs"
      ],
      properties: {
        maxSteps: POSITIVE_INTEGER,
        tokenBudget: POSITIVE_INTEGER,
        maxToolCalls: POSITIVE_INTEGER,
        wallClockBudgetMs: POSITIVE_INTEGER
      }
    },
    evaluation: {
      type: "object",
      additionalProperties: false,
      required: ["verifierVersion", "evaluatorCommit", "scorer"],
      properties: {
        verifierVersion: NON_EMPTY_STRING,
        evaluatorCommit: NON_EMPTY_STRING,
        scorer: NON_EMPTY_STRING
      }
    },
    outcome: {
      type: "object",
      additionalProperties: false,
      required: [
        "endedAt",
        "usage",
        "steps",
        "toolCallCount",
        "latencyMs",
        "terminalReason",
        "patchHash",
        "testResult"
      ],
      properties: {
        endedAt: NON_EMPTY_STRING,
        usage: TOKEN_USAGE_SCHEMA,
        steps: NON_NEGATIVE_INTEGER,
        toolCallCount: NON_NEGATIVE_INTEGER,
        latencyMs: NON_NEGATIVE_INTEGER,
        terminalReason: NON_EMPTY_STRING,
        patchHash: SHA256,
        testResult: TEST_RESULT_SCHEMA
      }
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      required: [
        "tracePath",
        "traceSha256",
        "patchPath",
        "patchSha256",
        "verifierResultPath",
        "verifierResultSha256"
      ],
      properties: {
        tracePath: NON_EMPTY_STRING,
        traceSha256: SHA256,
        patchPath: NON_EMPTY_STRING,
        patchSha256: SHA256,
        verifierResultPath: NON_EMPTY_STRING,
        verifierResultSha256: SHA256
      }
    }
  }
} as const satisfies JsonObject;

export const COMPARISON_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://repo-circuit.dev/schemas/comparison-manifest.schema.json",
  title: "RepoCircuit Comparison Manifest",
  type: "object",
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: {
          status: { const: "valid_for_attribution" }
        }
      },
      then: {
        properties: {
          changedVariables: {
            minItems: 1,
            maxItems: 1
          },
          reasons: {
            maxItems: 0
          }
        }
      }
    },
    {
      if: {
        properties: {
          status: { const: "invalid_for_attribution" }
        }
      },
      then: {
        properties: {
          reasons: {
            minItems: 1
          }
        }
      }
    }
  ],
  required: [
    "schemaVersion",
    "comparisonId",
    "runAId",
    "runBId",
    "changedVariables",
    "status",
    "reasons"
  ],
  properties: {
    schemaVersion: { const: 1 },
    comparisonId: NON_EMPTY_STRING,
    runAId: NON_EMPTY_STRING,
    runBId: NON_EMPTY_STRING,
    changedVariables: {
      type: "array",
      items: NON_EMPTY_STRING,
      uniqueItems: true
    },
    status: {
      type: "string",
      enum: ["valid_for_attribution", "invalid_for_attribution"]
    },
    reasons: {
      type: "array",
      items: NON_EMPTY_STRING
    }
  }
} as const satisfies JsonObject;
