import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AgentEvent,
  EventSink,
  FrozenRunConfiguration,
  RunMeta,
  RunOutcome,
  VerificationResult
} from "@repo-circuit/core";

const RUN_CONFIG_FILE = "run-config.json";
const TRACE_FILE = "trace.jsonl";
const PATCH_FILE = "prediction.patch";
const VERIFIER_RESULT_FILE = "verifier-result.json";
const RUN_META_FILE = "run-meta.json";

export type RunRecorderErrorCode = 
  | "INVALID_RUN_ID"
  | "RUN_ALREADY_EXISTS"
  | "RUN_NOT_RECORDING"
  | "RUN_ID_MISMATCH"
  | "PATCH_HASH_MISMATCH"
  | "TEST_RESULT_MISMATCH"

export class RunRecorderError extends Error {
  readonly code: RunRecorderErrorCode;

  constructor(
    code: RunRecorderErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RunRecorderError";
    this.code = code;
  }
}  

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Cannot serialize undefined as JSON");
  }
  return `${serialized}\n`;
}

function snapshotJson<T>(serialized: string): T {
  return JSON.parse(serialized) as T;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertSafeRunId(runId: string): void {
  if (
    runId.length === 0 ||
    runId === "." ||
    runId === ".." ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes("\0")
  ) {
    throw new RunRecorderError(
      "INVALID_RUN_ID",
      `Run ID must be a non-empty path segment; received ${JSON.stringify(runId)}`
    );
  }
}

function sameTestResult(
  left: RunOutcome["testResult"],
  right: RunOutcome["testResult"]
): boolean {
  return (
    left.status === right.status &&
    left.exitCode === right.exitCode &&
    left.summary === right.summary &&
    left.durationMs === right.durationMs
  );
}

export class JsonlEventWriter implements EventSink {
  readonly #handle: FileHandle;
  #closed = false;
  #failure: unknown;
  #pending: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  private constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  static async create(filePath: string): Promise<JsonlEventWriter> {
    return JsonlEventWriter.openWithFlag(filePath, "w");
  }

  static async createExclusive(filePath: string): Promise<JsonlEventWriter> {
    return JsonlEventWriter.openWithFlag(filePath, "wx");
  }

  private static async openWithFlag(
    filePath: string,
    flag: "w" | "wx"
  ): Promise<JsonlEventWriter> {
    await mkdir(dirname(filePath), { recursive: true });
    const handle = await open(filePath, flag);
    return new JsonlEventWriter(handle);
  }

  async append(event: AgentEvent, signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new Error("Cannot append to a closed JSONL event writer");
    }
    signal?.throwIfAborted();

    // Serialize now so a caller cannot mutate an event while it is queued.
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.#pending.then(async () => {
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      signal?.throwIfAborted();
      // Once a filesystem write starts, wait for that write to settle. Racing
      // it would allow a late Trace line to appear after a terminal event.
      await this.#handle.writeFile(line, "utf8");
    });

    this.#pending = operation.then(
      () => undefined,
      (error: unknown) => {
        // Cancellation before the queued write starts is not a recorder
        // failure; it leaves no bytes behind and a terminal can reuse the seq.
        if (signal?.aborted !== true) {
          this.#failure ??= error;
        }
      }
    );
    await operation;
  }

  async close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = (async () => {
        await this.#pending;
        try {
          if (this.#failure !== undefined) {
            throw this.#failure;
          }
        } finally {
          await this.#handle.close();
        }
      })();
    }
    await this.#closePromise;
  }
}

export interface BeginRunInput {
  readonly runsRoot: string;
  readonly configuration: FrozenRunConfiguration;
}

export interface FinalizeRunInput {
  readonly outcome: RunOutcome;
  readonly predictionPatch: string | Uint8Array;
  readonly verifierResult: VerificationResult;
}

type RecorderState = "recording" | "finalizing" | "finalized" | "failed";

export class RunRecorder implements EventSink {
  readonly runDirectory: string;
  readonly runMetaPath: string;
  readonly #runId: string;
  readonly #configuration: FrozenRunConfiguration;
  readonly #traceWriter: JsonlEventWriter;
  #state: RecorderState = "recording";

  private constructor(
    runDirectory: string,
    configuration: FrozenRunConfiguration,
    traceWriter: JsonlEventWriter
  ) {
    this.runDirectory = runDirectory;
    this.runMetaPath = join(runDirectory, RUN_META_FILE);
    this.#runId = configuration.runId;
    this.#configuration = configuration;
    this.#traceWriter = traceWriter;
  }

