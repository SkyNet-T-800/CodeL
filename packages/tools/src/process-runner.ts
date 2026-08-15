import { spawn, type ChildProcess } from "node:child_process";

import { ToolError } from "@repo-circuit/core";

import { nodeErrorCode } from "./node-errors.js";

export interface ProcessRunOptions {
   readonly command: string;
   readonly args: readonly string[];
   readonly cwd: string;
   readonly timeoutMs: number;
   readonly maxOutputBytes: number;
   readonly env?: Readonly<Record<string, string>>;
   readonly label?: string;
   readonly signal?: AbortSignal;
}

export interface ProcessRunResult {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly outputBytes: number;
}

export type ProcessTermination =
    | "exited"
    | "timed_out"
    | "output_limited"
    | "aborted"
    | "spawn_failed";

export interface CapturedProcessResult extends ProcessRunResult {
    readonly termination: ProcessTermination;
    readonly errorCode?: string;
    readonly abortReason?: unknown;
}

const INHERITED_ENVIRONMENT_KEYS = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR"
] as const;

export function createMinimalEnvironment(
    additions: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1"
    };

    for (const key of INHERITED_ENVIRONMENT_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }

    for (const [key, value] of Object.entries(additions)) {
        environment[key] = value;
    }
    return environment;
}

function stopProcessTree(
    child: ChildProcess,
    signal: NodeJS.Signals
): void {
    if (process.platform !== "win32" && child.pid !== undefined) {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch {

        }
    }
    child.kill(signal);
}

export async function runProcess(
    options: ProcessRunOptions
): Promise<ProcessRunResult> {
    const result = await captureProcess(options);
    const label = options.label ?? "Command";

    switch (result.termination) {
        case "exited":
            return {
                exitCode: result.exitCode,
                signal: result.signal,
                stdout: result.stdout,
                stderr: result.stderr,
                outputBytes: result.outputBytes
            };
        case "timed_out":
            throw new ToolError(
                "EXEC_TIMEOUT",
                `${label} exceeded its time limit`,
                { timeoutMs: options.timeoutMs }
            );
        case "output_limited":
            throw new ToolError(
                "OUTPUT_TOO_LARGE",
                `${label} exceeded the combined output limit`,
                { maxOutputBytes: options.maxOutputBytes }
            );
        case "aborted":
            throw new ToolError(
                "EXEC_ABORTED",
                `${label} was aborted`,
                { reason: String(result.abortReason ?? "aborted") }
            );
        case "spawn_failed":
            throw new ToolError(
                "EXEC_FAILED",
                `${label} could not be started`
            );
    }
}

export async function captureProcess(
    options: ProcessRunOptions
): Promise<CapturedProcessResult> {
    if (
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        !Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes <= 0
    ) {
        throw new ToolError(
            "INVALID_ARGUMENT",
            "timeoutMs and maxOutputBytes must be positive integers"
        );
    }
    options.signal?.throwIfAborted();

    return await new Promise<CapturedProcessResult>((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let outputBytes = 0;
        let termination:
            | Exclude<ProcessTermination, "exited" | "spawn_failed">
            | undefined;
        let abortReason: unknown;
        let settled = false;

        const child = spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: createMinimalEnvironment(options.env),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32"
        });

        const stop = (
            reason: Exclude<ProcessTermination, "exited" | "spawn_failed">,
            reasonValue?: unknown
        ): void => {
            if (termination !== undefined) {
                return;
            }
            termination = reason;
            abortReason = reasonValue;
            stopProcessTree(child, "SIGKILL");
        };

        const onAbort = (): void => {
            stop("aborted", options.signal?.reason);
        };
        if (options.signal?.aborted === true) {
            onAbort();
        } else {
            options.signal?.addEventListener("abort", onAbort, { once: true });
        }

        const collect = (target: Buffer[], chunk: Buffer | string): void => {
            if (termination !== undefined) {
                return;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += buffer.byteLength;
            if (outputBytes > options.maxOutputBytes) {
                const bytesBeforeChunk = outputBytes - buffer.byteLength;
                const remaining = options.maxOutputBytes - bytesBeforeChunk;
                if (remaining > 0) {
                    target.push(buffer.subarray(0, remaining));
                }
                stop("output_limited");
                return;
            }
            target.push(buffer);
        };

        child.stdout.on("data", (chunk: Buffer | string) => collect(stdoutChunks, chunk));
        child.stderr.on("data", (chunk: Buffer | string) => collect(stderrChunks, chunk));

        const timeout = setTimeout(
            () => {
                stop("timed_out");
            },
            options.timeoutMs
        );
        timeout.unref();

        const finish = (
            result: Omit<
                CapturedProcessResult,
                "stdout" | "stderr" | "outputBytes"
            >
        ): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", onAbort);
            resolve({
                ...result,
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8"),
                outputBytes
            });
        };

        child.once("error", (error: Error) => {
            const errorCode = nodeErrorCode(error);
            finish({
                exitCode: null,
                signal: null,
                termination: termination ?? "spawn_failed",
                ...(errorCode === undefined ? {} : { errorCode }),
                ...(termination === "aborted" ? { abortReason } : {})
            });
        });

        child.once("close", (exitCode, signal) => {
            finish({
                exitCode,
                signal,
                termination: termination ?? "exited",
                ...(termination === "aborted" ? { abortReason } : {})
            });
        });
    });
}
