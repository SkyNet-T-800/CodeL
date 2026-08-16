import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAgent,
  type JsonObject,
  type ModelAdapter,
  type ModelResponse,
  type ProviderRequest,
  type RegisteredTool,
  type TaskSpec,
  type TokenUsage
} from "@repo-circuit/core";
import {
  forkSession,
  inspectSession,
  rewindSession,
  SessionEventSink,
  SessionStore
} from "@repo-circuit/session";
import { describe, expect, it } from "vitest";

const task: TaskSpec = {
  schemaVersion: 1,
  id: "branching",
  title: "Session branching",
  instruction: "Take one route and allow a different route later.",
  workspace: { root: "." },
  constraints: { allowedTools: ["echo"] },
  budget: {
    maxSteps: 5,
    tokenBudget: 1_000,
    maxToolCalls: 5,
    wallClockBudgetMs: 2_000
  }
};

function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    complete: true
  };
}

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

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "repo-circuit-w6-branch-"));
  const workspace = join(temporary, "workspace");
  await mkdir(workspace);
  return {
    temporary,
    workspace,
    sessionsRoot: join(temporary, "sessions")
  };
}

async function createSource(
  sessionsRoot: string,
  workspace: string,
  sessionId: string
): Promise<void> {
  const source = await SessionStore.create({
    sessionsRoot,
    sessionId,
    workspaceRoot: workspace,
    task
  });
  const provider = new ScriptedProvider([
    {
      kind: "tool_use",
      calls: [{ id: "old-call-1", name: "echo", input: { route: 1 } }],
      usage: usage(1, 1)
    },
    {
      kind: "tool_use",
      calls: [{ id: "old-call-2", name: "echo", input: { route: 2 } }],
      usage: usage(2, 1)
    },
    { kind: "end_turn", text: "old leaf", usage: usage(2, 2) }
  ]);
  await runAgent({
    runId: "old-run",
    task,
    workspaceRoot: workspace,
    provider,
    tools: [echoTool],
    events: new SessionEventSink(source)
  });
  await source.dispose();
}