  static async begin(
    runsRoot: string,
    configuration: FrozenRunConfiguration
  ): Promise<RunRecorder>;
  static async begin(input: BeginRunInput): Promise<RunRecorder>;
  static async begin(
    runsRootOrInput: string | BeginRunInput,
    suppliedConfiguration?: FrozenRunConfiguration
  ): Promise<RunRecorder> {
    const runsRoot =
      typeof runsRootOrInput === "string"
        ? runsRootOrInput
        : runsRootOrInput.runsRoot;
    const configuration = 
      typeof runsRootOrInput === "string"
        ? suppliedConfiguration
        : runsRootOrInput.configuration;
        
    if (configuration === undefined) {
      throw new TypeError("RunRecorder.begin requires a run configuration");
    }    

    assertSafeRunId(configuration.runId);

    const configurationJson = serializeJson(configuration);
    const frozenConfiguration =
      snapshotJson<FrozenRunConfiguration>(configurationJson);

    await mkdir(runsRoot, { recursive: true });
    const runDirectory = join(runsRoot, frozenConfiguration.runId);
    try {
      await mkdir(runDirectory, { recursive: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new RunRecorderError(
          "RUN_ALREADY_EXISTS",
          `Run directory already exists for ${JSON.stringify(frozenConfiguration.runId)}`,
          { cause: error }
        );
      }
      throw error;
    }

    await writeFile(join(runDirectory, RUN_CONFIG_FILE), configurationJson, {
      encoding: "utf8",
      flag: "wx"
    });

    const traceWriter = await JsonlEventWriter.createExclusive(
      join(runDirectory, TRACE_FILE)
    );

    return new RunRecorder(
      runDirectory,
      frozenConfiguration,
      traceWriter
    );
  }

  async append(event: AgentEvent, signal?: AbortSignal): Promise<void> {
    if (this.#state !== "recording") {
      throw new RunRecorderError(
        "RUN_NOT_RECORDING",
        `Cannot append while run ${JSON.stringify(this.#runId)} is ${this.#state}`
      );
    }
    if (event.runId !== this.#runId) {
      throw new RunRecorderError(
        "RUN_ID_MISMATCH",
        `Trace event runId ${JSON.stringify(event.runId)} does not match recorder runId ${JSON.stringify(this.#runId)}`
      );
    }
    await this.#traceWriter.append(event, signal);
  }

  async finalize(input: FinalizeRunInput): Promise<RunMeta> {
    if (this.#state !== "recording") {
      throw new RunRecorderError(
        "RUN_NOT_RECORDING",
        `Cannot finalize run ${JSON.stringify(this.#runId)} while it is ${this.#state}`
      );
    }

    const outcomeJson = serializeJson(input.outcome);
    const outcome = snapshotJson<RunOutcome>(outcomeJson);
    const verifierResultJson = serializeJson(input.verifierResult);
    const verifierResult = snapshotJson<VerificationResult>(verifierResultJson);
    const patch = typeof input.predictionPatch === "string"
      ? input.predictionPatch
      : Uint8Array.from(input.predictionPatch);
    const expectedPatchHash =
      typeof patch === "string" ? sha256Text(patch) : sha256Bytes(patch);
    
    if (outcome.patchHash !== expectedPatchHash) {
      throw new RunRecorderError(
        "PATCH_HASH_MISMATCH",
        `Run outcome patchHash ${JSON.stringify(outcome.patchHash)} does not match prediction.patch SHA-256 ${JSON.stringify(expectedPatchHash)}`
      );
    }
    if (!sameTestResult(outcome.testResult, verifierResult.testResult)) {
      throw new RunRecorderError(
        "TEST_RESULT_MISMATCH",
        "Run outcome testResult does not match verifier-result.json"
      );
    }  

    this.#state = "finalizing";
    try {
      await this.#traceWriter.close();
      const tracePath = join(this.runDirectory, TRACE_FILE);
      const patchPath = join(this.runDirectory, PATCH_FILE);
      const verifierResultPath = join(
        this.runDirectory,
        VERIFIER_RESULT_FILE
      );

      await writeFile(patchPath, patch, { flag: "wx"});
      await writeFile(verifierResultPath, verifierResultJson, { 
        encoding: "utf8",
        flag: "wx"
      });

      const [traceSha256, patchSha256, verifierResultSha256] =
        await Promise.all([
          sha256File(tracePath),
          sha256File(patchPath),
          sha256File(verifierResultPath)
        ]);

      const runMeta: RunMeta = {
        ...this.#configuration,
        outcome,
        artifacts: {
          tracePath: TRACE_FILE,
          traceSha256,
          patchPath: PATCH_FILE,
          patchSha256,
          verifierResultPath: VERIFIER_RESULT_FILE,
          verifierResultSha256
        }
      };

      await writeFile(this.runMetaPath, serializeJson(runMeta), {
        encoding: "utf8",
        flag: "wx"
      });

      this.#state = "finalized";
      return runMeta;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }

  }




}

