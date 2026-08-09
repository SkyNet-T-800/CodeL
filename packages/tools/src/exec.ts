import { realpath, stat } from "node:fs/promises";

import {
  registerTool,
  ToolError,
  type ExecutableTool,
  type JsonObject,
  type RegisteredTool
} from "@repo-circuit/core";

import { DEFAULT_TOOL_LIMITS } from "./limits.js";
import { runProcess } from "./process-runner.js";

export interface ExecProfile {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ExecToolOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface ExecInput {
  readonly profile: string;
}

const PROFILE_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateProfiles(
  profiles: readonly ExecProfile[]
): ReadonlyMap<string, ExecProfile> {
  const byId = new Map<string, ExecProfile>();
  for (const profile of profiles) {
    if (!PROFILE_ID.test(profile.id)) {
      throw new Error(`Invalid exec profile id: ${profile.id}`);
    }
    if (byId.has(profile.id)) {
      throw new Error(`Duplicate exec profile id: ${profile.id}`);
    }
    if (
      profile.command.length === 0 ||
      profile.command.includes("\0") ||
      profile.args.some((argument) => argument.includes("\0"))
    ) {
      throw new Error(`Invalid process specification for profile: ${profile.id}`);
    }
    if (profile.timeoutMs !== undefined) {
      positiveInteger(profile.timeoutMs, `${profile.id}.timeoutMs`);
    }
    if (profile.maxOutputBytes !== undefined) {
      positiveInteger(profile.maxOutputBytes, `${profile.id}.maxOutputBytes`);
    }
    byId.set(profile.id, profile);
  }
  if (byId.size === 0) {
    throw new Error("At least one exec profile is required");
  }
  return byId;
}

/**
 * Construct the exec capability from a Host-owned allowlist.
 *
 * With one profile the schema exposes no selector; with multiple profiles the
 * model supplies only a profile id. Executable, arguments, environment, cwd
 * and resource limits remain trusted Host data.
 */
export function createExecToolRegistration(
  profiles: readonly ExecProfile[],
  options: ExecToolOptions = {}
): RegisteredTool {
  const profilesById = validateProfiles(profiles);
  const profileIds = [...profilesById.keys()];
  const defaultProfileId = profileIds.length === 1 ? profileIds[0] : undefined;
  const defaultProfile =
    defaultProfileId === undefined
      ? undefined
      : profilesById.get(defaultProfileId);
  const profileDescription = [
    "Select one Host-approved command profile:",
    ...[...profilesById.values()].map(
      (profile) => `- ${profile.id}: ${profile.description}`
    )
  ].join("\n");
  const hardTimeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TOOL_LIMITS.execTimeoutMs,
    "exec timeoutMs"
  );
  const hardMaxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_TOOL_LIMITS.maxOutputBytes,
    "exec maxOutputBytes"
  );
  const execTool: ExecutableTool<ExecInput> = {
    definition: {
      name: "exec",
      description:
        defaultProfileId === undefined
          ? "Run one selected Host-approved command profile with a fixed cwd, environment, timeout, and output limit."
          : `Run the fixed Host-approved command (${defaultProfile?.description ?? defaultProfileId}) with the repository as cwd. No input fields are needed.`,
      inputSchema: {
        type: "object",
        properties:
          defaultProfileId === undefined
            ? {
                profile: {
                  type: "string",
                  enum: profileIds,
                  description: profileDescription
                }
              }
            : {},
        ...(defaultProfileId === undefined ? { required: ["profile"] } : {}),
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          profile: { type: "string" },
          exitCode: { type: ["integer", "null"] },
          signal: { type: ["string", "null"] },
          stdout: { type: "string" },
          stderr: { type: "string" },
          outputBytes: { type: "integer", minimum: 0 }
        },
        required: [
          "profile",
          "exitCode",
          "signal",
          "stdout",
          "stderr",
          "outputBytes"
        ],
        additionalProperties: false
      },
      annotations: {
        title: "Run an approved command",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },

    parse(input: JsonObject): ExecInput {
      if (defaultProfileId !== undefined) {
        return { profile: defaultProfileId };
      }
      if (typeof input.profile !== "string") {
        throw new ToolError(
          "INVALID_ARGUMENT",
          "exec.profile must be a string"
        );
      }
      return { profile: input.profile };
    },

    async execute(input, context) {
      const profile = profilesById.get(input.profile);
      if (profile === undefined) {
        throw new ToolError(
          "EXEC_NOT_ALLOWED",
          `Exec profile is not allowed: ${input.profile}`
        );
      }

      const workspaceRoot = await realpath(context.workspaceRoot);
      const workspaceStats = await stat(workspaceRoot);
      if (!workspaceStats.isDirectory()) {
        throw new ToolError(
          "NOT_A_DIRECTORY",
          "Exec workspace root is not a directory"
        );
      }

      const result = await runProcess({
        command: profile.command,
        args: profile.args,
        cwd: workspaceRoot,
        timeoutMs: Math.min(profile.timeoutMs ?? hardTimeoutMs, hardTimeoutMs),
        maxOutputBytes: Math.min(
          profile.maxOutputBytes ?? hardMaxOutputBytes,
          hardMaxOutputBytes
        ),
        ...(profile.env === undefined ? {} : { env: profile.env }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        label: `Exec profile ${profile.id}`
      });

      // A non-zero exit code is ordinary command output: failed tests are
      // evidence for the agent, not a failure of the exec transport.
      return {
        profile: profile.id,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        outputBytes: result.outputBytes
      };
    }
  };

  return registerTool(execTool);
}
