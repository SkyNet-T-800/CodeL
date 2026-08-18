import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  runAgent,
  type JsonObject,
  type ModelAdapter,
  type ModelResponse,
  type ProviderRequest,
  type RegisteredTool,
  type TaskSpec
} from "@repo-circuit/core";
import {
  applyFullCompaction,
  FullCompactionStrategy
} from "@repo-circuit/context";
import {
  inspectSession,
  SessionEventSink,
  SessionStore
} from "@repo-circuit/session";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = resolve("apps/cli/src/index.ts");

const task: TaskSpec = {
  schemaVersion: 1,
  id: "context-full-compaction",
  title: "Context full compaction",
  instruction: "Inspect the evidence and continue the implementation.",
  workspace: { root: "." },
  constraints: { allowedTools: ["echo"] },
  budget: {
    maxSteps: 6,
    tokenBudget: 10_000,
    maxToolCalls: 6,
    wallClockBudgetMs: 2_000
  }
};

function usage(inputTokens = 10, outputTokens = 5) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    complete: true
  };
}

class QueueProvider implements ModelAdapter {
  readonly name = "context-test";
  readonly requests: ProviderRequest[] = [];
  readonly #responses: ModelResponse[];

  constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  async complete(request: ProviderRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("response queue exhausted");
    return response;
  }
}

const echoTool: RegisteredTool = {
  definition: {
    name: "echo",
    description: "Return input",
    inputSchema: { type: "object" }
  },
  async invoke(input: JsonObject) {
    return { ok: true, output: input };
  }
};

async function fixture(): Promise<{
  readonly temporary: string;
  readonly sessionsRoot: string;
  readonly workspace: string;
}> {
  const temporary = await mkdtemp(join(tmpdir(), "codel-context-"));
  const workspace = join(temporary, "workspace");
  await mkdir(workspace);
  return {
    temporary,
    sessionsRoot: join(temporary, "sessions"),
    workspace
  };
}

async function createLongSession(
  sessionsRoot: string,
  workspace: string,
  sessionId: string
): Promise<void> {
  const store = await SessionStore.create({
    sessionsRoot,
    sessionId,
    workspaceRoot: workspace,
    task
  });
  await runAgent({
    runId: `${sessionId}-run`,
    task,
    workspaceRoot: workspace,
    provider: new QueueProvider([
      {
        kind: "end_turn",
        text: `Completed analysis:\n${"evidence ".repeat(400)}`,
        usage: usage()
      }
    ]),
    tools: [],
    events: new SessionEventSink(store)
  });
  await store.dispose();
}

async function cli(args: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, ...args],
    {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
  return result.stdout;
}

