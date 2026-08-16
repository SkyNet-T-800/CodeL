import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  inspectSession,
  SessionEventSink,
  SessionStore
} from "@repo-circuit/session";
import { describe, expect, it } from "vitest";

const usage = (
  inputTokens: number,
  outputTokens: number
): NonNullable<ModelResponse["usage"]> => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  complete: true
});

const task: TaskSpec = {
  schemaVersion: 1,
  id: "w6-session",
  title: "W6 Session",
  instruction: "Inspect once, then finish.",
  workspace: { root: "." },
  constraints: { allowedTools: ["echo"] },
  budget: {
    maxSteps: 5,
    tokenBudget: 1_000,
    maxToolCalls: 5,
    wallClockBudgetMs: 2_000
  }
};

class ScriptedProvider implements ModelAdapter {
  readonly name = "scripted";
  readonly #responses: ModelResponse[];
  readonly requests: ProviderRequest[] = [];

  constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  async complete(request: ProviderRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("Provider script exhausted");
    return response;
  }
}

function echoTool(onInvoke: (input: JsonObject) => void): RegisteredTool {
  return {
    definition: {
      name: "echo",
      description: "Return the input",
      inputSchema: { type: "object" }
    },
    async invoke(input) {
      onInvoke(input);
      return { ok: true, output: input };
    }
  };
}

async function fixture(): Promise<{
  readonly temporary: string;
  readonly sessionsRoot: string;
  readonly workspace: string;
}> {
  const temporary = await mkdtemp(join(tmpdir(), "repo-circuit-w6-session-"));
  const workspace = join(temporary, "workspace");
  await mkdir(workspace);
  return {
    temporary,
    sessionsRoot: join(temporary, "sessions"),
    workspace: await realpath(workspace)
  };
}

