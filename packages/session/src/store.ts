import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AgentEvent,
  EventSink,
  TaskSpec
} from "@repo-circuit/core";

import {
  readSessionLog,
  SessionJsonlWriter,
  syncDirectory
} from "./event-log.js";
import { SessionError } from "./errors.js";
import {
  prepareResume,
  prepareRewind,
  projectSession,
  resolveActiveChain
} from "./projection.js";
import type {
  ResumePreparation,
  SessionInspection,
  SessionLogEvent,
  SessionSummary
} from "./types.js";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function assertSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0") ||
    sessionId.endsWith(".jsonl")
  ) {
    throw new SessionError(
      "INVALID_SESSION_ID",
      `Session ID must be a non-empty path segment without .jsonl: ${JSON.stringify(sessionId)}`
    );
  }
}

export function sessionPath(sessionsRoot: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(resolve(sessionsRoot), `${sessionId}.jsonl`);
}

async function loadInspection(
  sessionsRoot: string,
  sessionId: string,
  repairTornTail: boolean
): Promise<SessionInspection> {
  const path = sessionPath(sessionsRoot, sessionId);
  const result = await readSessionLog(path, sessionId, repairTornTail);
  const activeChain = resolveActiveChain(result.events);
  return {
    sessionId,
    path,
    events: result.events,
    activeChain,
    projection: projectSession(activeChain, sessionId),
    tornTailDetected: result.tornTailDetected
  };
}

function assertTaskMatches(
  chain: readonly SessionLogEvent[],
  task: TaskSpec
): void {
  const first = chain[0];
  if (
    first !== undefined &&
    ((first.type !== "run.begin" && first.type !== "turn.interrupted") ||
      first.data.taskId !== task.id ||
      first.data.instruction !== task.instruction)
  ) {
    throw new SessionError(
      "INCOMPATIBLE_TASK",
      "Resume Task ID or instruction differs from the Session transcript"
    );
  }
}

function assertNextAgentEvent(
  previous: SessionLogEvent | undefined,
  event: AgentEvent
): void {
  if (previous === undefined || previous.runId !== event.runId) {
    if (
      event.seq !== 1 ||
      (event.type !== "run.begin" &&
        event.type !== "turn.interrupted" &&
        event.type !== "context.compacted")
    ) {
      throw new SessionError(
        "CORRUPT_EVENT_LOG",
        `A new Run cannot start with ${event.type} seq ${event.seq}`
      );
    }
    return;
  }
  if (event.seq !== previous.seq + 1) {
    throw new SessionError(
      "CORRUPT_EVENT_LOG",
      `Run ${event.runId} expected Agent seq ${previous.seq + 1}, received ${event.seq}`
    );
  }
}

export interface CreateSessionInput {
  readonly sessionsRoot: string;
  readonly sessionId?: string;
  readonly workspaceRoot: string;
  readonly task: TaskSpec;
}

export interface OpenSessionForResumeInput {
  readonly sessionsRoot: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly task: TaskSpec;
  /** Select an older completed Step and append a new branch in the same JSONL. */
  readonly atStep?: number;
}

export interface OpenSessionForMaintenanceInput {
  readonly sessionsRoot: string;
  readonly sessionId: string;
  readonly expectedHeadUuid: string;
}

interface CreateForkInput {
  readonly sessionsRoot: string;
  readonly childSessionId: string;
  readonly sourceChain: readonly SessionLogEvent[];
}

export class SessionStore {
  readonly sessionsRoot: string;
  readonly sessionId: string;
  readonly path: string;
  readonly workspaceRoot: string;
  readonly preparation:
    | Extract<ResumePreparation, { readonly status: "ready" }>
    | undefined;
  readonly #writer: SessionJsonlWriter;
  #head: SessionLogEvent | undefined;
  #disposed = false;

