import { spawn, type ChildProcess } from "node:child_process";

import { ToolError } from "@repo-circuit/core";

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
    const label = options.label ?? "Command";

    return await new Promise<ProcessRunResult>((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let outputBytes = 0;
        let terminalError: ToolError | undefined;
        let settled = false;

        const child = spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: createMinimalEnvironment(options.env),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32"
        });

        const failAndStop = (error: ToolError): void => {
            if (terminalError !== undefined) {
                return;
            }
            terminalError = error;
            stopProcessTree(child, "SIGKILL");
        };

        const onAbort = (): void => {
            failAndStop(
                new ToolError(
                    "EXEC_ABORTED", 
                    `${label} was aborted`,
                    { reason: String(options.signal?.reason ?? "aborted") })
            );
        };
        if (options.signal?.aborted === true) {
            onAbort();
        } else {
            options.signal?.addEventListener("abort", onAbort, { once: true });
        }

        const collect = (target: Buffer[], chunk: Buffer | string): void => {
            if (terminalError !== undefined) {
                return;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += buffer.byteLength;
            if (outputBytes > options.maxOutputBytes) {
                failAndStop(
                   new ToolError(
                        "OUTPUT_TOO_LARGE",
                        `${label} exceeded the combined output limit`,
                        { maxOutputBytes: options.maxOutputBytes }
                   )
                );
                return;
            }
            target.push(buffer);
        };

        child.stdout.on("data", (chunk: Buffer | string) => collect(stdoutChunks, chunk));
        child.stderr.on("data", (chunk: Buffer | string) => collect(stderrChunks, chunk));

        const timeout = setTimeout(
            () => {
                failAndStop(
                    new ToolError("EXEC_TIMEOUT", `${label} exceeded its time limit`, {
                        timeoutMs: options.timeoutMs
                    })
                );
            },
            options.timeoutMs
        );
        timeout.unref();

        child.once("error", () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", onAbort);
            reject(
                terminalError ??
                  new ToolError("EXEC_FAILED", `${label} could not be started`)
            )
        });

        child.once("close", (exitCode, signal) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", onAbort);
            if (terminalError !== undefined) {
                reject(terminalError);
            }
            resolve({
                exitCode,
                signal,
                stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                stderr: Buffer.concat(stderrChunks).toString("utf-8"),
                outputBytes
            });
        });



    })
}