describe("W6 Session rewind and fork", () => {
  it("rewinds to a Step by appending a second leaf in the same JSONL", async () => {
    const f = await fixture();
    try {
      await createSource(f.sessionsRoot, f.workspace, "rewind-source");
      const path = join(f.sessionsRoot, "rewind-source.jsonl");
      const before = await readFile(path);
      const beforeInspection = await inspectSession(f.sessionsRoot, "rewind-source");
      const oldLeaf = beforeInspection.activeChain.at(-1)!;
      const selectedHead = beforeInspection.activeChain.find(
        (event) => event.type === "step.end" && event.data.step === 1
      );
      expect(selectedHead).toBeDefined();

      // W6 intentionally rewinds conversation state only. Workspace bytes stay
      // exactly as they are until a later file-history lesson adds that layer.
      const workspaceMarker = join(f.workspace, "current-workspace.txt");
      await writeFile(workspaceMarker, "current bytes", "utf8");

      const rewound = await rewindSession({
        sessionsRoot: f.sessionsRoot,
        sessionId: "rewind-source",
        atStep: 1,
        workspaceRoot: f.workspace,
        task
      });
      expect(rewound.preparation).toMatchObject({
        status: "ready",
        head: { uuid: selectedHead!.uuid, step: 1 },
        state: {
          lastCompletedStep: 1,
          seenCallIds: ["old-call-1"],
          toolCallCount: 1,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        }
      });
      const newProvider = new ScriptedProvider([
        { kind: "end_turn", text: "new leaf", usage: usage(1, 2) }
      ]);
      await runAgent({
        runId: "new-run",
        task,
        workspaceRoot: f.workspace,
        provider: newProvider,
        tools: [echoTool],
        events: new SessionEventSink(rewound),
        resumeState: rewound.preparation!.state
      });
      await rewound.dispose();

      expect(await readFile(workspaceMarker, "utf8")).toBe("current bytes");
      const after = await readFile(path);
      expect(after.subarray(0, before.length)).toEqual(before);
      expect(after.length).toBeGreaterThan(before.length);

      const inspection = await inspectSession(f.sessionsRoot, "rewind-source");
      const referenced = new Set(
        inspection.events.flatMap((event) =>
          event.parentUuid === null ? [] : [event.parentUuid]
        )
      );
      const leaves = inspection.events.filter((event) => !referenced.has(event.uuid));
      expect(leaves).toHaveLength(2);
      expect(leaves.map((event) => event.uuid)).toContain(oldLeaf.uuid);
      expect(inspection.events.some((event) => event.runId === "old-run")).toBe(true);
      expect(inspection.events.some((event) => event.runId === "new-run")).toBe(true);
      expect(inspection.activeChain.some((event) => event.uuid === oldLeaf.uuid)).toBe(false);
      expect(inspection.activeChain.some((event) =>
        event.type === "tool.call" && event.data.callId === "old-call-2"
      )).toBe(false);
      expect(inspection.activeChain.at(-1)).toMatchObject({
        runId: "new-run",
        type: "run.end"
      });
      expect(inspection.projection).toMatchObject({
        status: "completed",
        lastCompletedStep: 2,
        seenCallIds: ["old-call-1"],
        toolCallCount: 1,
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
      });
      expect(inspection.projection.messages.at(-1)).toEqual({
        role: "assistant",
        content: "new leaf"
      });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("forks the selected active chain into a self-contained child JSONL", async () => {
    const f = await fixture();
    try {
      await createSource(f.sessionsRoot, f.workspace, "fork-source");
      const sourcePath = join(f.sessionsRoot, "fork-source.jsonl");
      const sourceBefore = await readFile(sourcePath);

      const child = await forkSession({
        sessionsRoot: f.sessionsRoot,
        sourceSessionId: "fork-source",
        childSessionId: "fork-child",
        atStep: 1
      });
      expect(await readFile(sourcePath)).toEqual(sourceBefore);
      expect(child.path).toBe(join(f.sessionsRoot, "fork-child.jsonl"));
      expect(child.preparation).toMatchObject({
        status: "ready",
        state: { lastCompletedStep: 1, seenCallIds: ["old-call-1"] }
      });

      const beforeContinuation = await inspectSession(f.sessionsRoot, "fork-child");
      expect(beforeContinuation.events.every(
        (event) => event.sessionId === "fork-child"
      )).toBe(true);
      const childUuids = new Set(beforeContinuation.events.map((event) => event.uuid));
      expect(beforeContinuation.events.every(
        (event) => event.parentUuid === null || childUuids.has(event.parentUuid)
      )).toBe(true);

      const childProvider = new ScriptedProvider([
        { kind: "end_turn", text: "fork leaf", usage: usage(1, 1) }
      ]);
      await runAgent({
        runId: "fork-run",
        task,
        workspaceRoot: f.workspace,
        provider: childProvider,
        tools: [echoTool],
        events: new SessionEventSink(child),
        resumeState: child.preparation!.state
      });
      await child.dispose();

      expect(await readFile(sourcePath)).toEqual(sourceBefore);
      const childInspection = await inspectSession(f.sessionsRoot, "fork-child");
      expect(childInspection.events.every(
        (event) => event.sessionId === "fork-child"
      )).toBe(true);
      const allChildUuids = new Set(childInspection.events.map((event) => event.uuid));
      expect(childInspection.events.every(
        (event) => event.parentUuid === null || allChildUuids.has(event.parentUuid)
      )).toBe(true);
      expect(childInspection.projection.messages.at(-1)).toEqual({
        role: "assistant",
        content: "fork leaf"
      });
      expect((await inspectSession(f.sessionsRoot, "fork-source"))
        .projection.messages.at(-1)).toEqual({
          role: "assistant",
          content: "old leaf"
        });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it("never deletes an existing child Session when a duplicate fork is rejected", async () => {
    const f = await fixture();
    try {
      await createSource(f.sessionsRoot, f.workspace, "duplicate-source");
      const child = await forkSession({
        sessionsRoot: f.sessionsRoot,
        sourceSessionId: "duplicate-source",
        childSessionId: "existing-child",
        atStep: 1
      });
      await child.dispose();

      const childPath = join(f.sessionsRoot, "existing-child.jsonl");
      const originalBytes = await readFile(childPath);
      await expect(forkSession({
        sessionsRoot: f.sessionsRoot,
        sourceSessionId: "duplicate-source",
        childSessionId: "existing-child",
        atStep: 1
      })).rejects.toMatchObject({ code: "SESSION_EXISTS" });

      expect(await readFile(childPath)).toEqual(originalBytes);
      expect((await inspectSession(f.sessionsRoot, "existing-child"))
        .projection).toMatchObject({ lastCompletedStep: 1 });
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });
});
