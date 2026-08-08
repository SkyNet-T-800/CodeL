import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateJsonSchema,
  type JsonObject,
  type JsonValue,
  type RunMeta
} from "@repo-circuit/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPARISON_MANIFEST_SCHEMA,
  CommandVerifier,
  RUN_META_SCHEMA,
  evaluateBaselineEligibility,
  validateComparison,
  validateRunMeta
} from "../packages/harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function examplePath(
  kind: "valid" | "confounded",
  fileName: string
): string {
  return join(repositoryRoot, "examples", "comparisons", kind, fileName);
}

async function readExampleRun(
  kind: "valid" | "confounded",
  side: "a" | "b"
): Promise<RunMeta> {
  return await readJson<RunMeta>(examplePath(kind, `run-${side}.json`));
}

function mutableCopy(value: RunMeta): Record<string, unknown> {
  return structuredClone(value) as unknown as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    })
  );
});

describe("Run Meta validation and Baseline gate", () => {
  it("keeps the executable and published JSON Schemas byte-for-value aligned", async () => {
    const publishedRunMetaSchema = await readJson<JsonValue>(
      join(repositoryRoot, "schemas", "run-meta.schema.json")
    );
    const publishedComparisonSchema = await readJson<JsonValue>(
      join(repositoryRoot, "schemas", "comparison-manifest.schema.json")
    );

    expect(publishedRunMetaSchema).toEqual(RUN_META_SCHEMA);
    expect(publishedComparisonSchema).toEqual(COMPARISON_MANIFEST_SCHEMA);
  });

  it("accepts every complete Run Meta example", async () => {
    const examples = await Promise.all([
      readExampleRun("valid", "a"),
      readExampleRun("valid", "b"),
      readExampleRun("confounded", "a"),
      readExampleRun("confounded", "b")
    ]);

    for (const runMeta of examples) {
      expect(validateRunMeta(runMeta)).toEqual({
        valid: true,
        issues: []
      });
      expect(evaluateBaselineEligibility(runMeta)).toEqual({
        eligible: true,
        reasons: []
      });
    }
  });

  it.each([
    ["identity.baseSha", (value: Record<string, unknown>) => {
      delete (value.identity as Record<string, unknown>).baseSha;
    }],
    ["prompt.systemPromptHash", (value: Record<string, unknown>) => {
      delete (value.prompt as Record<string, unknown>).systemPromptHash;
    }],
    ["budget.maxSteps", (value: Record<string, unknown>) => {
      delete (value.budget as Record<string, unknown>).maxSteps;
    }],
    ["evaluation.evaluatorCommit", (value: Record<string, unknown>) => {
      delete (value.evaluation as Record<string, unknown>).evaluatorCommit;
    }]
  ])("rejects a Run missing critical %s", async (field, removeField) => {
    const value = mutableCopy(await readExampleRun("valid", "a"));
    removeField(value);

    const validation = validateRunMeta(value);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.path)).toContain(`$.${field}`);

    const gate = evaluateBaselineEligibility(value);
    expect(gate.eligible).toBe(false);
    expect(gate.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RUN_META_INVALID" })
      ])
    );
  });

  it("retains a Run with estimated usage but excludes it from Baseline", async () => {
    const value = mutableCopy(await readExampleRun("valid", "a"));
    const outcome = value.outcome as Record<string, unknown>;
    const usage = outcome.usage as Record<string, unknown>;
    usage.complete = false;

    expect(validateRunMeta(value).valid).toBe(true);
    expect(evaluateBaselineEligibility(value)).toEqual({
      eligible: false,
      reasons: [
        {
          code: "TOKEN_USAGE_INCOMPLETE",
          path: "$.outcome.usage.complete",
          message: "exact token usage is required for Baseline admission"
        }
      ]
    });
  });

  it("retains a dirty implementation Run but excludes it from Baseline", async () => {
    const value = mutableCopy(await readExampleRun("valid", "a"));
    const identity = value.identity as Record<string, unknown>;
    identity.agentCommit = `${String(identity.agentCommit)}+dirty`;

    expect(validateRunMeta(value).valid).toBe(true);
    expect(evaluateBaselineEligibility(value)).toMatchObject({
      eligible: false,
      reasons: [
        expect.objectContaining({
          code: "DIRTY_COMMIT",
          path: "$.identity.agentCommit"
        })
      ]
    });
  });

  it("records an undisclosed model control as unknown but keeps it out of Baseline", async () => {
    const value = mutableCopy(await readExampleRun("valid", "a"));
    (value.model as Record<string, unknown>).temperature = "unknown";

    expect(validateRunMeta(value).valid).toBe(true);
    expect(evaluateBaselineEligibility(value)).toMatchObject({
      eligible: false,
      reasons: [
        expect.objectContaining({
          code: "CRITICAL_VALUE_UNKNOWN",
          path: "$.model.temperature"
        })
      ]
    });
  });
});

