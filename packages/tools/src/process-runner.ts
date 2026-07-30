import { spawn } from "node:child_process";

import { ToolError } from "@repo-circuit/core";

export interface ProcessRunOptions {
   readonly command: string;
   readonly args: readonly string[];
   readonly cwd: string;
   readonly timeoutMs: number;
   readonly maxOutputBytes: number;
   readonly env?: Readonly<Record<string, string>>;
   readonly label?: string;
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
            windowsHide: true
        });

        const failAndStop = (error: ToolError): void => {
            if (terminalError !== undefined) {
                return;
            }
            terminalError = error;
            child.kill("SIGKILL");
        };

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

