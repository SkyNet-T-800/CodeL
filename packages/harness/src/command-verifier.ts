import { createHash, type LargeNumberLike } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
    TestResult,
    VerificationResult,
    Verifier,
    VerifierInput
} from "@repo-circuit/core";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 250;
const INHERITED_ENVIRONMENT_KEYS = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR"
] as const;

function verifierEnvironment(): NodeJS.ProcessEnv {
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
    return environment;
}

export interface CommandVerifierOptions {
    readonly scriptPath: string;
    readonly version?: string;
    readonly scriptSha256?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
}

type CommandStatus = TestResult["status"];

interface CommandResult {
    readonly status: CommandStatus;
    readonly exitCode: number | null;
    readonly summary: string;
    readonly durationMs: number;
}

function positiveInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive safe integer`);
    }
    return value;
}

function validateScriptPaht(scriptPath: string): string {
    if (scriptPath.trim().length === 0 || scriptPath.includes("\0")) {
        throw new Error("scriptPath must be a non-empty path");
    }
    return scriptPath;
}

function workspaceScriptPath(workspaceRoot: string, scriptPath: string): string {
    if (isAbsolute(scriptPath)) {
        return resolve(scriptPath);
    }
    
    const root = resolve(workspaceRoot);
    const absoluteScript = resolve(root, scriptPath);
    const fromRoot = relative(root, absoluteScript);
    if (
        fromRoot === ".." ||
        fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(fromRoot)
    ) {
        throw new Error("Verifier script must stay inside the Run workspace");
    }
    return absoluteScript;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function summaryFromOutput(
    fallback: string,
    stdout: readonly Buffer[],
    stderr: readonly Buffer[],
): string {
    const output = [
        Buffer.concat(stdout).toString("utf8").trim(),
        Buffer.concat(stderr).toString("utf8").trim()
    ]
      .filter((part) => part.length > 0)
      .join("\n");
    return output.length > 0 ? output : fallback;  
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function stopProcess(child: ChildProcess): NodeJS.Timeout {
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
    }, FORCE_KILL_DELAY_MS);
    forceKill.unref();
    return forceKill;
}

export class CommandVerifier implements Verifier {
    readonly version: string;
    readonly #scriptPath: string;
    readonly #timeoutMs: number;
    readonly #maxOutputBytes: number;
    readonly #scriptSha256: string | undefined;

    constructor(options: CommandVerifierOptions);
    constructor(scriptPath: string, version?: string);
    constructor(
        optionsOrScriptPath: CommandVerifierOptions | string,
        version = "command-verifier-v1"
    ) {
        const options =
          typeof optionsOrScriptPath === "string"
            ? { scriptPath: optionsOrScriptPath, version }
            : optionsOrScriptPath;
        
        this.#scriptPath = validateScriptPaht(options.scriptPath);
        if (
            options.scriptSha256 !== undefined &&
            !/^[0-9a-f]{64}$/.test(options.scriptSha256)
        ) {
            throw new Error("scriptSha256 must be a lowercase SHA-256 digest");
        }
        this.#scriptSha256 = options.scriptSha256;
        this.version = options.version ?? "command-verifier-v1";
        if (this.version.trim().length === 0) {
            throw new Error("version must be a non-empty string");
        }
        this.#timeoutMs = positiveInteger(
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            "timeoutMs"
        );
        this.#maxOutputBytes = positiveInteger(
            options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
            "maxOutputBytes"
        );
    }    

    async verify(input: VerifierInput): Promise<VerificationResult> {
        input.signal.throwIfAborted();
        const testResult = await this.#run(input.workspaceRoot, input.signal);
        return {
            passed: testResult.status === "passed",
            summary: testResult.summary,
            testResult
        };
    }

    async #run(
        workspaceRoot: string,
        signal: AbortSignal
    ): Promise<CommandResult> {
        const startedAt = performance.now();
        const script = workspaceScriptPath(workspaceRoot, this.#scriptPath);
        if (this.#scriptSha256 !== undefined) {
            const actualHash = createHash("sha256")
              .update(await readFile(script))
              .digest("hex");
            if (actualHash !== this.#scriptSha256) {
                throw new Error(
                    `Verifier script hash mismatch: expected ${this.#scriptSha256}, received ${actualHash}`
                )
            }  
        }
        signal.throwIfAborted();
        
        return await new Promise<CommandResult>((resolveResult, reject) => {
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputBytes = 0;
            let outputExceeded = false;
            let timedOut = false;
            let settled = false;
            let forceKill: NodeJS.Timeout | undefined;

            const child = spawn(process.execPath, [script], {
                cwd: resolve(workspaceRoot),
                env: verifierEnvironment(),
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true
            });

            const finish = (result: CommandResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (forceKill !== undefined) {
                    clearTimeout(forceKill);
                }
                signal.removeEventListener("abort", onAbort);
                resolveResult(result);
            }

            const fail = (error: unknown): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (forceKill !== undefined) {
                    clearTimeout(forceKill);
                }
                signal.removeEventListener("abort", onAbort);
                reject(error);
            };

            const terminate = (): void => {
                if (forceKill === undefined) {
                    forceKill = stopProcess(child);
                }
            };

            const onAbort = (): void => {
                terminate();
            };

            const timeout = setTimeout(() => {
                timedOut = true;
                terminate();
            }, this.#timeoutMs);
            timeout.unref();

            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
            }

            const collect = (target: Buffer[], chunk: Buffer | string): void => {
                if (outputExceeded) {
                    return;
                }
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const remaining = this.#maxOutputBytes - outputBytes;
                if (bytes.byteLength > remaining) {
                    if (remaining > 0) {
                        target.push(bytes.subarray(0, remaining));
                    }
                    outputBytes += bytes.byteLength;
                    outputExceeded = true;
                    terminate();
                    return;
                }
                outputBytes += bytes.byteLength;
                target.push(bytes);
            };

            child.stdout.on("data", (chunk: Buffer | string) => {
                collect(stdout, chunk);
            });
            child.stderr.on("data", (chunk: Buffer | string) => {
                collect(stderr, chunk);
            })

            child.once("error", (error) => {
                if (signal.aborted) {
                    fail(abortReason(signal));
                    return;
                }
                finish({
                    status: "infra_error",
                    exitCode: null,
                    summary: `Verifier process could not start: ${error.message}`,
                    durationMs: elapsedMilliseconds(startedAt)
                });
            });

            child.once("close", (exitCode, processSignal) => {
                if (signal.aborted) {
                    fail(abortReason(signal));
                    return;
                }
                if (timedOut) {
                    finish({
                        status: "infra_error",
                        exitCode,
                        summary: `Verifier exceeded its ${this.#timeoutMs}ms timeout`,
                        durationMs: elapsedMilliseconds(startedAt)
                    });
                    return;
                }
                if (outputExceeded) {
                    finish({
                        status: "infra_error",
                        exitCode,
                        summary: `Verifier exceeded its ${this.#maxOutputBytes}-byte output limit`,
                        durationMs: elapsedMilliseconds(startedAt)
                    });
                    return;
                }
                if (processSignal !== null) {
                    finish({
                        status: "infra_error",
                        exitCode,
                        summary: `Verifier was terminated by ${processSignal}`,
                        durationMs: elapsedMilliseconds(startedAt)
                    });
                    return;
                }

                const passed = exitCode === 0;
                finish({
                    status: passed ? "passed" : "failed",
                    exitCode,
                    summary: summaryFromOutput(
                        passed
                        ? "Verifier command passed"
                        : `Verifier command exited with code ${String(exitCode)}`,
                        stdout,
                        stderr
                    ),
                    durationMs: elapsedMilliseconds(startedAt)
                });
            })
        });
    }
} 





