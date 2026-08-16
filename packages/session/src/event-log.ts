import {
  mkdir,
  open,
  readFile,
  rm,
  type FileHandle
} from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentEvent, TokenUsage } from "@repo-circuit/core";

import { SessionError } from "./errors.js";
import type { SessionLogEvent } from "./types.js";

const AGENT_EVENT_TYPES = new Set([
  "run.begin",
  "step.begin",
  "text.delta",
  "usage.recorded",
  "tool.call",
  "tool.result",
  "assistant.final",
  "step.end",
  "run.end",
  "run.error",
  "turn.interrupted"
]);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTokenUsage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.inputTokens) ||
    !isNonNegativeInteger(value.outputTokens) ||
    !isNonNegativeInteger(value.totalTokens) ||
    typeof value.complete !== "boolean"
  ) {
    return false;
  }
  return value.totalTokens === value.inputTokens + value.outputTokens;
}

function isAgentError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.message) &&
    (value.phase === undefined ||
      ["provider", "tool", "loop", "recorder"].includes(
        value.phase as string
      )) &&
    (value.retryable === undefined || typeof value.retryable === "boolean") &&
    (value.details === undefined || isRecord(value.details))
  );
}

function isToolResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  return value.ok
    ? Object.hasOwn(value, "output")
    : isAgentError(value.error);
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.runId) ||
    !isPositiveInteger(value.seq) ||
    typeof value.type !== "string" ||
    !AGENT_EVENT_TYPES.has(value.type) ||
    !isRecord(value.data)
  ) {
    return false;
  }
  const data = value.data;
  switch (value.type) {
    case "run.begin":
      return isNonEmptyString(data.taskId) && typeof data.instruction === "string";
    case "step.begin":
      return isPositiveInteger(data.step);
    case "text.delta":
      return isPositiveInteger(data.step) && typeof data.delta === "string";
    case "usage.recorded":
      return (
        isPositiveInteger(data.step) &&
        isTokenUsage(data.usage) &&
        isTokenUsage(data.cumulative)
      );
    case "tool.call":
      return (
        isPositiveInteger(data.step) &&
        isNonEmptyString(data.callId) &&
        isNonEmptyString(data.name) &&
        isRecord(data.input)
      );
    case "tool.result":
      return (
        isPositiveInteger(data.step) &&
        isNonEmptyString(data.callId) &&
        isNonEmptyString(data.name) &&
        isToolResult(data.result)
      );
    case "assistant.final":
      return isPositiveInteger(data.step) && typeof data.text === "string";
    case "step.end":
      return (
        isPositiveInteger(data.step) &&
        ["tool_use", "end_turn", "budget_exhausted", "error"].includes(
          data.reason as string
        )
      );
    case "run.end":
      return (
        data.status === "completed" &&
        isNonNegativeInteger(data.steps) &&
        (data.terminalReason === undefined || data.terminalReason === "end_turn")
      );
    case "run.error":
      return isNonNegativeInteger(data.steps) && isAgentError(data.error);
    case "turn.interrupted":
      return (
        isNonEmptyString(data.taskId) &&
        typeof data.instruction === "string" &&
        isNonNegativeInteger(data.steps) &&
        isAgentError(data.error)
      );
    default:
      return false;
  }
}

function hasValidSessionMetadata(
  value: unknown,
  expectedSessionId: string
): value is SessionLogEvent {
  return (
    isRecord(value) &&
    value.sessionId === expectedSessionId &&
    isNonEmptyString(value.uuid) &&
    (value.parentUuid === null || isNonEmptyString(value.parentUuid)) &&
    isNonEmptyString(value.timestamp) &&
    !Number.isNaN(Date.parse(value.timestamp)) &&
    isNonEmptyString(value.cwd) &&
    isAgentEvent(value)
  );
}

function parseLogEvent(
  line: string,
  expectedSessionId: string,
  lineNumber: number
): SessionLogEvent {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new SessionError(
      "CORRUPT_EVENT_LOG",
      `Session JSONL line ${lineNumber} is not valid JSON`,
      { cause: error }
    );
  }
  if (!hasValidSessionMetadata(value, expectedSessionId)) {
    throw new SessionError(
      "CORRUPT_EVENT_LOG",
      `Session JSONL line ${lineNumber} has an invalid event`
    );
  }
  return value as unknown as SessionLogEvent;
}

type StepEndReason = Extract<
  AgentEvent,
  { readonly type: "step.end" }
>["data"]["reason"];

