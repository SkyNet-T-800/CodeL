import type {
  AgentMessage,
  AgentResumeState,
  ContextSelectionManifest,
  ToolCall,
  TokenUsage
} from "@repo-circuit/core";
import { applyFullCompaction } from "@repo-circuit/context";

import { SessionError } from "./errors.js";
import type {
  PendingToolCall,
  ResumePreparation,
  SessionLogEvent,
  SessionProjection
} from "./types.js";

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  complete: true
};

type AssistantToolMessage = {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly reasoningContent?: string;
};

function isAssistantToolMessage(
  message: AgentMessage | undefined
): message is AssistantToolMessage {
  return (
    message?.role === "assistant" &&
    "toolCalls" in message &&
    Array.isArray(message.toolCalls)
  );
}

function addToolCallToRunStepMessage(
  messages: readonly AgentMessage[],
  event: Extract<SessionLogEvent, { readonly type: "tool.call" }>,
  messageIndexByRunStep: Map<string, number>
): readonly AgentMessage[] {
  const call = {
    id: event.data.callId,
    name: event.data.name,
    input: event.data.input
  };
  const key = `${event.runId}:${event.data.step}`;
  const existingIndex = messageIndexByRunStep.get(key);
  if (existingIndex !== undefined) {
    const existing = messages[existingIndex];
    if (!isAssistantToolMessage(existing)) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `Tool-call message for ${key} is inconsistent`
      );
    }
    if (
      (event.data.assistantContent !== undefined &&
        event.data.assistantContent !== existing.content) ||
      (event.data.reasoningContent !== undefined &&
        event.data.reasoningContent !== existing.reasoningContent)
    ) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `Tool-call assistant content for ${key} is inconsistent`
      );
    }
    const updated = [...messages];
    updated[existingIndex] = {
      ...existing,
      toolCalls: [...existing.toolCalls, call]
    };
    return updated;
  }
  messageIndexByRunStep.set(key, messages.length);
  return [
    ...messages,
    {
      role: "assistant",
      content: event.data.assistantContent ?? "",
      toolCalls: [call],
      ...(event.data.reasoningContent === undefined
        ? {}
        : { reasoningContent: event.data.reasoningContent })
    }
  ];
}

interface ProjectionAccumulator {
  status: SessionProjection["status"];
  messages: readonly AgentMessage[];
  usage: TokenUsage;
  toolCallCount: number;
  lastCompletedStep: number;
  seenCallIds: Set<string>;
  pending: Map<string, PendingToolCall>;
  toolMessageIndexByRunStep: Map<string, number>;
  contextSelectionManifest: ContextSelectionManifest | undefined;
}

function applyAgentEventToProjection(
  state: ProjectionAccumulator,
  event: SessionLogEvent,
  sourceEventIds: readonly string[]
): void {
  switch (event.type) {
    case "run.begin":
      state.status = "open";
      if (state.messages.length === 0) {
        state.messages = [{ role: "user", content: event.data.instruction }];
      }
      return;
    case "step.begin":
    case "text.delta":
      return;
    case "usage.recorded":
      state.usage = { ...event.data.cumulative };
      return;
    case "tool.call": {
      state.toolCallCount += 1;
      state.seenCallIds.add(event.data.callId);
      state.pending.set(event.data.callId, {
        callId: event.data.callId,
        name: event.data.name,
        step: event.data.step
      });
      state.messages = addToolCallToRunStepMessage(
        state.messages,
        event,
        state.toolMessageIndexByRunStep
      );
      return;
    }
    case "tool.result": {
      const pending = state.pending.get(event.data.callId);
      if (
        pending === undefined ||
        pending.name !== event.data.name ||
        pending.step !== event.data.step
      ) {
        throw new SessionError(
          "CORRUPT_EVENT_LOG",
          `Tool result has no matching call: ${event.data.callId}`
        );
      }
      state.pending.delete(event.data.callId);
      state.messages = [
        ...state.messages,
        {
          role: "tool",
          callId: event.data.callId,
          name: event.data.name,
          result: event.data.result
        }
      ];
      return;
    }
    case "assistant.final":
      state.messages = [
        ...state.messages,
        {
          role: "assistant",
          content: event.data.text,
          ...(event.data.reasoningContent === undefined
            ? {}
            : { reasoningContent: event.data.reasoningContent })
        }
      ];
      return;
    case "step.end":
      if (state.pending.size > 0) {
        throw new SessionError(
          "CORRUPT_EVENT_LOG",
          `Step ${event.data.step} ended with pending Tool calls`
        );
      }
      state.lastCompletedStep = Math.max(
        state.lastCompletedStep,
        event.data.step
      );
      return;
    case "run.end":
      state.status = "completed";
      return;
    case "run.error":
      state.status = "failed";
      return;
    case "turn.interrupted":
      if (state.messages.length === 0) {
        state.messages = [
          { role: "user", content: event.data.instruction }
        ];
      }
      state.status = "interrupted";
      return;
    case "context.compacted":
      if (state.pending.size > 0) {
        throw new SessionError(
          "CORRUPT_EVENT_LOG",
          "Context compaction crosses a pending Tool call"
        );
      }
      try {
        state.messages = applyFullCompaction(
          state.messages,
          sourceEventIds,
          event.data
        );
      } catch (error) {
        throw new SessionError(
          "CORRUPT_EVENT_LOG",
          "Context compaction manifest is inconsistent",
          { cause: error }
        );
      }
      state.contextSelectionManifest = event.data.manifest;
      state.toolMessageIndexByRunStep.clear();
  }
}

