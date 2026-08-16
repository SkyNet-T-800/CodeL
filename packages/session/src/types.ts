import type {
  AgentEvent,
  AgentMessage,
  AgentResumeState,
  TokenUsage
} from "@repo-circuit/core";

/**
 * One physical JSONL row.
 *
 * The Agent event stays at the top level. The extra fields only describe the
 * conversation graph, following Claude's uuid/parentUuid transcript model;
 * there is no second Session-event envelope.
 */
export type SessionLogEvent = AgentEvent & {
  readonly sessionId: string;
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly timestamp: string;
  readonly cwd: string;
};

export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly step: number;
}

export interface SessionProjection {
  readonly sessionId: string;
  readonly status: "open" | "completed" | "failed" | "interrupted";
  readonly messages: readonly AgentMessage[];
  readonly usage: TokenUsage;
  readonly toolCallCount: number;
  readonly lastCompletedStep: number;
  readonly seenCallIds: readonly string[];
  readonly pendingToolCalls: readonly PendingToolCall[];
}

export interface SessionHead {
  readonly uuid: string;
  readonly step: number;
}

export type ResumePreparation =
  | {
      readonly status: "ready";
      readonly head: SessionHead;
      readonly state: AgentResumeState;
      /** Events on the selected leaf that are abandoned as an unsafe tail. */
      readonly ignoredTailEvents: number;
    }
  | {
      readonly status: "manual_required";
      readonly code:
        | "NO_SAFE_POINT"
        | "UNKNOWN_TOOL_OUTCOME"
        | "SIDE_EFFECT_AFTER_SAFE_POINT";
      readonly message: string;
      readonly pendingToolCalls: readonly PendingToolCall[];
    };

export interface SessionInspection {
  readonly sessionId: string;
  readonly path: string;
  /** Every physical row, including abandoned branches. */
  readonly events: readonly SessionLogEvent[];
  /** The last physically appended leaf followed through parentUuid to root. */
  readonly activeChain: readonly SessionLogEvent[];
  readonly projection: SessionProjection;
  readonly tornTailDetected: boolean;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly path: string;
  readonly cwd: string | null;
  readonly updatedAt: string | null;
  readonly eventCount: number;
  readonly activeEventCount: number;
  readonly status: SessionProjection["status"];
}