  private constructor(
    sessionsRoot: string,
    sessionId: string,
    workspaceRoot: string,
    writer: SessionJsonlWriter,
    head: SessionLogEvent | undefined,
    preparation?: Extract<ResumePreparation, { readonly status: "ready" }>
  ) {
    this.sessionsRoot = resolve(sessionsRoot);
    this.sessionId = sessionId;
    this.path = sessionPath(this.sessionsRoot, sessionId);
    this.workspaceRoot = workspaceRoot;
    this.#writer = writer;
    this.#head = head;
    this.preparation = preparation;
  }

  static async create(input: CreateSessionInput): Promise<SessionStore> {
    const sessionId = input.sessionId ?? randomUUID();
    assertSessionId(sessionId);
    const sessionsRoot = resolve(input.sessionsRoot);
    const workspaceRoot = await realpath(input.workspaceRoot);
    // Task validation remains owned by Core/CLI; touching these fields here
    // catches obviously unusable callers before reserving the JSONL.
    if (input.task.id.length === 0 || input.task.instruction.length === 0) {
      throw new SessionError(
        "INCOMPATIBLE_TASK",
        "Cannot create a Session from an empty Task"
      );
    }
    await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(resolve(sessionsRoot, ".."));
    const path = sessionPath(sessionsRoot, sessionId);
    const writer = await SessionJsonlWriter.create(path, sessionId);
    return new SessionStore(
      sessionsRoot,
      sessionId,
      workspaceRoot,
      writer,
      undefined
    );
  }