describe("W7 Context full compaction", () => {
  it("projects one deterministic checkpoint with complete provenance", () => {
    const messages = [
      { role: "user" as const, content: task.instruction },
      {
        role: "assistant" as const,
        content: "A".repeat(2_000),
        reasoningContent: "reasoning that remains source evidence"
      }
    ];
    const sourceEvents = ["event-1", "event-2", "event-3"]
      .map((id) => ({ id }));
    const strategy = new FullCompactionStrategy();
    const result = strategy.project({
      sessionId: "session-1",
      taskId: task.id,
      instruction: task.instruction,
      messages,
      sourceEvents,
      summary: "The implementation is ready for verification.",
      pinnedEventIds: ["event-1"],
      budgetTokens: 1_000
    });

    expect(result.messages).toHaveLength(1);
    const checkpoint = result.messages[0];
    expect(checkpoint?.role).toBe("user");
    if (checkpoint?.role !== "user") {
      throw new Error("Full compaction must project a user checkpoint");
    }
    expect(checkpoint.content).toContain(
      `<current-task>\n${task.instruction}\n</current-task>`
    );
    expect(checkpoint.content).toContain(
      "<compacted-summary>\nThe implementation is ready for verification."
    );
    expect(result.manifest).toMatchObject({
      strategy: "full",
      strategyVersion: 1,
      sessionId: "session-1",
      sourceHeadEventId: "event-3",
      sourceEventIds: ["event-1", "event-2", "event-3"],
      sourceMessageCount: 2,
      includedEventIds: ["event-1"],
      droppedEventIds: ["event-2", "event-3"],
      evidenceIds: [],
      memoryIds: [],
      budgetTokens: 1_000
    });
    expect(result.manifest.estimatedTokensAfter).toBeLessThan(
      result.manifest.estimatedTokensBefore
    );
    expect(result.manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.summaryHash).toMatch(/^[a-f0-9]{64}$/);

    expect(applyFullCompaction(
      messages,
      sourceEvents.map((event) => event.id),
      {
        taskId: task.id,
        instruction: task.instruction,
        summary: "The implementation is ready for verification.",
        manifest: result.manifest
      }
    )).toEqual(result.messages);
    expect(() => applyFullCompaction(
      messages,
      sourceEvents.map((event) => event.id),
      {
        taskId: task.id,
        instruction: task.instruction,
        summary: "tampered summary",
        manifest: result.manifest
      }
    )).toThrow("manifest does not match");
  });

  it("round-trips assistant text and reasoning before compacting at a safe point", async () => {
    const f = await fixture();
    try {
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "reasoning-round-trip",
        workspaceRoot: f.workspace,
        task
      });
      const provider = new QueueProvider([
        {
          kind: "tool_use",
          calls: [{
            id: "echo-1",
            name: "echo",
            input: { text: "evidence ".repeat(300) }
          }],
          text: "I will inspect the evidence.",
          reasoningContent: "The evidence must be checked before answering.",
          usage: usage()
        },
        {
          kind: "end_turn",
          text: "The evidence is sufficient.",
          reasoningContent: "The tool result supports the conclusion.",
          usage: usage()
        }
      ]);
      const state = await runAgent({
        runId: "reasoning-run",
        task,
        workspaceRoot: f.workspace,
        provider,
        tools: [echoTool],
        events: new SessionEventSink(store)
      });
      await store.dispose();

      const before = await inspectSession(
        f.sessionsRoot,
        "reasoning-round-trip"
      );
      expect(before.projection.messages).toEqual(state.messages);
      expect(before.projection.messages[1]).toMatchObject({
        role: "assistant",
        content: "I will inspect the evidence.",
        reasoningContent: "The evidence must be checked before answering."
      });
      expect(before.projection.messages.at(-1)).toEqual({
        role: "assistant",
        content: "The evidence is sufficient.",
        reasoningContent: "The tool result supports the conclusion."
      });

      const path = join(f.sessionsRoot, "reasoning-round-trip.jsonl");
      const originalBytes = await readFile(path);
      const compacted = new FullCompactionStrategy().project({
        sessionId: "reasoning-round-trip",
        taskId: task.id,
        instruction: task.instruction,
        messages: before.projection.messages,
        sourceEvents: before.activeChain.map((event) => ({ id: event.uuid })),
        summary: "Evidence was inspected and supports the implementation.",
        pinnedEventIds: [before.activeChain[0]!.uuid]
      });
      const maintenance = await SessionStore.openForMaintenance({
        sessionsRoot: f.sessionsRoot,
        sessionId: "reasoning-round-trip",
        expectedHeadUuid: before.activeChain.at(-1)!.uuid
      });
      await maintenance.recordAgentEvent({
        schemaVersion: 1,
        runId: "reasoning-compaction",
        seq: 1,
        type: "context.compacted",
        data: {
          taskId: task.id,
          instruction: task.instruction,
          summary: "Evidence was inspected and supports the implementation.",
          manifest: compacted.manifest
        }
      });
      await maintenance.dispose();

      const compactedBytes = await readFile(path);
      expect(compactedBytes.subarray(0, originalBytes.length))
        .toEqual(originalBytes);
      const after = await inspectSession(
        f.sessionsRoot,
        "reasoning-round-trip"
      );
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.events.at(-1)?.type).toBe("context.compacted");
      expect(after.projection.messages).toEqual(compacted.messages);
      expect(after.projection).toMatchObject({
        usage: state.usage,
        toolCallCount: 1,
        seenCallIds: ["echo-1"],
        contextSelectionManifest: compacted.manifest
      });

      const resumed = await SessionStore.openForResume({
        sessionsRoot: f.sessionsRoot,
        sessionId: "reasoning-round-trip",
        workspaceRoot: f.workspace,
        task
      });
      const continuation = new QueueProvider([{
        kind: "end_turn",
        text: "continued after checkpoint",
        usage: usage(1, 1)
      }]);
      await runAgent({
        runId: "reasoning-continuation",
        task,
        workspaceRoot: f.workspace,
        provider: continuation,
        tools: [echoTool],
        events: new SessionEventSink(resumed),
        resumeState: resumed.preparation!.state
      });
      await resumed.dispose();

      expect(continuation.requests[0]?.messages).toEqual(compacted.messages);
      const continued = await inspectSession(
        f.sessionsRoot,
        "reasoning-round-trip"
      );
      expect(continued.projection.messages).toEqual([
        ...compacted.messages,
        { role: "assistant", content: "continued after checkpoint" }
      ]);
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("compacts through the CLI without rewriting canonical transcript rows", async () => {
    const f = await fixture();
    try {
      await createLongSession(f.sessionsRoot, f.workspace, "cli-compact");
      const path = join(f.sessionsRoot, "cli-compact.jsonl");
      const before = await readFile(path);
      const output = await cli([
        "compact",
        "--session-id", "cli-compact",
        "--sessions-dir", f.sessionsRoot,
        "--summary", "The analysis is complete; continue with verification."
      ]);

      expect(output).toContain('"status": "compacted"');
      expect(output).toContain('"strategy": "full"');
      const after = await readFile(path);
      expect(after.subarray(0, before.length)).toEqual(before);
      const inspection = await inspectSession(f.sessionsRoot, "cli-compact");
      expect(inspection.events.at(-1)?.type).toBe("context.compacted");
      expect(inspection.projection.messages).toHaveLength(1);
      const checkpoint = inspection.projection.messages[0];
      expect(checkpoint?.role).toBe("user");
      if (checkpoint?.role !== "user") {
        throw new Error("CLI compaction must project a user checkpoint");
      }
      expect(checkpoint.content).toContain("<compacted-summary>");
      expect((await SessionStore.prepareResume(
        f.sessionsRoot,
        "cli-compact"
      ))).toMatchObject({
        status: "ready",
        ignoredTailEvents: 0,
        state: { messages: inspection.projection.messages }
      });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("rejects maintenance compaction with an unsealed Tool call", async () => {
    const f = await fixture();
    try {
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "unsafe-compact",
        workspaceRoot: f.workspace,
        task
      });
      await store.recordAgentEvent({
        schemaVersion: 1,
        runId: "unsafe-run",
        seq: 1,
        type: "run.begin",
        data: { taskId: task.id, instruction: task.instruction }
      });
      await store.recordAgentEvent({
        schemaVersion: 1,
        runId: "unsafe-run",
        seq: 2,
        type: "step.begin",
        data: { step: 1 }
      });
      await store.recordAgentEvent({
        schemaVersion: 1,
        runId: "unsafe-run",
        seq: 3,
        type: "usage.recorded",
        data: {
          step: 1,
          usage: usage(1, 1),
          cumulative: usage(1, 1)
        }
      });
      await store.recordAgentEvent({
        schemaVersion: 1,
        runId: "unsafe-run",
        seq: 4,
        type: "tool.call",
        data: {
          step: 1,
          callId: "pending",
          name: "echo",
          input: { text: "not completed" }
        }
      });
      await store.dispose();
      const inspection = await inspectSession(
        f.sessionsRoot,
        "unsafe-compact"
      );

      await expect(SessionStore.openForMaintenance({
        sessionsRoot: f.sessionsRoot,
        sessionId: "unsafe-compact",
        expectedHeadUuid: inspection.activeChain.at(-1)!.uuid
      })).rejects.toMatchObject({ code: "UNSAFE_RESUME" });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });
});
