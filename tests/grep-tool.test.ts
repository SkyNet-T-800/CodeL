import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRipgrepArguments,
  createGrepToolRegistration,
  paginateGrepResults,
  sortGrepFiles,
  splitGlobExpression,
  type GrepQuery,
  type RipgrepResult,
  type RipgrepRunOptions
} from "@repo-circuit/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repo-circuit-grep-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    })
  );
});

function query(overrides: Partial<GrepQuery> = {}): GrepQuery {
  return {
    pattern: "needle",
    mode: "files_with_matches",
    lineNumbers: true,
    ignoreCase: false,
    offset: 0,
    multiline: false,
    ...overrides
  };
}

const baseArguments = [
  "--hidden",
  "--max-columns",
  "500"
];

const versionControlExclusions = [
  "--glob",
  "!.git",
  "--glob",
  "!.svn",
  "--glob",
  "!.hg",
  "--glob",
  "!.bzr",
  "--glob",
  "!.jj",
  "--glob",
  "!.sl"
];

describe("grep argv construction", () => {
  it.each([
    ["files_with_matches", ["-l"]],
    ["count", ["-c", "--with-filename"]],
    ["content", ["-n", "--with-filename"]]
  ] as const)("builds the %s output mode", (mode, modeArguments) => {
    expect(buildRipgrepArguments(query({ mode }))).toEqual([
      ...baseArguments,
      ...modeArguments,
      "needle",
      ...versionControlExclusions
    ]);
  });

  it("lets context override -C, and -C override -B/-A", () => {
    expect(
      buildRipgrepArguments(
        query({
          mode: "content",
          before: 1,
          after: 2,
          contextAlias: 3,
          context: 4
        })
      )
    ).toEqual([
      ...baseArguments,
      "-n",
      "--with-filename",
      "-C",
      "4",
      "needle",
      ...versionControlExclusions
    ]);

    expect(
      buildRipgrepArguments(
        query({
          mode: "content",
          before: 1,
          after: 2,
          contextAlias: 3
        })
      )
    ).toEqual([
      ...baseArguments,
      "-n",
      "--with-filename",
      "-C",
      "3",
      "needle",
      ...versionControlExclusions
    ]);

    expect(
      buildRipgrepArguments(
        query({ mode: "content", before: 1, after: 2 })
      )
    ).toEqual([
      ...baseArguments,
      "-n",
      "--with-filename",
      "-B",
      "1",
      "-A",
      "2",
      "needle",
      ...versionControlExclusions
    ]);
  });

  it("ignores line-number and context switches outside content mode", () => {
    expect(
      buildRipgrepArguments(
        query({
          mode: "count",
          lineNumbers: true,
          before: 1,
          after: 2,
          context: 3
        })
      )
    ).toEqual([
      ...baseArguments,
      "-c",
      "--with-filename",
      "needle",
      ...versionControlExclusions
    ]);
    expect(
      buildRipgrepArguments(query({ mode: "content", lineNumbers: false }))
    ).toEqual([
      ...baseArguments,
      "--with-filename",
      "needle",
      ...versionControlExclusions
    ]);
  });

  it("protects a dash-prefixed regex with -e", () => {
    expect(buildRipgrepArguments(query({ pattern: "--danger" }))).toEqual([
      ...baseArguments,
      "-l",
      "-e",
      "--danger",
      ...versionControlExclusions
    ]);
  });

  it("adds multiline, case, type, and every parsed glob without a shell", () => {
    expect(
      buildRipgrepArguments(
        query({
          pattern: "a.*b",
          mode: "content",
          multiline: true,
          ignoreCase: true,
          type: "ts",
          glob: "*.ts,*.tsx *.{js,jsx} !vendor/**"
        })
      )
    ).toEqual([
      ...baseArguments,
      "-U",
      "--multiline-dotall",
      "-i",
      "-n",
      "--with-filename",
      "a.*b",
      "--type",
      "ts",
      "--glob",
      "*.ts",
      "--glob",
      "*.tsx",
      "--glob",
      "*.{js,jsx}",
      "--glob",
      "!vendor/**",
      ...versionControlExclusions
    ]);
  });

  it("splits commas and whitespace while preserving brace expressions", () => {
    expect(
      splitGlobExpression("  *.ts,*.tsx   *.{js,jsx}  a,b,c  ")
    ).toEqual(["*.ts", "*.tsx", "*.{js,jsx}", "a", "b", "c"]);
    expect(splitGlobExpression("   ")).toEqual([]);
  });
});

