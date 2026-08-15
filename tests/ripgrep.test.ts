import {
  defaultRipgrepTimeoutMs,
  parseRipgrepLines,
  RipgrepTimeoutError,
  runRipgrep,
  type ProcessCapture,
  type RipgrepResult,
  type RipgrepRunOptions
} from "@repo-circuit/tools";
import type {
  CapturedProcessResult,
  ProcessRunOptions
} from "../packages/tools/src/process-runner.js";
import { describe, expect, it, vi } from "vitest";

function captured(
  overrides: Partial<CapturedProcessResult> = {}
): CapturedProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    outputBytes: 0,
    termination: "exited",
    ...overrides
  };
}

function options(
  capture: ProcessCapture,
  overrides: Partial<RipgrepRunOptions> = {}
): RipgrepRunOptions {
  return {
    binary: "/host/bin/rg",
    args: ["--hidden", "needle"],
    target: "/workspace/src",
    cwd: "/workspace",
    timeoutMs: 321,
    maxOutputBytes: 654,
    capture,
    ...overrides
  };
}

describe("ripgrep output parsing", () => {
  it("uses a longer default on WSL kernels", () => {
    expect(defaultRipgrepTimeoutMs("linux", "5.15.0-microsoft-standard-WSL2"))
      .toBe(60_000);
    expect(defaultRipgrepTimeoutMs("linux", "6.8.0-generic")).toBe(20_000);
    expect(defaultRipgrepTimeoutMs("darwin", "23.0.0")).toBe(20_000);
  });

  it("normalizes CRLF, drops empty logical lines, and preserves content", () => {
    expect(parseRipgrepLines("one\r\n\r\ntwo:2:value\r\n")).toEqual([
      "one",
      "two:2:value"
    ]);
  });

  it("can discard the final possibly torn line", () => {
    expect(parseRipgrepLines("complete\r\npartial", true)).toEqual([
      "complete"
    ]);
    expect(parseRipgrepLines("partial", true)).toEqual([]);
    expect(parseRipgrepLines("   \r\n", true)).toEqual([]);
  });
});

