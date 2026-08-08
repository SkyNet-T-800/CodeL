import { createHash } from "node:crypto";
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    AgentEvent,
    FrozenRunConfiguration,
    RunOutcome,
    VerificationResult
} from "@repo-circuit/core";
import {
    RunRecorder,
    sha256File,
    sha256Text
} from "@repo-circuit/trace";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

async function temporaryRunsRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "repo-circuit-recorder-"));
    temporaryRoots.push(root);
    return join(root, "runs");
}

function configuration(runId: string): FrozenRunConfiguration {
    return {
        schemaVersion: 1,
        runId,
        comparisonId: null,
        attemptIndex: 0,
        identity: {
            taskId: "smoke-task",
            baseSha: "a".repeat(40),
            fixtureVersion: "fixture-v1",
            startedAt: "2026-07-30T00:00:00.000Z",
            agentCommit: "b".repeat(40),
            harnessCommit: "c".repeat(40)
        },
        model: {
            provider: "fake",
            modelId: "fake-v1",
            modelRevision: "revision-1",
            reasoningEffort: "unsupported",
            temperature: "unsupported",
            topP: "unsupported",
            seed: 7
        },
        prompt: {
            systemPromptHash: "d".repeat(64)
        },
        tools: {
            toolSchemaHash: "e".repeat(64),
            enabledTools: ["read", "apply_patch"],
            toolPolicyHash: "f".repeat(64)
        },
        context: {
            contextStrategy: "full-history",
            maxContextTokens: 16_384
        },
        budget: {
            maxSteps: 8,
            tokenBudget: 20_000,
            maxToolCalls: 16,
            wallClockBudgetMs: 120_000
        },
        evaluation: {
            verifierVersion: "verifier-v1",
            evaluatorCommit: "1".repeat(40),
            scorer: "tests-pass"
        }
    };
}

function beginEvent(runId: string): AgentEvent {
    return {
        schemaVersion: 1,
        runId,
        seq:1,
        type: "run.begin",
        data: {
            taskId: "smoke-task",
            instruction: "Fix the fixture"
        }
    }
}

function passedVerification(): VerificationResult {
    return {
        passed: true,
        summary: "All tests passed",
        testResult: {
            status: "passed",
            exitCode: 0,
            summary: "1 test passed",
            durationMs: 25
        }
    };
};

function outcomeFor(
    patch: string,
    verification: VerificationResult,
    terminalReason = "verified"
): RunOutcome {
    return {
        endedAt: "2026-07-30T00:00:01.000Z",
        usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            complete: true
        },
        steps: 2,
        toolCallCount: 1,
        latencyMs: 1_000,
        terminalReason,
        patchHash: sha256Text(patch),
        testResult: verification.testResult
    }
}

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true});
        })
    );
});

describe("RunRecorder", () => {
    it("commits a successful run with immutable, hash-linked artifacts", async () => {
        const runsRoot = await temporaryRunsRoot();
        const runId = "successful-run";
        const suppliedConfiguration = configuration(runId);
        const recorder = await RunRecorder.begin(
            runsRoot,
            suppliedConfiguration
        );
        (
            suppliedConfiguration as unknown as {
                identity: { taskId: string };
            }
        ).identity.taskId = "mutated-after-begin";

        expect(await readdir(recorder.runDirectory)).toEqual([
            "run-config.json",
            "trace.jsonl"
        ]);

        expect(
            recorder.append(beginEvent("another-run"))
        ).rejects.toMatchObject({
            code: "RUN_ID_MISMATCH" 
        });

        const events: AgentEvent[] = [
            beginEvent(runId),
            {
                schemaVersion: 1,
                runId,
                seq: 2,
                type: "run.end",
                data: {
                    status: "completed",
                    steps: 2,
                    terminalReason: "verified"
                }
            }
        ];
        await Promise.all(events.map((event) => recorder.append(event)));

        const patch = [
            "diff --git a/source.ts b/source.ts",
            "--- a/source.ts",
            "+++ b/source.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            ""
        ].join("\n");
        const verifierResult = passedVerification();
        const outcome = outcomeFor(patch, verifierResult);
        const meta = await recorder.finalize({
            outcome,
            predictionPatch: patch,
            verifierResult
        });

        const runConfig = JSON.parse(
            await readFile(
                join(recorder.runDirectory, "run-config.json"),
                "utf8"
            )
        ) as FrozenRunConfiguration;
        const runMeta = JSON.parse(
            await readFile(recorder.runMetaPath, "utf8")
        ) as typeof meta;
        const traceLines = (
            await readFile(join(recorder.runDirectory, "trace.jsonl"), "utf8")
        ).trimEnd().split("\n").map((line) => JSON.parse(line) as AgentEvent);

        expect(runConfig).toEqual(configuration(runId));
        expect(runMeta.identity.taskId).toBe("smoke-task");
        expect(runMeta).toEqual(meta);
        expect(traceLines).toEqual(events);
        expect(meta.outcome).toEqual(outcome);
        expect(meta.artifacts).toEqual({
            tracePath: "trace.jsonl",
            traceSha256: await sha256File(
                join(recorder.runDirectory, "trace.jsonl")
            ),
            patchPath: "prediction.patch",
            patchSha256: sha256Text(patch),
            verifierResultPath: "verifier-result.json",
            verifierResultSha256: await sha256File(
                join(recorder.runDirectory, "verifier-result.json")
            )
        });
        expect(
            createHash("sha256")
              .update(
                await readFile(
                    join(recorder.runDirectory, "prediction.patch")
                )
              )
              .digest("hex")
        ).toBe(outcome.patchHash);

        await expect(
            recorder.finalize({
                outcome,
                predictionPatch: patch,
                verifierResult
            })
        ).rejects.toMatchObject({
            code: "RUN_NOT_RECORDING"
        });
        await expect(recorder.append(beginEvent(runId))).rejects.toMatchObject({
            code: "RUN_NOT_RECORDING"
        });
    });
})