import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskSpec } from "@repo-circuit/core";
import { inspectSession, SessionStore } from "@repo-circuit/session";
import { describe, expect, it } from "vitest";

const task: TaskSpec = {
  schemaVersion: 1,
  id: "faults",
  title: "Fault recovery",
  instruction: "test recovery",
  workspace: { root: "." },
  constraints: { allowedTools: ["echo"] },
  budget: { maxSteps: 3, wallClockBudgetMs: 2_000 }
};

async function fixture(sessionId: string) {
  const temporary = await mkdtemp(join(tmpdir(), "repo-circuit-w6-faults-"));
  const workspace = join(temporary, "workspace");
  await mkdir(workspace);
  const sessionsRoot = join(temporary, "sessions");
  const store = await SessionStore.create({
    sessionsRoot,
    sessionId,
    workspaceRoot: workspace,
    task
  });
  return {
    temporary,
    workspace,
    sessionsRoot,
    store,
    path: join(sessionsRoot, `${sessionId}.jsonl`)
  };
}

async function recordRunBegin(store: SessionStore): Promise<void> {
  await store.recordAgentEvent({
    schemaVersion: 1,
    runId: "fault-run",
    seq: 1,
    type: "run.begin",
    data: { taskId: task.id, instruction: task.instruction }
  });
}

