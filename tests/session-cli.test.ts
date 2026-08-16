import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { AgentEvent, TaskSpec } from "@repo-circuit/core";
import { inspectSession, SessionStore } from "@repo-circuit/session";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoCircuitCli = resolve("apps/cli/src/index.ts");

const task: TaskSpec = {
  schemaVersion: 1,
  id: "session-cli",
  title: "Session CLI",
  instruction: "exercise Session management commands",
  workspace: { root: "." },
  constraints: { allowedTools: [] },
  budget: {
    maxSteps: 3,
    tokenBudget: 1_000,
    maxToolCalls: 3,
    wallClockBudgetMs: 2_000
  }
};

async function cli(args: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", repoCircuitCli, ...args],
    {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
  return result.stdout;
}

describe("W6 Session CLI", () => {
  it("uses --at-step for rewind/fork and appends rewind runs to the same Session", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "repo-circuit-w6-cli-"));
    const workspace = join(temporary, "workspace");
    const sessionsRoot = join(temporary, "sessions");
    await mkdir(workspace);
    try {
      const store = await SessionStore.create({
        sessionsRoot,
        sessionId: "cli-parent",
        workspaceRoot: workspace,
        task
      });
      const oldEvents: readonly AgentEvent[] = [
        {
          schemaVersion: 1,
          runId: "cli-old-run",
          seq: 1,
          type: "run.begin",
          data: { taskId: task.id, instruction: task.instruction }
        },
        {
          schemaVersion: 1,
          runId: "cli-old-run",
          seq: 2,
          type: "step.begin",
          data: { step: 1 }
        },
        {
          schemaVersion: 1,
          runId: "cli-old-run",
          seq: 3,
          type: "usage.recorded",
          data: {
            step: 1,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              complete: true
            },
            cumulative: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              complete: true
            }
          }
        },
        {
          schemaVersion: 1,
          runId: "cli-old-run",
          seq: 4,
          type: "assistant.final",
          data: { step: 1, text: "old CLI leaf" }
        },
        {
          schemaVersion: 1,
          runId: "cli-old-run",
          seq: 5,
          type: "step.end",
          data: { step: 1, reason: "end_turn" }
        },
        {
          schemaVersion: 1,
          runId: "cli-old-run",
          seq: 6,
          type: "run.end",
          data: { status: "completed", steps: 1, terminalReason: "end_turn" }
        }
      ];
      for (const event of oldEvents) await store.recordAgentEvent(event);
      await store.dispose();

      const rootArgs = ["--sessions-dir", sessionsRoot];
      expect(await cli(["session", "list", ...rootArgs])).toContain("cli-parent");
      expect(await cli([
        "session", "show", "--session-id", "cli-parent", ...rootArgs
      ])).toContain('"activeChain"');
      expect(await cli([
        "session", "resume", "--session-id", "cli-parent", ...rootArgs
      ])).toContain('"status": "ready"');
      expect(await cli([
        "session", "rewind",
        "--session-id", "cli-parent",
        "--at-step", "1",
        ...rootArgs
      ])).toContain('"step": 1');
      expect(await cli([
        "session", "fork",
        "--session-id", "cli-parent",
        "--at-step", "1",
        "--child-session-id", "cli-child",
        ...rootArgs
      ])).toContain('"sessionId": "cli-child"');

      const taskPath = join(temporary, "task.json");
      const scriptPath = join(temporary, "script.json");
      await writeFile(taskPath, JSON.stringify(task), "utf8");
      await writeFile(scriptPath, JSON.stringify([
        {
          kind: "end_turn",
          text: "new CLI leaf",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            complete: true
          }
        }
      ]), "utf8");
      const runOutput = await cli([
        "run",
        "--task", taskPath,
        "--workspace", workspace,
        "--provider", "scripted",
        "--script", scriptPath,
        "--run-id", "cli-new-run",
        "--resume-session", "cli-parent",
        "--at-step", "1",
        ...rootArgs
      ]);
      expect(runOutput).toContain("Session: cli-parent");
      expect(runOutput).toContain("Final: new CLI leaf");

      const inspection = await inspectSession(sessionsRoot, "cli-parent");
      const referenced = new Set(
        inspection.events.flatMap((event) =>
          event.parentUuid === null ? [] : [event.parentUuid]
        )
      );
      expect(inspection.events.filter((event) => !referenced.has(event.uuid)))
        .toHaveLength(2);
      expect(inspection.activeChain.at(-1)).toMatchObject({
        runId: "cli-new-run",
        type: "run.end"
      });
      expect(inspection.projection.messages.at(-1)).toEqual({
        role: "assistant",
        content: "new CLI leaf"
      });
      expect((await inspectSession(sessionsRoot, "cli-child")).events.every(
        (event) => event.sessionId === "cli-child"
      )).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);
});
