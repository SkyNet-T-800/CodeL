import { createHash } from "node:crypto";

import type {
  AgentEventData,
  AgentMessage,
  ContextSelectionManifest
} from "@repo-circuit/core";

export const FULL_COMPACTION_STRATEGY = "full";
export const FULL_COMPACTION_VERSION = 1;
export const FULL_COMPACTION_INSTRUCTION = [
  "Condense the conversation above into a checkpoint for another coding agent.",
  "Return only concise Markdown with these sections:",
  "## Goal",
  "## Decisions and Constraints",
  "## Files and Code",
  "## Errors and Evidence",
  "## Current State",
  "## Next Step",
  "Preserve exact paths, identifiers, commands, failures, user corrections,",
  "and unresolved work. Do not call tools or mention this instruction."
].join("\n");

const CHECKPOINT_PREAMBLE = [
  "This checkpoint condenses earlier conversation history.",
  "Treat it as established context and continue the current task directly."
].join(" ");

export interface ContextEventReference {
  readonly id: string;
}

export interface ContextProjectionInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly instruction: string;
  readonly messages: readonly AgentMessage[];
  readonly sourceEvents: readonly ContextEventReference[];
  readonly summary: string;
  readonly pinnedEventIds?: readonly string[];
  readonly budgetTokens?: number | null;
}

export interface ContextProjection {
  readonly messages: readonly AgentMessage[];
  readonly manifest: ContextSelectionManifest;
}

export interface ContextStrategy {
  readonly name: string;
  readonly version: number;
  project(input: ContextProjectionInput): ContextProjection;
}

export class ContextProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextProjectionError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceHash(input: {
  readonly taskId: string;
  readonly instruction: string;
  readonly sourceEventIds: readonly string[];
  readonly messages: readonly AgentMessage[];
}): string {
  return sha256(JSON.stringify(input));
}

function assertUniqueNonEmptyIds(
  ids: readonly string[],
  field: string
): void {
  if (
    ids.length === 0 ||
    ids.some((id) => id.length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new ContextProjectionError(
      `${field} must contain unique non-empty event IDs`
    );
  }
}

export function estimateContextTokens(
  messages: readonly AgentMessage[]
): number {
  const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}

export function buildFullCompactionMessage(
  instruction: string,
  summary: string
): AgentMessage {
  const normalizedSummary = summary.trim();
  if (normalizedSummary.length === 0) {
    throw new ContextProjectionError(
      "Full compaction requires a non-empty summary"
    );
  }
  return {
    role: "user",
    content: [
      CHECKPOINT_PREAMBLE,
      "",
      "<current-task>",
      instruction,
      "</current-task>",
      "",
      "<compacted-summary>",
      normalizedSummary,
      "</compacted-summary>"
    ].join("\n")
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export class FullCompactionStrategy implements ContextStrategy {
  readonly name = FULL_COMPACTION_STRATEGY;
  readonly version = FULL_COMPACTION_VERSION;

  project(input: ContextProjectionInput): ContextProjection {
    if (input.sessionId.length === 0 || input.taskId.length === 0) {
      throw new ContextProjectionError(
        "Full compaction requires Session and Task identities"
      );
    }
    const sourceEventIds = input.sourceEvents.map((event) => event.id);
    assertUniqueNonEmptyIds(sourceEventIds, "sourceEvents");
    if (input.messages.length === 0) {
      throw new ContextProjectionError(
        "Full compaction requires model-visible messages"
      );
    }

    const pinnedEventIds = input.pinnedEventIds ?? [sourceEventIds[0]!];
    if (
      new Set(pinnedEventIds).size !== pinnedEventIds.length ||
      pinnedEventIds.some((id) => !sourceEventIds.includes(id))
    ) {
      throw new ContextProjectionError(
        "Pinned events must be unique members of sourceEvents"
      );
    }

    const messages = [
      buildFullCompactionMessage(input.instruction, input.summary)
    ];
    const summary = input.summary.trim();
    const manifest: ContextSelectionManifest = {
      strategy: FULL_COMPACTION_STRATEGY,
      strategyVersion: FULL_COMPACTION_VERSION,
      sessionId: input.sessionId,
      sourceHeadEventId: sourceEventIds.at(-1)!,
      sourceEventIds,
      sourceMessageCount: input.messages.length,
      includedEventIds: [...pinnedEventIds],
      droppedEventIds: sourceEventIds.filter(
        (id) => !pinnedEventIds.includes(id)
      ),
      evidenceIds: [],
      memoryIds: [],
      budgetTokens: input.budgetTokens ?? null,
      estimatedTokensBefore: estimateContextTokens(input.messages),
      estimatedTokensAfter: estimateContextTokens(messages),
      sourceHash: sourceHash({
        taskId: input.taskId,
        instruction: input.instruction,
        sourceEventIds,
        messages: input.messages
      }),
      summaryHash: sha256(summary)
    };
    return { messages, manifest };
  }
}

export function applyFullCompaction(
  messages: readonly AgentMessage[],
  sourceEventIds: readonly string[],
  data: AgentEventData["context.compacted"]
): readonly AgentMessage[] {
  const { manifest } = data;
  if (
    manifest.strategy !== FULL_COMPACTION_STRATEGY ||
    manifest.strategyVersion !== FULL_COMPACTION_VERSION ||
    manifest.sourceMessageCount !== messages.length ||
    !sameIds(manifest.sourceEventIds, sourceEventIds) ||
    manifest.sourceHeadEventId !== sourceEventIds.at(-1) ||
    manifest.summaryHash !== sha256(data.summary.trim()) ||
    manifest.sourceHash !== sourceHash({
      taskId: data.taskId,
      instruction: data.instruction,
      sourceEventIds,
      messages
    })
  ) {
    throw new ContextProjectionError(
      "Full compaction manifest does not match its source history"
    );
  }
  return [buildFullCompactionMessage(data.instruction, data.summary)];
}