interface ProtocolState {
  readonly taskId: string;
  readonly instruction: string;
  readonly runId: string;
  readonly terminal: boolean;
  readonly openStep: number | undefined;
  readonly lastCompletedStep: number;
  readonly usageRecorded: boolean;
  readonly assistantFinal: boolean;
  readonly toolCallCountInStep: number;
  readonly pending: ReadonlyMap<string, { readonly name: string; readonly step: number }>;
  readonly lastStepReason: StepEndReason | undefined;
  readonly usage: TokenUsage;
}

function corrupt(message: string): never {
  throw new SessionError("CORRUPT_EVENT_LOG", message);
}

function taskFromRunStart(event: SessionLogEvent): {
  readonly taskId: string;
  readonly instruction: string;
} {
  if (event.type === "run.begin" || event.type === "turn.interrupted") {
    return {
      taskId: event.data.taskId,
      instruction: event.data.instruction
    };
  }
  return corrupt(
    `Run ${event.runId} must begin with run.begin or a pre-start interruption`
  );
}

function startProtocolRun(
  event: SessionLogEvent,
  parentEvent: SessionLogEvent | undefined,
  parentState: ProtocolState | undefined
): ProtocolState {
  if (event.seq !== 1) {
    return corrupt(`Run ${event.runId} must start at Agent seq 1`);
  }
  if (
    parentEvent !== undefined &&
    ![
      "run.begin",
      "usage.recorded",
      "step.end",
      "run.end",
      "run.error",
      "turn.interrupted"
    ].includes(parentEvent.type)
  ) {
    return corrupt(
      `Run ${event.runId} branches from unsafe event ${parentEvent.type}`
    );
  }

  const task = taskFromRunStart(event);
  if (
    parentState !== undefined &&
    (task.taskId !== parentState.taskId ||
      task.instruction !== parentState.instruction)
  ) {
    return corrupt(`Run ${event.runId} changes the Session Task`);
  }
  const inheritedStep = parentState?.lastCompletedStep ?? 0;
  if (
    event.type === "turn.interrupted" &&
    event.data.steps !== inheritedStep
  ) {
    return corrupt(
      `Pre-start interruption for Run ${event.runId} reports the wrong Step`
    );
  }
  return {
    ...task,
    runId: event.runId,
    terminal: event.type === "turn.interrupted",
    openStep: undefined,
    lastCompletedStep: inheritedStep,
    usageRecorded: false,
    assistantFinal: false,
    toolCallCountInStep: 0,
    pending: new Map(),
    lastStepReason: undefined,
    usage: parentState?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      complete: true
    }
  };
}

function expectedCumulativeUsage(
  previous: TokenUsage,
  delta: TokenUsage
): TokenUsage {
  return {
    inputTokens: previous.inputTokens + delta.inputTokens,
    outputTokens: previous.outputTokens + delta.outputTokens,
    totalTokens: previous.totalTokens + delta.totalTokens,
    complete: previous.complete && delta.complete
  };
}

function sameUsage(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.complete === right.complete
  );
}