  static async createFork(input: CreateForkInput): Promise<SessionStore> {
    assertSessionId(input.childSessionId);
    if (input.sourceChain.length === 0) {
      throw new SessionError("UNSAFE_RESUME", "Cannot fork an empty Session");
    }
    const sessionsRoot = resolve(input.sessionsRoot);
    await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    const copied = input.sourceChain.map((source): SessionLogEvent => {
      const event = structuredClone(source);
      return event.type === "context.compacted"
        ? {
            ...event,
            sessionId: input.childSessionId,
            data: {
              ...event.data,
              manifest: {
                ...event.data.manifest,
                sessionId: input.childSessionId
              }
            }
          }
        : {
            ...event,
            sessionId: input.childSessionId
          };
    });
    const path = sessionPath(sessionsRoot, input.childSessionId);
    let writer: SessionJsonlWriter | undefined;
    try {
      writer = await SessionJsonlWriter.create(
        path,
        input.childSessionId,
        copied
      );
      const preparation = prepareResume(copied, input.childSessionId);
      if (preparation.status !== "ready") {
        throw new SessionError("UNSAFE_RESUME", preparation.message);
      }
      return new SessionStore(
        sessionsRoot,
        input.childSessionId,
        copied[0]?.cwd ?? "",
        writer,
        copied.at(-1),
        preparation
      );
    } catch (error) {
      await writer?.close().catch(() => undefined);
      // A defined writer means this call successfully created the child file.
      // If create() failed with SESSION_EXISTS, writer is undefined and the
      // pre-existing Session must remain untouched.
      if (writer !== undefined) {
        await rm(path, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  static async prepareResume(
    sessionsRoot: string,
    sessionId: string,
    atStep?: number
  ): Promise<ResumePreparation> {
    const inspection = await loadInspection(sessionsRoot, sessionId, false);
    return atStep === undefined
      ? prepareResume(inspection.activeChain, sessionId)
      : prepareRewind(inspection.activeChain, sessionId, atStep);
  }

  static async openForResume(
    input: OpenSessionForResumeInput
  ): Promise<SessionStore> {
    const sessionsRoot = resolve(input.sessionsRoot);
    const inspection = await loadInspection(
      sessionsRoot,
      input.sessionId,
      true
    );
    const workspaceRoot = await realpath(input.workspaceRoot);
    const recordedWorkspace = inspection.activeChain[0]?.cwd;
    if (recordedWorkspace !== undefined && recordedWorkspace !== workspaceRoot) {
      throw new SessionError(
        "INCOMPATIBLE_WORKSPACE",
        `Session workspace is ${recordedWorkspace}, received ${workspaceRoot}`
      );
    }
    assertTaskMatches(inspection.activeChain, input.task);
    const preparation = input.atStep === undefined
      ? prepareResume(inspection.activeChain, input.sessionId)
      : prepareRewind(inspection.activeChain, input.sessionId, input.atStep);
    if (preparation.status !== "ready") {
      throw new SessionError("UNSAFE_RESUME", preparation.message);
    }
    const head = inspection.activeChain.find(
      (event) => event.uuid === preparation.head.uuid
    );
    if (head === undefined) {
      throw new SessionError("CORRUPT_EVENT_LOG", "Resume head is missing");
    }
    const writer = await SessionJsonlWriter.resume(
      inspection.path,
      input.sessionId,
      inspection.events
    );
    return new SessionStore(
      sessionsRoot,
      input.sessionId,
      workspaceRoot,
      writer,
      head,
      preparation
    );
  }

  static async openForMaintenance(
    input: OpenSessionForMaintenanceInput
  ): Promise<SessionStore> {
    const sessionsRoot = resolve(input.sessionsRoot);
    const inspection = await loadInspection(
      sessionsRoot,
      input.sessionId,
      true
    );
    const preparation = prepareResume(
      inspection.activeChain,
      input.sessionId
    );
    const head = inspection.activeChain.at(-1);
    const terminalSafe =
      head?.type === "run.end" ||
      head?.type === "run.error" ||
      head?.type === "context.compacted" ||
      (head?.type === "turn.interrupted" && head.seq === 1);
    if (
      preparation.status !== "ready" ||
      preparation.ignoredTailEvents !== 0 ||
      head === undefined ||
      head.uuid !== input.expectedHeadUuid ||
      !terminalSafe
    ) {
      throw new SessionError(
        "UNSAFE_RESUME",
        "Session changed or is not at a closed maintenance safe point"
      );
    }
    const writer = await SessionJsonlWriter.resume(
      inspection.path,
      input.sessionId,
      inspection.events
    );
    return new SessionStore(
      sessionsRoot,
      input.sessionId,
      inspection.activeChain[0]?.cwd ?? "",
      writer,
      head,
      preparation
    );
  }

  async recordAgentEvent(event: AgentEvent): Promise<SessionLogEvent> {
    if (this.#disposed) {
      throw new SessionError("SESSION_CLOSED", "Session writer has been disposed");
    }
    assertNextAgentEvent(this.#head, event);
    const entry: SessionLogEvent = {
      ...structuredClone(event),
      sessionId: this.sessionId,
      uuid: randomUUID(),
      parentUuid: this.#head?.uuid ?? null,
      timestamp: new Date().toISOString(),
      cwd: this.workspaceRoot
    };
    await this.#writer.append(entry);
    this.#head = entry;
    return entry;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#writer.close();
  }
}

export class SessionEventSink implements EventSink {
  readonly #session: SessionStore;

  constructor(session: SessionStore) {
    this.#session = session;
  }

  async append(event: AgentEvent, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.#session.recordAgentEvent(event);
  }
}

export async function inspectSession(
  sessionsRoot: string,
  sessionId: string
): Promise<SessionInspection> {
  return await loadInspection(sessionsRoot, sessionId, false);
}

export async function listSessions(
  sessionsRootInput: string
): Promise<readonly SessionSummary[]> {
  const sessionsRoot = resolve(sessionsRootInput);
  let names: readonly string[];
  try {
    names = await readdir(sessionsRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const ids = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort();
  const summaries: SessionSummary[] = [];
  for (const sessionId of ids) {
    const inspection = await loadInspection(sessionsRoot, sessionId, false);
    const latest = inspection.activeChain.at(-1);
    summaries.push({
      sessionId,
      path: inspection.path,
      cwd: inspection.activeChain[0]?.cwd ?? null,
      updatedAt: latest?.timestamp ?? null,
      eventCount: inspection.events.length,
      activeEventCount: inspection.activeChain.length,
      status: inspection.projection.status
    });
  }
  return summaries;
}