describe("paired comparison validation", () => {
  it("accepts a single-variable model A/B and derives the manifest", async () => {
    const runA = await readExampleRun("valid", "a");
    const runB = await readExampleRun("valid", "b");
    const expected = await readJson<JsonValue>(
      examplePath("valid", "comparison-manifest.json")
    );

    const manifest = validateComparison(runA, runB);

    expect(manifest).toEqual(expected);
    expect(
      validateJsonSchema(
        COMPARISON_MANIFEST_SCHEMA,
        manifest as unknown as JsonValue
      )
    ).toEqual([]);
  });

  it("rejects hand-authored manifests that bypass attribution constraints", () => {
    const duplicateVariables = {
      schemaVersion: 1,
      comparisonId: "duplicate-variable-comparison",
      runAId: "run-a",
      runBId: "run-b",
      changedVariables: ["model.modelId", "model.modelId"],
      status: "invalid_for_attribution",
      reasons: ["duplicate variables are not valid evidence"]
    } as const;
    const falselyValid = {
      schemaVersion: 1,
      comparisonId: "confounded-comparison",
      runAId: "run-a",
      runBId: "run-b",
      changedVariables: ["model.modelId", "prompt.systemPromptHash"],
      status: "valid_for_attribution",
      reasons: ["this reason must be empty for a valid comparison"]
    } as const;

    expect(
      validateJsonSchema(
        COMPARISON_MANIFEST_SCHEMA,
        duplicateVariables as unknown as JsonValue
      )
    ).toEqual([
      expect.objectContaining({
        path: "$.changedVariables",
        message: expect.stringContaining("unique items")
      })
    ]);
    expect(
      validateJsonSchema(
        COMPARISON_MANIFEST_SCHEMA,
        falselyValid as unknown as JsonValue
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.changedVariables",
          message: expect.stringContaining("at most 1")
        }),
        expect.objectContaining({
          path: "$.reasons",
          message: expect.stringContaining("at most 0")
        })
      ])
    );
  });

  it("applies the else branch when an if condition does not match", () => {
    const schema: JsonObject = {
      type: "object",
      if: {
        properties: {
          status: { const: "passed" }
        },
        required: ["status"]
      },
      then: {
        required: ["result"]
      },
      else: {
        required: ["error"]
      }
    };

    expect(
      validateJsonSchema(schema, { status: "failed" })
    ).toEqual([
      {
        path: "$.error",
        message: "is required"
      }
    ]);
    expect(
      validateJsonSchema(schema, {
        status: "failed",
        error: "deterministic failure"
      })
    ).toEqual([]);
  });

  it("ignores run identity, timestamps, outcomes, and artifact evidence", async () => {
    const runA = await readExampleRun("valid", "a");
    const runB = await readExampleRun("valid", "b");

    expect(runA.runId).not.toBe(runB.runId);
    expect(runA.identity.startedAt).not.toBe(runB.identity.startedAt);
    expect(runA.outcome).not.toEqual(runB.outcome);
    expect(runA.artifacts).not.toEqual(runB.artifacts);
    expect(validateComparison(runA, runB).changedVariables).toEqual([
      "model.modelId"
    ]);
  });

  it("rejects a model-plus-prompt confounder", async () => {
    const runA = await readExampleRun("confounded", "a");
    const runB = await readExampleRun("confounded", "b");
    const expected = await readJson<JsonValue>(
      examplePath("confounded", "comparison-manifest.json")
    );

    const manifest = validateComparison(runA, runB);

    expect(manifest).toEqual(expected);
    expect(manifest.changedVariables).toEqual([
      "model.modelId",
      "prompt.systemPromptHash"
    ]);
    expect(manifest.status).toBe("invalid_for_attribution");
  });

  it("rejects a comparison with no changed frozen variable", async () => {
    const runA = await readExampleRun("valid", "a");
    const runB = structuredClone(runA);
    const value = runB as unknown as {
      runId: string;
      identity: { startedAt: string };
      outcome: { endedAt: string };
    };
    value.runId = "w3-model-ab-repeated";
    value.identity.startedAt = "2026-07-30T03:00:00.000Z";
    value.outcome.endedAt = "2026-07-30T03:00:08.000Z";

    expect(validateComparison(runA, runB)).toMatchObject({
      changedVariables: [],
      status: "invalid_for_attribution",
      reasons: [
        "changed_variables_must_contain_exactly_one_item: received_0"
      ]
    });
  });
});