function applyProtocolEvent(
  event: SessionLogEvent,
  previous: ProtocolState
): ProtocolState {
  if (previous.terminal) {
    return corrupt(`Run ${event.runId} contains an event after its terminal`);
  }
  const next = {
    ...previous,
    pending: new Map(previous.pending)
  };
  switch (event.type) {
    case "run.begin":
      return corrupt(`Run ${event.runId} contains a second run.begin`);
    case "step.begin":
      if (
        next.openStep !== undefined ||
        event.data.step !== next.lastCompletedStep + 1
      ) {
        return corrupt(`Run ${event.runId} begins an invalid Step ${event.data.step}`);
      }
      return {
        ...next,
        openStep: event.data.step,
        usageRecorded: false,
        assistantFinal: false,
        toolCallCountInStep: 0,
        pending: new Map(),
        lastStepReason: undefined
      };
    case "text.delta":
      if (next.openStep !== event.data.step || next.assistantFinal) {
        return corrupt(`text.delta is outside open Step ${event.data.step}`);
      }
      return next;
    case "usage.recorded":
      if (
        next.openStep !== event.data.step ||
        next.usageRecorded ||
        next.assistantFinal
      ) {
        return corrupt(`usage.recorded is invalid for Step ${event.data.step}`);
      }
      if (
        !sameUsage(
          event.data.cumulative,
          expectedCumulativeUsage(next.usage, event.data.usage)
        )
      ) {
        return corrupt(`usage.recorded has an invalid cumulative value`);
      }
      return {
        ...next,
        usageRecorded: true,
        usage: { ...event.data.cumulative }
      };
    case "tool.call":
      if (
        next.openStep !== event.data.step ||
        !next.usageRecorded ||
        next.assistantFinal ||
        next.pending.has(event.data.callId)
      ) {
        return corrupt(`Tool call is invalid for Step ${event.data.step}`);
      }
      next.pending.set(event.data.callId, {
        name: event.data.name,
        step: event.data.step
      });
      return {
        ...next,
        toolCallCountInStep: next.toolCallCountInStep + 1
      };
    case "tool.result": {
      const call = next.pending.get(event.data.callId);
      if (
        next.openStep !== event.data.step ||
        call?.name !== event.data.name ||
        call.step !== event.data.step
      ) {
        return corrupt(`Tool result has no matching call: ${event.data.callId}`);
      }
      next.pending.delete(event.data.callId);
      return next;
    }
    case "assistant.final":
      if (
        next.openStep !== event.data.step ||
        !next.usageRecorded ||
        next.assistantFinal ||
        next.toolCallCountInStep !== 0 ||
        next.pending.size !== 0
      ) {
        return corrupt(`assistant.final is invalid for Step ${event.data.step}`);
      }
      return { ...next, assistantFinal: true };
    case "step.end":
      if (
        next.openStep !== event.data.step ||
        !next.usageRecorded ||
        next.pending.size !== 0 ||
        (event.data.reason === "end_turn" && !next.assistantFinal) ||
        (event.data.reason === "tool_use" &&
          (next.assistantFinal || next.toolCallCountInStep === 0))
      ) {
        return corrupt(`step.end is invalid for Step ${event.data.step}`);
      }
      return {
        ...next,
        openStep: undefined,
        lastCompletedStep: event.data.step,
        lastStepReason: event.data.reason
      };
    case "run.end":
      if (
        next.openStep !== undefined ||
        next.lastStepReason !== "end_turn" ||
        event.data.steps !== next.lastCompletedStep
      ) {
        return corrupt(`run.end is inconsistent for Run ${event.runId}`);
      }
      return { ...next, terminal: true };
    case "run.error":
      if (
        next.openStep !== undefined ||
        event.data.steps !== next.lastCompletedStep
      ) {
        return corrupt(`run.error is inconsistent for Run ${event.runId}`);
      }
      return { ...next, terminal: true };
    case "turn.interrupted": {
      if (
        event.data.taskId !== next.taskId ||
        event.data.instruction !== next.instruction
      ) {
        return corrupt(`turn.interrupted changes the Session Task`);
      }
      const expectedStep = next.openStep ?? next.lastCompletedStep;
      if (
        event.data.steps !== expectedStep ||
        (next.openStep !== undefined && !next.usageRecorded)
      ) {
        return corrupt(`turn.interrupted reports the wrong Step for Run ${event.runId}`);
      }
      return { ...next, terminal: true };
    }
  }
}

function validateGraph(
  events: readonly SessionLogEvent[],
  expectedSessionId: string
): void {
  const byUuid = new Map<string, SessionLogEvent>();
  const protocolByUuid = new Map<string, ProtocolState>();
  let cwd: string | undefined;
  for (const event of events) {
    if (event === undefined) continue;
    if (byUuid.has(event.uuid)) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `Duplicate event uuid in Session ${expectedSessionId}: ${event.uuid}`
      );
    }
    const parent = event.parentUuid === null
      ? undefined
      : byUuid.get(event.parentUuid);
    if (
      (event.parentUuid === null && byUuid.size !== 0) ||
      (event.parentUuid !== null && parent === undefined)
    ) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `Event ${event.uuid} does not point to an earlier parent`
      );
    }
    if (cwd === undefined) cwd = event.cwd;
    if (event.cwd !== cwd) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `Session ${expectedSessionId} contains multiple workspace roots`
      );
    }
    const parentState = parent === undefined
      ? undefined
      : protocolByUuid.get(parent.uuid);
    if (parent !== undefined && parentState === undefined) {
      return corrupt(`Event ${event.uuid} has no parent protocol state`);
    }
    const state = parent === undefined || parent.runId !== event.runId
      ? startProtocolRun(event, parent, parentState)
      : event.seq !== parent.seq + 1
        ? corrupt(`Run ${event.runId} has a non-contiguous Agent event sequence`)
        : applyProtocolEvent(event, parentState!);
    byUuid.set(event.uuid, event);
    protocolByUuid.set(event.uuid, state);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export interface ReadSessionLogResult {
  readonly events: readonly SessionLogEvent[];
  readonly tornTailDetected: boolean;
}