describe("grep pagination and sorting", () => {
  it("defaults to 250 entries and only reports a limit when truncation occurs", () => {
    const items = Array.from({ length: 251 }, (_, index) => index);

    expect(paginateGrepResults(items, undefined)).toEqual({
      items: items.slice(0, 250),
      appliedLimit: 250
    });
    expect(paginateGrepResults(items.slice(0, 250), undefined)).toEqual({
      items: items.slice(0, 250)
    });
  });

  it("applies offset before the limit and treats an explicit zero as unlimited", () => {
    expect(paginateGrepResults(["a", "b", "c", "d"], 2, 1)).toEqual({
      items: ["b", "c"],
      appliedLimit: 2
    });
    expect(paginateGrepResults(["a", "b", "c", "d"], 0, 2)).toEqual({
      items: ["c", "d"]
    });
    expect(paginateGrepResults(["a"], 2, 5)).toEqual({ items: [] });
  });

  it("sorts newest first, breaks ties by path, and tolerates a vanished file", async () => {
    const mtimes = new Map([
      ["old.ts", 10],
      ["new-b.ts", 30],
      ["new-a.ts", 30]
    ]);
    const statFile = vi.fn(async (path: string) => {
      const mtimeMs = mtimes.get(path);
      if (mtimeMs === undefined) {
        throw Object.assign(new Error("vanished"), { code: "ENOENT" });
      }
      return { mtimeMs };
    });

    await expect(
      sortGrepFiles(
        ["old.ts", "missing.ts", "new-b.ts", "new-a.ts"],
        statFile,
        "modified"
      )
    ).resolves.toEqual(["new-a.ts", "new-b.ts", "old.ts", "missing.ts"]);
    expect(statFile).toHaveBeenCalledTimes(4);
  });

  it("uses filename-only ordering in deterministic test mode", async () => {
    const statFile = vi.fn(async (path: string) => ({
      mtimeMs: path === "z.ts" ? 100 : 1
    }));

    await expect(
      sortGrepFiles(["z.ts", "a.ts"], statFile, "path")
    ).resolves.toEqual(["a.ts", "z.ts"]);
  });
});