describe("runRipgrep", () => {
  it("builds one process request with the target last and returns exit-0 lines", async () => {
    const signal = new AbortController().signal;
    const capture = vi.fn(
      async (_request: ProcessRunOptions): Promise<CapturedProcessResult> =>
        captured({
          stdout: "src/a.ts:1:needle\r\nsrc/b.ts:2:needle\r\n",
          outputBytes: 48
        })
    );

    await expect(
      runRipgrep(options(capture, { signal }))
    ).resolves.toEqual({
      lines: ["src/a.ts:1:needle", "src/b.ts:2:needle"],
      truncated: false
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith({
      command: "/host/bin/rg",
      args: ["--hidden", "needle", "/workspace/src"],
      cwd: "/workspace",
      timeoutMs: 321,
      maxOutputBytes: 654,
      label: "ripgrep",
      signal
    });
  });

  it("uses production limits when the caller omits overrides", async () => {
    const capture = vi.fn(
      async (_request: ProcessRunOptions): Promise<CapturedProcessResult> =>
        captured()
    );

    await runRipgrep({
      binary: "/host/bin/rg",
      args: ["needle"],
      target: "/workspace",
      cwd: "/workspace",
      capture
    });

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 20_000, maxOutputBytes: 20_000_000 })
    );
  });

  it("treats exit 1 as a complete search with no matches", async () => {
    const capture = vi.fn(async () =>
      captured({ exitCode: 1, stdout: "ignored defensive output\n" })
    );

    await expect(runRipgrep(options(capture))).resolves.toEqual({ lines: [], truncated: false });
  });

  it("keeps complete stdout from exit 2 but returns no false result without stdout", async () => {
    const withEvidence = vi.fn(async () =>
      captured({ exitCode: 2, stdout: "complete-a\r\ncomplete-b\r\n" })
    );
    const withoutEvidence = vi.fn(async () =>
      captured({ exitCode: 2, stderr: "invalid regex" })
    );

    await expect(runRipgrep(options(withEvidence))).resolves.toEqual({
      lines: ["complete-a", "complete-b"],
      truncated: false
    });
    await expect(runRipgrep(options(withoutEvidence))).resolves.toEqual({ lines: [], truncated: false });
  });

  it.each(["os error 11", "Resource temporarily unavailable"])(
    "retries one EAGAIN failure once with a call-local single thread flag: %s",
    async (message) => {
      const capture = vi
        .fn<(request: ProcessRunOptions) => Promise<CapturedProcessResult>>()
        .mockResolvedValueOnce(
          captured({
            exitCode: 2,
            stderr: `ripgrep: ${message}`
          })
        )
        .mockResolvedValueOnce(captured({ stdout: "recovered\n" }));

      await expect(runRipgrep(options(capture))).resolves.toEqual({
        lines: ["recovered"],
        truncated: false
      });
      expect(capture).toHaveBeenCalledTimes(2);
      expect(capture.mock.calls[0]?.[0].args).toEqual([
        "--hidden",
        "needle",
        "/workspace/src"
      ]);
      expect(capture.mock.calls[1]?.[0].args).toEqual([
        "-j",
        "1",
        "--hidden",
        "needle",
        "/workspace/src"
      ]);
    }
  );

  it("never performs more than one EAGAIN retry", async () => {
    const capture = vi.fn(async () =>
      captured({
        exitCode: 2,
        stderr: "Resource temporarily unavailable"
      })
    );

    await expect(runRipgrep(options(capture))).resolves.toEqual({ lines: [], truncated: false });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("does not retry a successful outcome merely because stderr mentions EAGAIN", async () => {
    const capture = vi.fn(async () =>
      captured({ stdout: "match\n", stderr: "os error 11" })
    );

    await expect(runRipgrep(options(capture))).resolves.toEqual({ lines: ["match"], truncated: false });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("returns complete timeout evidence and drops the possibly incomplete tail", async () => {
    const capture = vi.fn(async () =>
      captured({
        exitCode: null,
        signal: "SIGKILL",
        termination: "timed_out",
        stdout: "src/a.ts:1:complete\r\nsrc/b.ts:2:part"
      })
    );

    await expect(runRipgrep(options(capture))).resolves.toEqual({
      lines: ["src/a.ts:1:complete"],
      truncated: true
    });
  });

  it("throws a typed timeout when no complete result survived", async () => {
    const capture = vi.fn(async () =>
      captured({
        exitCode: null,
        signal: "SIGKILL",
        termination: "timed_out",
        stdout: "only-a-partial-line"
      })
    );

    const promise = runRipgrep(options(capture, { timeoutMs: 777 }));
    await expect(promise).rejects.toBeInstanceOf(RipgrepTimeoutError);
    await expect(promise).rejects.toMatchObject({
      code: "RIPGREP_TIMEOUT",
      partialResults: [],
      details: { timeoutMs: 777, partialResults: [] }
    });
  });

  it("drops the buffer-limited tail while returning complete prior lines", async () => {
    const capture = vi.fn(async () =>
      captured({
        exitCode: null,
        signal: "SIGKILL",
        termination: "output_limited",
        stdout: "complete\r\ntorn-tail"
      })
    );

    await expect(runRipgrep(options(capture))).resolves.toEqual({ lines: ["complete"], truncated: true });
  });

  it.each([
    ["ENOENT", "RIPGREP_NOT_FOUND"],
    ["EACCES", "RIPGREP_ACCESS_DENIED"],
    ["EPERM", "RIPGREP_ACCESS_DENIED"],
    ["EIO", "RIPGREP_EXEC_FAILED"]
  ])("maps spawn failure %s to %s", async (errorCode, toolCode) => {
    const capture = vi.fn(async () =>
      captured({
        exitCode: null,
        termination: "spawn_failed",
        errorCode
      })
    );

    await expect(runRipgrep(options(capture))).rejects.toMatchObject({
      code: toolCode
    });
  });

  it("surfaces an aborted capture when no AbortSignal reason is available", async () => {
    const capture = vi.fn(async () =>
      captured({
        exitCode: null,
        signal: "SIGKILL",
        termination: "aborted"
      })
    );

    await expect(runRipgrep(options(capture))).rejects.toMatchObject({
      code: "RIPGREP_ABORTED"
    });
  });

  it("does not start for a pre-aborted signal and preserves its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before search");
    controller.abort(reason);
    const capture = vi.fn(async () => captured());

    await expect(
      runRipgrep(options(capture, { signal: controller.signal }))
    ).rejects.toBe(reason);
    expect(capture).not.toHaveBeenCalled();
  });

  it("preserves the AbortSignal reason when cancellation races the process", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during search");
    const capture = vi.fn(async () => {
      controller.abort(reason);
      return captured({
        exitCode: null,
        signal: "SIGKILL",
        termination: "aborted"
      });
    });

    await expect(
      runRipgrep(options(capture, { signal: controller.signal }))
    ).rejects.toBe(reason);
  });
});
