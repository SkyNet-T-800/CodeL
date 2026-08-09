import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createExecToolRegistration,
  type ExecProfile
} from "../packages/tools/src/exec.js";

const temporaryRoots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repo-circuit-exec-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    })
  );
});

function registration(
  profiles: readonly ExecProfile[],
  options: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {}
) {
  return createExecToolRegistration(profiles, options);
}

describe("controlled exec tool", () => {
  it("hides the selector when only one Host-owned command is registered", () => {
    const tool = registration([
      {
        id: "test",
        description: "Run the deterministic task verifier",
        command: process.execPath,
        args: ["-e", ""]
      }
    ]);

    expect(tool.definition.inputSchema).not.toHaveProperty("required");
    expect(tool.definition.inputSchema.properties).toEqual({});
    expect(tool.definition.inputSchema).toMatchObject({
      properties: {},
      additionalProperties: false
    });
    expect(tool.definition.description).toContain(
      "Run the deterministic task verifier"
    );
  });

  it("advertises every registered profile in registration order", () => {
    const tool = registration([
      {
        id: "test",
        description: "Run tests",
        command: process.execPath,
        args: ["-e", ""]
      },
      {
        id: "lint",
        description: "Check formatting and lint rules",
        command: process.execPath,
        args: ["-e", ""]
      }
    ]);

    expect(tool.definition.inputSchema).toMatchObject({
      required: ["profile"],
      properties: {
        profile: {
          enum: ["test", "lint"],
          description:
            "Select one Host-approved command profile:\n" +
            "- test: Run tests\n" +
            "- lint: Check formatting and lint rules"
        }
      }
    });
  });

  it("requires at least one Host-owned profile", () => {
    expect(() => registration([])).toThrow(
      "At least one exec profile is required"
    );
  });

  it("runs only the selected Host-owned profile in the fixed workspace cwd", async () => {
    const workspaceRoot = await createWorkspace();
    const tool = registration([
      {
        id: "show_cwd",
        description: "Print the process cwd",
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"]
      }
    ]);

    const result = await tool.invoke({}, { workspaceRoot });

    expect(result).toMatchObject({
      ok: true,
      output: {
        profile: "show_cwd",
        exitCode: 0,
        signal: null,
        stderr: ""
      }
    });
    if (
      result.ok &&
      typeof result.output === "object" &&
      result.output !== null &&
      !Array.isArray(result.output)
    ) {
      const output = result.output as { readonly [key: string]: unknown };
      await expect(realpath(workspaceRoot)).resolves.toBe(output.stdout);
    }
  });

  it("returns a non-zero command exit as structured evidence", async () => {
    const workspaceRoot = await createWorkspace();
    const tool = registration([
      {
        id: "failing_test",
        description: "Represent a failing test command",
        command: process.execPath,
        args: [
          "-e",
          "process.stderr.write('test failed'); process.exitCode = 7"
        ]
      }
    ]);

    const result = await tool.invoke({}, { workspaceRoot });

    expect(result).toMatchObject({
      ok: true,
      output: {
        profile: "failing_test",
        exitCode: 7,
        signal: null,
        stdout: "",
        stderr: "test failed"
      }
    });
  });

  it("rejects a profile id that the Host did not advertise", async () => {
    const workspaceRoot = await createWorkspace();
    const tool = registration([
      {
        id: "test",
        description: "Allowed fixture",
        command: process.execPath,
        args: ["-e", ""]
      }
    ]);

    const result = await tool.invoke(
      { profile: "shell" },
      { workspaceRoot }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT" }
    });
  });

  it("kills a command that exceeds the combined output limit", async () => {
    const workspaceRoot = await createWorkspace();
    const tool = registration(
      [
        {
          id: "loud",
          description: "Print too much output",
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(1024))"]
        }
      ],
      { maxOutputBytes: 64 }
    );

    const result = await tool.invoke({}, { workspaceRoot });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "OUTPUT_TOO_LARGE" }
    });
  });

  it("kills a command that exceeds its timeout", async () => {
    const workspaceRoot = await createWorkspace();
    const tool = registration(
      [
        {
          id: "hang",
          description: "Never finish by itself",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1_000)"]
        }
      ],
      { timeoutMs: 100 }
    );

    const result = await tool.invoke({}, { workspaceRoot });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "EXEC_TIMEOUT" }
    });
  });

  it("does not accept model-supplied argv, cwd, env, or shell fields", async () => {
    const workspaceRoot = await createWorkspace();
    const tool = registration([
      {
        id: "test",
        description: "Allowed fixture",
        command: process.execPath,
        args: ["-e", ""]
      }
    ]);

    const result = await tool.invoke(
      {
        argv: ["-e", "malicious()"]
      },
      { workspaceRoot }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT" }
    });
  });
});