describe("grep tool", () => {
  it("accepts semantic string inputs and passes only normalized argv to the runner", async () => {
    const workspaceRoot = await createWorkspace();
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);
    const runner = vi.fn(
      async (options: RipgrepRunOptions): Promise<RipgrepResult> => ({
        lines: [
          `${join(options.cwd, "src", "a.ts")}:1:one`,
          `${join(options.cwd, "src", "a.ts")}:2:two`
        ],
        truncated: false
      })
    );
    const tool = createGrepToolRegistration({
      ripgrepBinary: "/host/bin/rg",
      timeoutMs: 123,
      maxOutputBytes: 456,
      runner
    });

    const result = await tool.invoke(
      {
        pattern: "needle",
        path: "src",
        output_mode: "content",
        "-B": "2",
        "-A": "3",
        "-n": "false",
        "-i": "true",
        head_limit: "0",
        offset: "1",
        multiline: "true"
      },
      { workspaceRoot }
    );

    expect(result).toEqual({
      ok: true,
      output: {
        mode: "content",
        numFiles: 0,
        filenames: [],
        content: "src/a.ts:2:two",
        numLines: 1,
        truncated: false,
        appliedOffset: 1
      }
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith({
      binary: "/host/bin/rg",
      args: [
        ...baseArguments,
        "-U",
        "--multiline-dotall",
        "-i",
        "--with-filename",
        "-B",
        "2",
        "-A",
        "3",
        "needle",
        ...versionControlExclusions
      ],
      target: join(canonicalWorkspaceRoot, "src"),
      cwd: canonicalWorkspaceRoot,
      timeoutMs: 123,
      maxOutputBytes: 456
    });
  });

  it.each([
    [{ pattern: "x", head_limit: "many" }, "INVALID_TOOL_INPUT"],
    [{ pattern: "x", "-i": "False" }, "INVALID_TOOL_INPUT"],
    [{ pattern: "x", extra: true }, "INVALID_TOOL_INPUT"]
  ] as const)("rejects malformed input %j", async (input, code) => {
    const workspaceRoot = await createWorkspace();
    const runner = vi.fn(async () => ({ lines: [], truncated: false }));
    const tool = createGrepToolRegistration({ runner });

    await expect(tool.invoke(input, { workspaceRoot })).resolves.toMatchObject({
      ok: false,
      error: { code }
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns content mode with relative paths and page metadata", async () => {
    const workspaceRoot = await createWorkspace();
    const runner = vi.fn(async (options: RipgrepRunOptions) => ({
      lines: [
        `${join(options.cwd, "src", "a.ts")}:1:first`,
        `${join(options.cwd, "src", "a.ts")}:2:second`,
        `${join(options.cwd, "src", "b.ts")}:3:third`
      ],
      truncated: false
    }));
    const tool = createGrepToolRegistration({ runner });

    await expect(
      tool.invoke(
        {
          pattern: "needle",
          output_mode: "content",
          head_limit: 1,
          offset: 1
        },
        { workspaceRoot }
      )
    ).resolves.toEqual({
      ok: true,
      output: {
        mode: "content",
        numFiles: 0,
        filenames: [],
        content: "src/a.ts:2:second",
        numLines: 1,
        truncated: true,
        appliedLimit: 1,
        appliedOffset: 1
      }
    });
  });

  it("returns count mode totals for the selected page only", async () => {
    const workspaceRoot = await createWorkspace();
    const runner = vi.fn(async (options: RipgrepRunOptions) => ({
      lines: [
        `${join(options.cwd, "src", "a.ts")}:2`,
        "malformed",
        `${join(options.cwd, "src", "b.ts")}:5`,
        `${join(options.cwd, "src", "c.ts")}:7`
      ],
      truncated: false
    }));
    const tool = createGrepToolRegistration({ runner });

    await expect(
      tool.invoke(
        {
          pattern: "needle",
          output_mode: "count",
          head_limit: 3
        },
        { workspaceRoot }
      )
    ).resolves.toEqual({
      ok: true,
      output: {
        mode: "count",
        numFiles: 2,
        filenames: [],
        content: "src/a.ts:2\nmalformed\nsrc/b.ts:5",
        numMatches: 7,
        truncated: true,
        appliedLimit: 3
      }
    });
  });

  it("returns sorted relative filenames in the default mode", async () => {
    const workspaceRoot = await createWorkspace();
    const runner = vi.fn(async (options: RipgrepRunOptions) => ({
      lines: [
        join(options.cwd, "src", "b.ts"),
        join(options.cwd, "src", "a.ts")
      ],
      truncated: false
    }));
    const statFile = vi.fn(async () => ({ mtimeMs: 10 }));
    const tool = createGrepToolRegistration({ runner, statFile });

    await expect(
      tool.invoke({ pattern: "needle" }, { workspaceRoot })
    ).resolves.toEqual({
      ok: true,
      output: {
        mode: "files_with_matches",
        numFiles: 2,
        filenames: ["src/a.ts", "src/b.ts"],
        truncated: false
      }
    });
  });

  it("forwards the invocation AbortSignal", async () => {
    const workspaceRoot = await createWorkspace();
    const controller = new AbortController();
    const runner = vi.fn(async () => ({ lines: [], truncated: false }));
    const tool = createGrepToolRegistration({ runner });

    await tool.invoke(
      { pattern: "needle" },
      { workspaceRoot, signal: controller.signal }
    );

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it.each([
    ["../outside", "PATH_OUTSIDE_ROOT"],
    ["/tmp/absolute", "PATH_OUTSIDE_ROOT"],
    ["missing", "PATH_NOT_FOUND"],
    [".git/config", "POLICY_DENIED"]
  ])("rejects unsafe or unavailable path %s", async (path, code) => {
    const workspaceRoot = await createWorkspace();
    const runner = vi.fn(async () => ({ lines: [], truncated: false }));
    const tool = createGrepToolRegistration({ runner });

    await expect(
      tool.invoke({ pattern: "needle", path }, { workspaceRoot })
    ).resolves.toMatchObject({ ok: false, error: { code } });
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a search root symlink that escapes the workspace", async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await mkdtemp(join(tmpdir(), "repo-circuit-outside-"));
    temporaryRoots.push(outsideRoot);
    await symlink(outsideRoot, join(workspaceRoot, "escape"), "dir");
    const runner = vi.fn(async () => ({ lines: [], truncated: false }));
    const tool = createGrepToolRegistration({ runner });

    await expect(
      tool.invoke(
        { pattern: "needle", path: "escape" },
        { workspaceRoot }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SYMLINK_ESCAPE" }
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires a host-pinned ripgrep path to be absolute", () => {
    expect(() =>
      createGrepToolRegistration({ ripgrepBinary: "vendor/rg" })
    ).toThrow("Injected ripgrepBinary must be an absolute path");
  });

  it("performs a real ripgrep search without shell interpretation", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, "src", "nested", ".git"), {
      recursive: true
    });
    await writeFile(
      join(workspaceRoot, "src", "match.ts"),
      "first\nunique-token-42\nlast\n",
      "utf8"
    );
    await writeFile(
      join(workspaceRoot, "src", "ignored.md"),
      "different-token\n",
      "utf8"
    );
    await writeFile(
      join(workspaceRoot, ".git", "hidden.ts"),
      "unique-token-42\n",
      "utf8"
    );
    await writeFile(
      join(workspaceRoot, "src", "nested", ".git", "hidden.ts"),
      "unique-token-42\n",
      "utf8"
    );
    const tool = createGrepToolRegistration();

    await expect(
      tool.invoke(
        {
          pattern: "unique-token-42",
          // A broad positive glob comes before the policy deny globs and must
          // not re-include root or nested VCS control data.
          glob: "*",
          output_mode: "content",
          head_limit: 0
        },
        { workspaceRoot }
      )
    ).resolves.toEqual({
      ok: true,
      output: {
        mode: "content",
        numFiles: 0,
        filenames: [],
        content: "src/match.ts:2:unique-token-42",
        numLines: 1,
        truncated: false
      }
    });

    await expect(
      tool.invoke(
        {
          pattern: "unique-token-42",
          path: "src/match.ts",
          output_mode: "count"
        },
        { workspaceRoot }
      )
    ).resolves.toEqual({
      ok: true,
      output: {
        mode: "count",
        numFiles: 1,
        filenames: [],
        content: "src/match.ts:1",
        numMatches: 1,
        truncated: false
      }
    });

    await expect(
      tool.invoke(
        {
          pattern: "unique-token-42",
          path: "src/match.ts",
          output_mode: "content",
          context: 1
        },
        { workspaceRoot }
      )
    ).resolves.toMatchObject({
      ok: true,
      output: {
        mode: "content",
        content:
          "src/match.ts-1-first\n" +
          "src/match.ts:2:unique-token-42\n" +
          "src/match.ts-3-last",
        numLines: 3
      }
    });
  });
});