function assertAgentSequence(chain: readonly SessionLogEvent[]): void {
    let previous: SessionLogEvent | undefined;
    for (const event of chain) {
        if (previous === undefined || event.runId !== previous.runId) {
            if (
                event.seq !== 1 ||
                (event.type !== "run.begin" &&
                  event.type !== "turn.interrupted" &&
                  event.type !== "context.compacted")
            ) {
                throw new SessionError(
                    "CORRUPT_EVENT_LOG",
                    `Run ${event.runId} has an invalid seq 1 event`
                );
            }
        } else if (event.seq !== previous.seq + 1) {
            throw new SessionError(
                "CORRUPT_EVENT_LOG",
                `Run ${event.runId} has a non-contiguous Agent event sequence`
            )
        }
        previous = event;
    }
}

export function projectSession(
    chain: readonly SessionLogEvent[],
    sessionId: string
): SessionProjection {
    assertAgentSequence(chain);
    const state: ProjectionAccumulator = {
        status: "open",
        messages: [],
        usage: ZERO_USAGE,
        toolCallCount: 0,
        lastCompletedStep: 0,
        seenCallIds: new Set(),
        pending: new Map(),
        toolMessageIndexByRunStep: new Map(),
        contextSelectionManifest: undefined
    };

    const sourceEventIds: string[] = [];
    for (const event of chain) {
        if (event.sessionId !== sessionId) {
            throw new SessionError(
                "CORRUPT_EVENT_LOG",
                `Selected history contains an event owned by ${event.sessionId}`
            );
        }
        applyAgentEventToProjection(state, event, sourceEventIds);
        sourceEventIds.push(event.uuid);
    }

    return {
        sessionId,
        status: state.status,
        messages: state.messages,
        usage: { ...state.usage },
        toolCallCount: state.toolCallCount,
        lastCompletedStep: state.lastCompletedStep,
        seenCallIds: [...state.seenCallIds],
        pendingToolCalls: [...state.pending.values()],
        ...(state.contextSelectionManifest === undefined
          ? {}
          : { contextSelectionManifest: state.contextSelectionManifest })
    }
}

export function resolveActiveChain(
    events: readonly SessionLogEvent[]
): readonly SessionLogEvent[] {
    if (events.length === 0) {
        return [];
    }
    const byUuid = new Map(events.map((event) => [event.uuid, event]));
    const referenced = new Set(
        events.flatMap((event) =>
            event.parentUuid === null ? [] : [event.parentUuid]
        )
    );
    const leaves = events.filter((event) => !referenced.has(event.uuid));
    const leaf = leaves.at(-1);
    if (leaf === undefined) {
        throw new SessionError("CORRUPT_EVENT_LOG", "Session graph has no leaf");
    }

    const reversed: SessionLogEvent[] = [];
    let cursor: SessionLogEvent | undefined = leaf;
    const visited = new Set<string>();
    while (cursor !== undefined) {
        if (visited.has(cursor.uuid)) {
            throw new SessionError("CORRUPT_EVENT_LOG", "Session graph contains a cycle");
        }
        visited.add(cursor.uuid);
        reversed.push(cursor);
        cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid);
        if (cursor === undefined && reversed.at(-1)?.parentUuid !== null) {
            throw new SessionError("CORRUPT_EVENT_LOG", "Session graph has a missing parent");
        }
    }
    return reversed.reverse();
}

