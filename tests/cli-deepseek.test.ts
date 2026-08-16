import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const cliSource = join(repositoryRoot, "apps", "cli", "src", "index.ts");
const temporaryRoots: string[] = [];

interface CliFixture {
  readonly taskPath: string;
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
}

async function createCliFixture(): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), "repo-circuit-cli-deepseek-"));
  temporaryRoots.push(root);
  const taskRoot = join(root, "task");
  const workspaceRoot = join(root, "workspace");
  const sessionsRoot = join(root, "sessions");
  await Promise.all([mkdir(taskRoot), mkdir(workspaceRoot)]);
  await writeFile(join(workspaceRoot, "README.md"), "# Fixture\n", "utf8");
  await writeFile(
    join(taskRoot, "task.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "deepseek-cli-test",
        title: "DeepSeek CLI test",
        instruction: "Reply that the fixture is ready without changing files.",
        workspace: { root: "." },
        constraints: { allowedTools: ["apply_patch", "exec"] },
        budget: {
          maxSteps: 1,
          tokenBudget: 1000,
          maxToolCalls: 1,
          wallClockBudgetMs: 10_000
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspaceRoot });
  await execFileAsync(
    "git",
    ["config", "user.name", "CodeL CLI Test"],
    { cwd: workspaceRoot }
  );
  await execFileAsync(
    "git",
    ["config", "user.email", "cli-test@example.invalid"],
    { cwd: workspaceRoot }
  );
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
    cwd: workspaceRoot
  });
  await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture base"], {
    cwd: workspaceRoot
  });

  return {
    taskPath: join(taskRoot, "task.json"),
    workspaceRoot,
    sessionsRoot
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not receive a TCP port");
  }
  return address.port;
}

function cleanProviderEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_PROVIDER_NAME",
    "DEEPSEEK_MODEL_REVISION",
    "REPO_CIRCUIT_API_KEY",
    "REPO_CIRCUIT_BASE_URL",
    "REPO_CIRCUIT_MODEL",
    "REPO_CIRCUIT_PROVIDER_NAME",
    "REPO_CIRCUIT_MODEL_REVISION",
    "REPO_CIRCUIT_REASONING_EFFORT",
    "REPO_CIRCUIT_THINKING",
    "REPO_CIRCUIT_TEMPERATURE"
  ]) {
    delete environment[key];
  }
  return environment;
}

async function runCli(
  fixture: CliFixture,
  runId: string,
  environment: NodeJS.ProcessEnv,
  options: { readonly maxSteps?: number } = {}
) {
  const cliArguments = [
    "--import",
    "tsx",
    cliSource,
    "run",
    "--task",
    fixture.taskPath,
    "--workspace",
    fixture.workspaceRoot,
    "--provider",
    "deepseek",
    "--sessions-dir",
    fixture.sessionsRoot,
    "--session-id",
    runId,
    "--run-id",
    runId,
    ...(options.maxSteps === undefined
      ? []
      : ["--max-steps", String(options.maxSteps)])
  ];
  return await execFileAsync(
    process.execPath,
    cliArguments,
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    }
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    })
  );
});

