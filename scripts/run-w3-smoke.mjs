import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const provider = valueAfter(args, "--provider") ?? "scripted";
if (provider !== "scripted" && provider !== "openai") {
  throw new Error("--provider must be scripted or openai");
}
const runsDir = resolve(
  repositoryRoot,
  valueAfter(args, "--runs-dir") ?? "runs"
);
const runPrefix =
  valueAfter(args, "--run-prefix") ??
  `w3-${provider}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const tasksRoot = join(repositoryRoot, "benchmarks", "smoke", "tasks");
const taskDirectories = (await readdir(tasksRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(tasksRoot, entry.name))
  .sort();

let completed = 0;
const results = [];

for (const taskDirectory of taskDirectories) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "repo-circuit-w3-smoke-")
  );
  const workspace = join(temporaryRoot, "workspace");
  const taskName = basename(taskDirectory);
  const runId = `${runPrefix}-${taskName}`;

  try {
    await cp(join(taskDirectory, "workspace"), workspace, {
      recursive: true,
      force: false
    });
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    execFileSync(
      "git",
      ["config", "user.name", "RepoCircuit Smoke"],
      { cwd: workspace }
    );
    execFileSync(
      "git",
      ["config", "user.email", "smoke@example.invalid"],
      { cwd: workspace }
    );
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: workspace
    });
    execFileSync("git", ["config", "core.autocrlf", "false"], {
      cwd: workspace
    });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync(
      "git",
      ["commit", "--quiet", "-m", "smoke fixture base"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
        }
      }
    );

    const cli = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "apps", "cli", "bin", "repo-circuit.mjs"),
        "run",
        "--task",
        join(taskDirectory, "task.json"),
        "--workspace",
        workspace,
        "--provider",
        provider,
        "--runs-dir",
        runsDir,
        "--run-id",
        runId,
        "--attempt-index",
        "0"
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8"
      }
    );
    process.stdout.write(cli.stdout ?? "");
    process.stderr.write(cli.stderr ?? "");
    const succeeded = cli.status === 0;
    if (succeeded) {
      completed += 1;
    }
    results.push({ task: taskName, status: succeeded ? "completed" : "failed" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  provider,
  attempted: results.length,
  completed,
  failed: results.length - completed,
  acceptance: completed >= 4 ? "passed" : "failed",
  results
}, null, 2));

process.exitCode = completed >= 4 ? 0 : 1;