/**
 * Read one Session JSONL. Only a final non-newline-terminated fragment may be
 * discarded; malformed committed lines are corruption and are never skipped.
 */
export async function readSessionLog(
  path: string,
  expectedSessionId: string,
  repairTornTail: boolean
): Promise<ReadSessionLogResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new SessionError(
        "SESSION_NOT_FOUND",
        `Session does not exist: ${expectedSessionId}`,
        { cause: error }
      );
    }
    throw error;
  }

  const lastNewline = bytes.lastIndexOf(0x0a);
  const committedLength = lastNewline === -1 ? 0 : lastNewline + 1;
  const tornTailDetected = committedLength !== bytes.length;
  const committed = bytes.subarray(0, committedLength).toString("utf8");
  const lines = committed.length === 0 ? [] : committed.slice(0, -1).split("\n");
  const events: SessionLogEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `Session JSONL contains an empty committed line at ${index + 1}`
      );
    }
    events.push(parseLogEvent(line, expectedSessionId, index + 1));
  }
  validateGraph(events, expectedSessionId);

  if (tornTailDetected && repairTornTail) {
    const handle = await open(path, "r+");
    try {
      await handle.truncate(committedLength);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  }
  return { events, tornTailDetected };
}

export class SessionJsonlWriter {
  readonly #sessionId: string;
  readonly #handle: FileHandle;
  readonly #knownUuids: Set<string>;
  #closed = false;
  #failure: unknown;
  #pending: Promise<void> = Promise.resolve();

  private constructor(
    sessionId: string,
    handle: FileHandle,
    knownUuids: ReadonlySet<string>
  ) {
    this.#sessionId = sessionId;
    this.#handle = handle;
    this.#knownUuids = new Set(knownUuids);
  }

  static async create(
    path: string,
    sessionId: string,
    seed: readonly SessionLogEvent[] = []
  ): Promise<SessionJsonlWriter> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let handle: FileHandle;
    try {
      handle = await open(path, "ax+", 0o600);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new SessionError(
          "SESSION_EXISTS",
          `Session already exists: ${sessionId}`,
          { cause: error }
        );
      }
      throw error;
    }
    const writer = new SessionJsonlWriter(sessionId, handle, new Set());
    try {
      await syncDirectory(dirname(path));
      for (const event of seed) await writer.append(event);
      return writer;
    } catch (error) {
      await writer.close().catch(() => undefined);
      // open("ax+") proved that this call created the path. Clean up only
      // that newly-created, unusable log; an EEXIST failure happens before a
      // writer exists and must never remove somebody else's Session.
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  static async resume(
    path: string,
    sessionId: string,
    events: readonly SessionLogEvent[]
  ): Promise<SessionJsonlWriter> {
    const handle = await open(path, "a+", 0o600);
    return new SessionJsonlWriter(
      sessionId,
      handle,
      new Set(events.map((event) => event.uuid))
    );
  }

  async append(event: SessionLogEvent): Promise<void> {
    if (this.#closed) {
      throw new SessionError("SESSION_CLOSED", "Cannot append to a closed Session");
    }
    if (
      event.sessionId !== this.#sessionId ||
      this.#knownUuids.has(event.uuid) ||
      (event.parentUuid === null && this.#knownUuids.size !== 0) ||
      (event.parentUuid !== null && !this.#knownUuids.has(event.parentUuid)) ||
      !hasValidSessionMetadata(event, this.#sessionId)
    ) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `Cannot append invalid event ${event.uuid} to Session ${this.#sessionId}`
      );
    }

    const line = `${JSON.stringify(event)}\n`;
    const operation = this.#pending.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      const { size: before } = await this.#handle.stat();
      try {
        await this.#handle.writeFile(line, "utf8");
        await this.#handle.sync();
      } catch (error) {
        try {
          await this.#handle.truncate(before);
          await this.#handle.sync();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Failed to roll back Session append for ${this.#sessionId}`
          );
        }
        throw error;
      }
      this.#knownUuids.add(event.uuid);
    });
    this.#pending = operation.catch((error: unknown) => {
      this.#failure ??= error;
    });
    await operation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
    try {
      if (this.#failure !== undefined) throw this.#failure;
      await this.#handle.sync();
    } finally {
      await this.#handle.close();
    }
  }
}