describe("W6 Session lifecycle", () => {
  it("stores one top-level AgentEvent per line in one <sessionId>.jsonl", async () => {
    const f = await fixture();
    try {
      let toolInvocations = 0;
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "lifecycle",
        workspaceRoot: f.workspace,
        task
      });
      const firstProvider = new ScriptedProvider([
        {
          kind: "tool_use",
          calls: [{ id: "echo-1", name: "echo", input: { text: "hello" } }],
          usage: usage(2, 1)
        },
        { kind: "end_turn", text: "first leaf", usage: usage(3, 2) }
      ]);
      await runAgent({
        runId: "run-1",
        task,
        workspaceRoot: f.workspace,
        provider: firstProvider,
        tools: [echoTool(() => { toolInvocations += 1; })],
        events: new SessionEventSink(store)
      });
      await store.dispose();

      const path = join(f.sessionsRoot, "lifecycle.jsonl");
      const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
      const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows.length).toBeGreaterThan(0);
      expect(toolInvocations).toBe(1);
      for (const row of rows) {
        expect(row).toMatchObject({
          schemaVersion: 1,
          sessionId: "lifecycle",
          cwd: f.workspace
        });
        expect(typeof row.type).toBe("string");
        expect(typeof row.runId).toBe("string");
        expect(typeof row.seq).toBe("number");
        expect(typeof row.uuid).toBe("string");
        expect(row.parentUuid === null || typeof row.parentUuid === "string").toBe(true);
        expect(Number.isNaN(Date.parse(String(row.timestamp)))).toBe(false);
        expect(row).not.toHaveProperty("event");
        expect(row).not.toHaveProperty("checkpointId");
      }
      expect(rows.map((row) => row.type)).not.toContain("checkpoint.saved");
      expect(rows.map((row) => row.type)).not.toContain("file.version");
      await expect(access(join(f.sessionsRoot, "lifecycle", "manifest.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const inspection = await inspectSession(f.sessionsRoot, "lifecycle");
      expect(inspection.path).toBe(path);
      expect(inspection.events).toHaveLength(rows.length);
      expect(inspection.activeChain).toHaveLength(rows.length);
      expect(inspection.projection).toMatchObject({
        status: "completed",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        toolCallCount: 1,
        lastCompletedStep: 2,
        seenCallIds: ["echo-1"],
        pendingToolCalls: []
      });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("resumes the same Session ID with restored messages, usage, and call IDs", async () => {
    const f = await fixture();
    try {
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "resume-same-id",
        workspaceRoot: f.workspace,
        task
      });
      const firstProvider = new ScriptedProvider([
        {
          kind: "tool_use",
          calls: [{ id: "echo-1", name: "echo", input: { text: "hello" } }],
          usage: usage(2, 1)
        },
        { kind: "end_turn", text: "first leaf", usage: usage(3, 2) }
      ]);
      await runAgent({
        runId: "run-1",
        task,
        workspaceRoot: f.workspace,
        provider: firstProvider,
        tools: [echoTool(() => undefined)],
        events: new SessionEventSink(store)
      });
      await store.dispose();

      const path = join(f.sessionsRoot, "resume-same-id.jsonl");
      const before = await readFile(path);
      const resumed = await SessionStore.openForResume({
        sessionsRoot: f.sessionsRoot,
        sessionId: "resume-same-id",
        workspaceRoot: f.workspace,
        task
      });
      expect(resumed.sessionId).toBe("resume-same-id");
      expect(resumed.preparation).toMatchObject({
        status: "ready",
        ignoredTailEvents: 0,
        state: {
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          toolCallCount: 1,
          lastCompletedStep: 2,
          seenCallIds: ["echo-1"]
        }
      });
      expect(resumed.preparation!.state.messages).toEqual([
        { role: "user", content: task.instruction },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "echo-1", name: "echo", input: { text: "hello" } }]
        },
        {
          role: "tool",
          callId: "echo-1",
          name: "echo",
          result: { ok: true, output: { text: "hello" } }
        },
        { role: "assistant", content: "first leaf" }
      ]);

      const secondProvider = new ScriptedProvider([
        { kind: "end_turn", text: "continued", usage: usage(1, 1) }
      ]);
      await runAgent({
        runId: "run-2",
        task,
        workspaceRoot: f.workspace,
        provider: secondProvider,
        tools: [echoTool(() => undefined)],
        events: new SessionEventSink(resumed),
        resumeState: resumed.preparation!.state
      });
      await resumed.dispose();

      const after = await readFile(path);
      expect(after.subarray(0, before.length)).toEqual(before);
      expect(after.length).toBeGreaterThan(before.length);
      expect(secondProvider.requests[0]?.messages).toEqual(
        resumed.preparation!.state.messages
      );
      const inspection = await inspectSession(f.sessionsRoot, "resume-same-id");
      expect(new Set(inspection.events.map((event) => event.sessionId))).toEqual(
        new Set(["resume-same-id"])
      );
      expect(inspection.projection).toMatchObject({
        status: "completed",
        usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
        toolCallCount: 1,
        lastCompletedStep: 3,
        seenCallIds: ["echo-1"]
      });
      expect(inspection.projection.messages.at(-1)).toEqual({
        role: "assistant",
        content: "continued"
      });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("persists incomplete Usage when a Provider omits accounting", async () => {
    const f = await fixture();
    try {
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "missing-usage",
        workspaceRoot: f.workspace,
        task
      });
      const state = await runAgent({
        runId: "missing-usage-run",
        task,
        workspaceRoot: f.workspace,
        provider: new ScriptedProvider([
          { kind: "end_turn", text: "done without accounting" }
        ]),
        tools: [],
        events: new SessionEventSink(store)
      });
      expect(state.usage.complete).toBe(false);
      await store.dispose();

      const inspection = await inspectSession(f.sessionsRoot, "missing-usage");
      expect(inspection.events.some((event) =>
        event.type === "usage.recorded" && event.data.usage.complete === false
      )).toBe(true);
      expect(inspection.projection.usage).toEqual(state.usage);

      const resumed = await SessionStore.openForResume({
        sessionsRoot: f.sessionsRoot,
        sessionId: "missing-usage",
        workspaceRoot: f.workspace,
        task
      });
      expect(resumed.preparation?.state.usage).toEqual(state.usage);
      await resumed.dispose();
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("persists incomplete Usage when the Provider attempt fails", async () => {
    const f = await fixture();
    try {
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "failed-usage",
        workspaceRoot: f.workspace,
        task
      });
      const provider: ModelAdapter = {
        name: "failing-provider",
        async complete() {
          throw new Error("connection dropped");
        }
      };
      const state = await runAgent({
        runId: "failed-usage-run",
        task,
        workspaceRoot: f.workspace,
        provider,
        tools: [],
        events: new SessionEventSink(store)
      });
      expect(state).toMatchObject({
        status: "failed",
        usage: { complete: false }
      });
      await store.dispose();

      const inspection = await inspectSession(f.sessionsRoot, "failed-usage");
      expect(inspection.projection.usage).toEqual(state.usage);
      expect(await SessionStore.prepareResume(f.sessionsRoot, "failed-usage"))
        .toMatchObject({
          status: "ready",
          state: { usage: state.usage }
        });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("persists incomplete Usage when Provider accounting is invalid", async () => {
    const f = await fixture();
    try {
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "invalid-usage",
        workspaceRoot: f.workspace,
        task
      });
      const state = await runAgent({
        runId: "invalid-usage-run",
        task,
        workspaceRoot: f.workspace,
        provider: new ScriptedProvider([{
          kind: "end_turn",
          text: "invalid accounting must not become a message",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 999,
            complete: true
          }
        }]),
        tools: [],
        events: new SessionEventSink(store)
      });
      expect(state).toMatchObject({
        status: "failed",
        usage: { complete: false },
        error: { code: "PROVIDER_PROTOCOL_ERROR" }
      });
      await store.dispose();

      const inspection = await inspectSession(f.sessionsRoot, "invalid-usage");
      expect(inspection.projection.usage).toEqual(state.usage);
      expect(inspection.projection.messages).toEqual([
        { role: "user", content: task.instruction }
      ]);
      expect(await SessionStore.prepareResume(f.sessionsRoot, "invalid-usage"))
        .toMatchObject({
          status: "ready",
          state: { usage: state.usage }
        });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("rejects an over-budget Tool batch before messages, logs, or execution diverge", async () => {
    const f = await fixture();
    try {
      const limitedTask: TaskSpec = {
        ...task,
        budget: { ...task.budget, maxToolCalls: 1 }
      };
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "tool-batch-budget",
        workspaceRoot: f.workspace,
        task: limitedTask
      });
      let invocations = 0;
      const state = await runAgent({
        runId: "tool-batch-budget-run",
        task: limitedTask,
        workspaceRoot: f.workspace,
        provider: new ScriptedProvider([{
          kind: "tool_use",
          calls: [
            { id: "batch-a", name: "echo", input: { value: "a" } },
            { id: "batch-b", name: "echo", input: { value: "b" } }
          ],
          usage: usage(2, 1)
        }]),
        tools: [echoTool(() => { invocations += 1; })],
        events: new SessionEventSink(store)
      });
      expect(state).toMatchObject({
        status: "failed",
        toolCallCount: 0,
        error: { code: "TOOL_CALL_BUDGET_EXHAUSTED" }
      });
      expect(invocations).toBe(0);
      await store.dispose();

      const inspection = await inspectSession(
        f.sessionsRoot,
        "tool-batch-budget"
      );
      expect(inspection.events.some((event) => event.type === "tool.call"))
        .toBe(false);
      expect(inspection.projection.messages).toEqual(state.messages);
      expect(inspection.projection.toolCallCount).toBe(state.toolCallCount);
      expect(await SessionStore.prepareResume(
        f.sessionsRoot,
        "tool-batch-budget"
      )).toMatchObject({
        status: "ready",
        state: {
          messages: state.messages,
          toolCallCount: state.toolCallCount
        }
      });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("resumes a Run that was interrupted before run.begin was committed", async () => {
    const f = await fixture();
    try {
      const store = await SessionStore.create({
        sessionsRoot: f.sessionsRoot,
        sessionId: "pre-start-interruption",
        workspaceRoot: f.workspace,
        task
      });
      const controller = new AbortController();
      controller.abort(new Error("cancelled before start"));
      await runAgent({
        runId: "cancelled-run",
        task,
        workspaceRoot: f.workspace,
        provider: new ScriptedProvider([
          { kind: "end_turn", text: "unreachable", usage: usage(1, 1) }
        ]),
        tools: [],
        events: new SessionEventSink(store),
        signal: controller.signal
      });
      await store.dispose();

      const interrupted = await inspectSession(
        f.sessionsRoot,
        "pre-start-interruption"
      );
      expect(interrupted.events.map((event) => event.type)).toEqual([
        "turn.interrupted"
      ]);
      expect(interrupted.projection.messages).toEqual([
        { role: "user", content: task.instruction }
      ]);

      const resumed = await SessionStore.openForResume({
        sessionsRoot: f.sessionsRoot,
        sessionId: "pre-start-interruption",
        workspaceRoot: f.workspace,
        task
      });
      expect(resumed.preparation).toMatchObject({
        status: "ready",
        head: { step: 0 },
        state: {
          messages: [{ role: "user", content: task.instruction }],
          lastCompletedStep: 0
        }
      });
      await runAgent({
        runId: "resumed-run",
        task,
        workspaceRoot: f.workspace,
        provider: new ScriptedProvider([
          { kind: "end_turn", text: "resumed", usage: usage(1, 1) }
        ]),
        tools: [],
        events: new SessionEventSink(resumed),
        resumeState: resumed.preparation!.state
      });
      await resumed.dispose();
      expect((await inspectSession(f.sessionsRoot, "pre-start-interruption"))
        .projection.messages.at(-1)).toEqual({
          role: "assistant",
          content: "resumed"
        });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });
});