describe("DeepSeek CLI provider", () => {
  it("uses DeepSeek defaults, the dedicated key, and no sampling defaults", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    let requestPath: string | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        authorization = request.headers.authorization;
        requestPath = request.url;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            'data: {"choices":[{"delta":{"content":"ready"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}',
            "data: [DONE]",
            ""
          ].join("\n\n")
        );
      });
    });
    const port = await listen(server);
    const fixture = await createCliFixture();
    const runId = "deepseek-defaults";
    const environment = cleanProviderEnvironment();
    environment.DEEPSEEK_API_KEY = "deepseek-preferred";
    environment.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/v1`;
    environment.REPO_CIRCUIT_API_KEY = "generic-fallback";
    environment.REPO_CIRCUIT_BASE_URL = "https://stale-openai.invalid/v1";
    environment.REPO_CIRCUIT_MODEL = "stale-openai-model";
    environment.REPO_CIRCUIT_PROVIDER_NAME = "stale-openai-provider";
    environment.REPO_CIRCUIT_MODEL_REVISION = "stale-openai-revision";

    try {
      const { stdout } = await runCli(fixture, runId, environment, {
        maxSteps: 8
      });
      expect(stdout).toContain(`✓ ${runId}: end_turn`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }

    expect(requestPath).toBe("/v1/chat/completions");
    expect(authorization).toBe("Bearer deepseek-preferred");
    expect(requestBody).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: true
    });
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestBody).not.toHaveProperty("top_p");
    expect(requestBody?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({
            name: "apply_patch",
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                patch: expect.objectContaining({
                  description: expect.stringContaining(
                    "diff --git a/<path> b/<path>"
                  )
                })
              })
            })
          })
        })
      ])
    );
    expect(requestBody?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: "exec" })
        })
      ])
    );

    const transcript = await readFile(
      join(fixture.sessionsRoot, `${runId}.jsonl`),
      "utf8"
    );
    expect(transcript).toContain('"type":"run.end"');
  });

  it("records disabled thinking and accepts the generic key fallback", async () => {
    let authorization: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"delta":{"content":"ready"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}\n\n' +
            "data: [DONE]\n\n"
        );
      });
    });
    const port = await listen(server);
    const fixture = await createCliFixture();
    const runId = "deepseek-disabled-thinking";
    const environment = cleanProviderEnvironment();
    environment.REPO_CIRCUIT_API_KEY = "generic-fallback";
    environment.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
    environment.REPO_CIRCUIT_THINKING = "disabled";

    try {
      await runCli(fixture, runId, environment);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }

    expect(authorization).toBe("Bearer generic-fallback");
    expect(requestBody).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      stream: true
    });
    expect(requestBody).not.toHaveProperty("reasoning_effort");
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestBody).not.toHaveProperty("top_p");
    const transcript = await readFile(
      join(fixture.sessionsRoot, `${runId}.jsonl`),
      "utf8"
    );
    expect(transcript).toContain('"type":"run.end"');
  });

  it("rejects reasoning effort while thinking is disabled", async () => {
    const fixture = await createCliFixture();
    const environment = cleanProviderEnvironment();
    environment.DEEPSEEK_API_KEY = "test-key";
    environment.REPO_CIRCUIT_THINKING = "disabled";
    environment.REPO_CIRCUIT_REASONING_EFFORT = "high";

    try {
      await runCli(fixture, "invalid-disabled-reasoning", environment);
      throw new Error("Expected the CLI to reject conflicting reasoning settings");
    } catch (error) {
      expect(error).toMatchObject({
        code: 2,
        stderr: expect.stringContaining(
          "REPO_CIRCUIT_REASONING_EFFORT cannot be set when REPO_CIRCUIT_THINKING=disabled"
        )
      });
    }
  });

  it("rejects temperature while DeepSeek thinking is enabled", async () => {
    const fixture = await createCliFixture();
    const environment = cleanProviderEnvironment();
    environment.DEEPSEEK_API_KEY = "test-key";
    environment.REPO_CIRCUIT_TEMPERATURE = "0";

    try {
      await runCli(fixture, "invalid-thinking-temperature", environment);
      throw new Error("Expected the CLI to reject incompatible sampling settings");
    } catch (error) {
      expect(error).toMatchObject({
        code: 2,
        stderr: expect.stringContaining(
          "REPO_CIRCUIT_TEMPERATURE cannot be set when DeepSeek thinking is enabled"
        )
      });
    }
  });

  it.each([0, 1.5])("rejects invalid --max-steps value %s", async (maxSteps) => {
    const fixture = await createCliFixture();
    const environment = cleanProviderEnvironment();
    environment.DEEPSEEK_API_KEY = "test-key";

    try {
      await runCli(fixture, `invalid-max-steps-${maxSteps}`, environment, {
        maxSteps
      });
      throw new Error("Expected the CLI to reject an invalid step override");
    } catch (error) {
      expect(error).toMatchObject({
        code: 2,
        stderr: expect.stringContaining(
          "--max-steps must be a positive integer"
        )
      });
    }
  });

  it.each([
    ["REPO_CIRCUIT_REASONING_EFFORT", "medium", "low, high, max"],
    ["REPO_CIRCUIT_THINKING", "auto", "enabled, disabled"]
  ])("rejects invalid %s values", async (name, value, allowed) => {
    const fixture = await createCliFixture();
    const environment = cleanProviderEnvironment();
    environment.DEEPSEEK_API_KEY = "test-key";
    environment[name] = value;

    try {
      await runCli(fixture, `invalid-${name.toLowerCase()}`, environment);
      throw new Error("Expected the CLI to reject invalid provider configuration");
    } catch (error) {
      expect(error).toMatchObject({
        code: 2,
        stderr: expect.stringContaining(`${name} must be one of: ${allowed}`)
      });
    }
  });
});