describe("W6 Session fault matrix", () => {
  it("repairs only a torn final fragment before resuming", async () => {
    const f = await fixture("torn-tail");
    try {
      await recordRunBegin(f.store);
      await f.store.dispose();
      await appendFile(f.path, "{\"partial\"", "utf8");

      expect((await inspectSession(f.sessionsRoot, "torn-tail")).tornTailDetected)
        .toBe(true);
      const resumed = await SessionStore.openForResume({
        sessionsRoot: f.sessionsRoot,
        sessionId: "torn-tail",
        workspaceRoot: f.workspace,
        task
      });
      await resumed.dispose();
      expect((await readFile(f.path, "utf8")).endsWith("\n")).toBe(true);
      expect((await inspectSession(f.sessionsRoot, "torn-tail")).tornTailDetected)
        .toBe(false);
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("rejects a malformed complete JSONL line instead of skipping it", async () => {
    const f = await fixture("committed-corruption");
    try {
      await recordRunBegin(f.store);
      await f.store.dispose();
      await appendFile(f.path, "not-json\n", "utf8");

      await expect(inspectSession(f.sessionsRoot, "committed-corruption"))
        .rejects.toMatchObject({ code: "CORRUPT_EVENT_LOG" });
      await expect(SessionStore.openForResume({
        sessionsRoot: f.sessionsRoot,
        sessionId: "committed-corruption",
        workspaceRoot: f.workspace,
        task
      })).rejects.toMatchObject({ code: "CORRUPT_EVENT_LOG" });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("returns manual_required when a durable Tool call has no result", async () => {
    const f = await fixture("pending-tool");
    try {
      await recordRunBegin(f.store);
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 2,
        type: "step.begin",
        data: { step: 1 }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 3,
        type: "usage.recorded",
        data: {
          step: 1,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            complete: false
          },
          cumulative: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            complete: false
          }
        }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 4,
        type: "tool.call",
        data: {
          step: 1,
          callId: "unknown",
          name: "echo",
          input: { text: "x" }
        }
      });
      await f.store.dispose();

      expect(await SessionStore.prepareResume(f.sessionsRoot, "pending-tool"))
        .toMatchObject({
          status: "manual_required",
          code: "UNKNOWN_TOOL_OUTCOME",
          pendingToolCalls: [
            { callId: "unknown", name: "echo", step: 1 }
          ]
        });
      await expect(SessionStore.openForResume({
        sessionsRoot: f.sessionsRoot,
        sessionId: "pending-tool",
        workspaceRoot: f.workspace,
        task
      })).rejects.toMatchObject({ code: "UNSAFE_RESUME" });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("requires manual handling for a Tool result after the latest safe point", async () => {
    const f = await fixture("unsealed-result");
    try {
      await recordRunBegin(f.store);
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 2,
        type: "step.begin",
        data: { step: 1 }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 3,
        type: "usage.recorded",
        data: {
          step: 1,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            complete: false
          },
          cumulative: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            complete: false
          }
        }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 4,
        type: "tool.call",
        data: {
          step: 1,
          callId: "done",
          name: "echo",
          input: { text: "x" }
        }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 5,
        type: "tool.result",
        data: {
          step: 1,
          callId: "done",
          name: "echo",
          result: { ok: true, output: "x" }
        }
      });
      await f.store.dispose();

      expect(await SessionStore.prepareResume(f.sessionsRoot, "unsealed-result"))
        .toMatchObject({
          status: "manual_required",
          code: "SIDE_EFFECT_AFTER_SAFE_POINT"
        });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("rejects a bad Agent sequence even when it is on an abandoned branch", async () => {
    const f = await fixture("bad-dormant-sequence");
    try {
      await recordRunBegin(f.store);
      await f.store.dispose();
      const root = (await inspectSession(
        f.sessionsRoot,
        "bad-dormant-sequence"
      )).events[0]!;
      const row = (uuid: string, seq: number) => JSON.stringify({
        schemaVersion: 1,
        runId: "fault-run",
        seq,
        type: "step.begin",
        data: { step: 1 },
        sessionId: "bad-dormant-sequence",
        uuid,
        parentUuid: root.uuid,
        timestamp: new Date().toISOString(),
        cwd: root.cwd
      });
      await appendFile(
        f.path,
        `${row("bad-leaf", 99)}\n${row("newer-valid-leaf", 2)}\n`,
        "utf8"
      );

      await expect(inspectSession(f.sessionsRoot, "bad-dormant-sequence"))
        .rejects.toMatchObject({ code: "CORRUPT_EVENT_LOG" });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("rejects a complete JSON event that violates the Agent Step protocol", async () => {
    const f = await fixture("bad-step-protocol");
    try {
      await recordRunBegin(f.store);
      await f.store.dispose();
      const root = (await inspectSession(
        f.sessionsRoot,
        "bad-step-protocol"
      )).events[0]!;
      await appendFile(f.path, `${JSON.stringify({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 2,
        type: "step.end",
        data: { step: 999, reason: "error" },
        sessionId: "bad-step-protocol",
        uuid: "invalid-step-end",
        parentUuid: root.uuid,
        timestamp: new Date().toISOString(),
        cwd: root.cwd
      })}\n`, "utf8");

      await expect(inspectSession(f.sessionsRoot, "bad-step-protocol"))
        .rejects.toMatchObject({ code: "CORRUPT_EVENT_LOG" });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("rejects a completed Provider Step with no Usage accounting event", async () => {
    const f = await fixture("missing-accounting-event");
    try {
      await recordRunBegin(f.store);
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 2,
        type: "step.begin",
        data: { step: 1 }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 3,
        type: "assistant.final",
        data: { step: 1, text: "missing accounting" }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 4,
        type: "step.end",
        data: { step: 1, reason: "end_turn" }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 5,
        type: "run.end",
        data: { status: "completed", steps: 1, terminalReason: "end_turn" }
      });
      await f.store.dispose();

      await expect(inspectSession(f.sessionsRoot, "missing-accounting-event"))
        .rejects.toMatchObject({ code: "CORRUPT_EVENT_LOG" });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("rejects Usage whose cumulative value does not match its delta", async () => {
    const f = await fixture("forged-cumulative-usage");
    try {
      await recordRunBegin(f.store);
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 2,
        type: "step.begin",
        data: { step: 1 }
      });
      await f.store.recordAgentEvent({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 3,
        type: "usage.recorded",
        data: {
          step: 1,
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            totalTokens: 10,
            complete: true
          },
          cumulative: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            complete: true
          }
        }
      });
      await f.store.dispose();

      await expect(inspectSession(f.sessionsRoot, "forged-cumulative-usage"))
        .rejects.toMatchObject({ code: "CORRUPT_EVENT_LOG" });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("selects the last appended leaf even when wall-clock timestamps go backward", async () => {
    const f = await fixture("clock-skew");
    try {
      await recordRunBegin(f.store);
      await f.store.dispose();
      const root = (await inspectSession(f.sessionsRoot, "clock-skew"))
        .events[0]!;
      const interrupted = (uuid: string, timestamp: string) => JSON.stringify({
        schemaVersion: 1,
        runId: "fault-run",
        seq: 2,
        type: "turn.interrupted",
        data: {
          taskId: task.id,
          instruction: task.instruction,
          steps: 0,
          error: { code: "RUN_ABORTED", message: uuid }
        },
        sessionId: "clock-skew",
        uuid,
        parentUuid: root.uuid,
        timestamp,
        cwd: root.cwd
      });
      await appendFile(
        f.path,
        `${interrupted("old-leaf", "2099-01-01T00:00:00.000Z")}\n` +
          `${interrupted("last-appended-leaf", "2000-01-01T00:00:00.000Z")}\n`,
        "utf8"
      );

      const inspection = await inspectSession(f.sessionsRoot, "clock-skew");
      expect(inspection.activeChain.at(-1)?.uuid).toBe("last-appended-leaf");
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });
});