describe("CommandVerifier", () => {
  it("runs an absolute Host-owned Node script outside the Agent workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-circuit-verifier-"));
    temporaryRoots.push(root);
    const workspaceRoot = join(root, "agent-workspace");
    const verifierScript = join(root, "host-verifier.mjs");
    await mkdir(workspaceRoot);
    await writeFile(
      verifierScript,
      [
        "if (process.env.REPO_CIRCUIT_API_KEY) process.exit(9);",
        "process.stdout.write(process.cwd());"
      ].join("\n"),
      "utf8"
    );

    const previousApiKey = process.env.REPO_CIRCUIT_API_KEY;
    process.env.REPO_CIRCUIT_API_KEY = "must-not-reach-verifier";
    const verifier = new CommandVerifier({
      scriptPath: verifierScript,
      version: "test-verifier-v1"
    });
    let result;
    try {
      result = await verifier.verify({
        task: {
          schemaVersion: 1,
          id: "verifier-test",
          title: "Verifier test",
          instruction: "Run the fixed verifier.",
          workspace: { root: "." },
          constraints: { allowedTools: [] },
          budget: { maxSteps: 1 }
        },
        workspaceRoot,
        signal: new AbortController().signal
      });
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.REPO_CIRCUIT_API_KEY;
      } else {
        process.env.REPO_CIRCUIT_API_KEY = previousApiKey;
      }
    }
    const physicalWorkspaceRoot = await realpath(workspaceRoot);

    expect(result).toMatchObject({
      passed: true,
      summary: physicalWorkspaceRoot,
      testResult: {
        status: "passed",
        exitCode: 0,
        summary: physicalWorkspaceRoot
      }
    });
  });

  it("rejects a verifier script changed after its hash was frozen", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-circuit-verifier-"));
    temporaryRoots.push(root);
    const verifierScript = join(root, "verify.mjs");
    const original = "process.stdout.write('ok');\n";
    await writeFile(verifierScript, original, "utf8");
    const verifier = new CommandVerifier({
      scriptPath: verifierScript,
      scriptSha256: createHash("sha256").update(original).digest("hex")
    });
    await writeFile(verifierScript, "process.stdout.write('changed');\n", "utf8");

    await expect(
      verifier.verify({
        task: {
          schemaVersion: 1,
          id: "verifier-hash-test",
          title: "Verifier hash test",
          instruction: "Reject a changed verifier.",
          workspace: { root: "." },
          constraints: { allowedTools: [] },
          budget: { maxSteps: 1 }
        },
        workspaceRoot: root,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("Verifier script hash mismatch");
  });

  it("returns a non-zero verifier exit as a structured failed TestResult", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-circuit-verifier-"));
    temporaryRoots.push(root);
    const workspaceRoot = join(root, "agent-workspace");
    await mkdir(workspaceRoot);
    await writeFile(
      join(workspaceRoot, "verify.mjs"),
      "process.stderr.write('public tests failed'); process.exitCode = 7;\n",
      "utf8"
    );

    const result = await new CommandVerifier("verify.mjs").verify({
      task: {
        schemaVersion: 1,
        id: "verifier-test",
        title: "Verifier test",
        instruction: "Run the fixed verifier.",
        workspace: { root: "." },
        constraints: { allowedTools: [] },
        budget: { maxSteps: 1 }
      },
      workspaceRoot,
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      passed: false,
      summary: "public tests failed",
      testResult: {
        status: "failed",
        exitCode: 7,
        summary: "public tests failed"
      }
    });
  });

  it("propagates AbortSignal into the verifier subprocess", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-circuit-verifier-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "verify.mjs"),
      "setInterval(() => {}, 1000);\n",
      "utf8"
    );
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    const verification = new CommandVerifier("verify.mjs").verify({
      task: {
        schemaVersion: 1,
        id: "verifier-test",
        title: "Verifier test",
        instruction: "Run the fixed verifier.",
        workspace: { root: "." },
        constraints: { allowedTools: [] },
        budget: { maxSteps: 1 }
      },
      workspaceRoot: root,
      signal: controller.signal
    });
    controller.abort(reason);

    await expect(verification).rejects.toBe(reason);
  });
});