export function resumeStateFromProjection(
    projection: SessionProjection
): AgentResumeState {
    if (projection.pendingToolCalls.length > 0) {
        throw new SessionError(
            "UNSAFE_RESUME",
            "Cannot create resume state with pending Tool calls"
        );
    }
    return {
        messages: projection.messages,
        usage: projection.usage,
        toolCallCount: projection.toolCallCount,
        lastCompletedStep: projection.lastCompletedStep,
        seenCallIds: projection.seenCallIds
    };
}

function readyFromPrefix(
    chain: readonly SessionLogEvent[],
    sessionId: string,
    endIndex: number
): Extract<ResumePreparation, { readonly status: "ready" }> {
    const prefix = chain.slice(0, endIndex + 1);
    const head = prefix.at(-1);
    if (head === undefined) {
        throw new SessionError("UNSAFE_RESUME", "A resume prefix must not be empty");
    }
    const projection = projectSession(prefix, sessionId);
    return {
        status: "ready",
        head: {
        uuid: head.uuid,
        step: projection.lastCompletedStep
        },
        state: resumeStateFromProjection(projection),
        ignoredTailEvents: chain.length - prefix.length
    };
}

export function prepareResume(
    chain: readonly SessionLogEvent[],
    sessionId: string
): ResumePreparation {
    if (chain.length === 0) {
        return {
            status: "manual_required",
            code: "NO_SAFE_POINT",
            message: "The Session contains no Agent events",
            pendingToolCalls: []
        };
    }

    const fullProjection = projectSession(chain, sessionId);
    if (fullProjection.pendingToolCalls.length > 0) {
        return {
            status: "manual_required",
            code: "UNKNOWN_TOOL_OUTCOME",
            message: "The newest branch ends with a Tool call whose outcome is unknown",
            pendingToolCalls: fullProjection.pendingToolCalls
        };
    }

    let safeIndex = -1;
    for (let index = 0; index < chain.length; index += 1) {
        const event = chain[index];
        if (
            event?.type === "run.begin" ||
            event?.type === "usage.recorded" ||
            event?.type === "step.end" ||
            event?.type === "context.compacted" ||
            (index === 0 && event?.type === "turn.interrupted")
        ) {
            safeIndex = index;
        }
    }

    if (safeIndex === -1) {
        return {
            status: "manual_required",
            code: "NO_SAFE_POINT",
            message: "The newest branch has no recoverable Agent state",
            pendingToolCalls: []
        };
    }

    const tail = chain.slice(safeIndex + 1);
    if (tail.some((event) => event.type === "tool.result")) {
        return {
            status: "manual_required",
            code: "SIDE_EFFECT_AFTER_SAFE_POINT",
            message: "A Tool completed after the latest safe Step",
            pendingToolCalls: []
        };
    }
    const terminalOnly = tail.every((event) =>
        ["run.end", "run.error", "turn.interrupted", "context.compacted"]
          .includes(event.type)
    );
    return readyFromPrefix(
        chain,
        sessionId,
        terminalOnly ? chain.length - 1 : safeIndex
    );
}

export function prepareRewind(
  chain: readonly SessionLogEvent[],
  sessionId: string,
  step: number
): Extract<ResumePreparation, { readonly status: "ready" }> {
  let endIndex = -1;
  if (step === 0) {
    endIndex = chain.findIndex((event, index) =>
      event.type === "run.begin" ||
      (index === 0 && event.type === "turn.interrupted")
    );
  } else {
    for (let index = 0; index < chain.length; index += 1) {
      const event = chain[index];
      if (event?.type === "step.end" && event.data.step === step) {
        endIndex = index;
      }
    }
  }
  if (endIndex === -1) {
    throw new SessionError(
      "REWIND_POINT_NOT_FOUND",
      `Completed Step ${step} is not on the active Session branch`
    );
  }
  return readyFromPrefix(chain, sessionId, endIndex);
}

export function chainThroughHead(
  chain: readonly SessionLogEvent[],
  headUuid: string
): readonly SessionLogEvent[] {
  const index = chain.findIndex((event) => event.uuid === headUuid);
  if (index === -1) {
    throw new SessionError(
      "CORRUPT_EVENT_LOG",
      `Selected Session head does not exist: ${headUuid}`
    );
  }
  return chain.slice(0, index + 1);
}
