import { randomUUID } from "node:crypto";

import type { TaskSpec } from "@repo-circuit/core";

import { SessionError } from "./errors.js";
import {
  chainThroughHead,
  prepareResume,
  prepareRewind
} from "./projection.js";
import { inspectSession, SessionStore } from "./store.js";

export interface ForkSessionInput {
  readonly sessionsRoot: string;
  readonly sourceSessionId: string;
  readonly childSessionId?: string;
  /** Omit to fork the newest safe leaf; use 0 for the initial run.begin. */
  readonly atStep?: number;
}

/**
 * Copy the selected visible chain into a new, self-contained Session JSONL.
 * The source file is never modified and the child does not depend on it.
 */
export async function forkSession(
  input: ForkSessionInput
): Promise<SessionStore> {
  const source = await inspectSession(
    input.sessionsRoot,
    input.sourceSessionId
  );
  const preparation = input.atStep === undefined
    ? prepareResume(source.activeChain, input.sourceSessionId)
    : prepareRewind(source.activeChain, input.sourceSessionId, input.atStep);
  if (preparation.status !== "ready") {
    throw new SessionError("UNSAFE_RESUME", preparation.message);
  }
  return await SessionStore.createFork({
    sessionsRoot: input.sessionsRoot,
    childSessionId: input.childSessionId ?? randomUUID(),
    sourceChain: chainThroughHead(
      source.activeChain,
      preparation.head.uuid
    )
  });
}

export interface RewindSessionInput {
  readonly sessionsRoot: string;
  readonly sessionId: string;
  readonly atStep: number;
  readonly workspaceRoot: string;
  readonly task: TaskSpec;
}

/**
 * Select an older head in the same JSONL. The returned writer must receive the
 * next Run; that Run's first event creates the new branch via parentUuid.
 */
export async function rewindSession(
  input: RewindSessionInput
): Promise<SessionStore> {
  return await SessionStore.openForResume({
    sessionsRoot: input.sessionsRoot,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    task: input.task,
    atStep: input.atStep
  });
}
