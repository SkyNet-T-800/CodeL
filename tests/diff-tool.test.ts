import { execFile as execFileCallback } from "node:child_process";
import { 
    mkdtemp,
    mkdir,
    readFile,
    rm,
    writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { diffToolRegistration } from "../packages/tools/src/diff.js";

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];

async function git(root: string, ...args: string[]): Promise<void> {
    await execFile("git", args, {
        cwd: root,
        env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
        }
    });
}

async function createGitWorkspace(): Promise<{
    readonly root: string;
    readonly textPath: string;
    readonly binaryPath: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "repo-circuit-diff-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    const textPath = join(root, "src", "message.txt");
    const binaryPath = join(root, "src", "binary.bin");
    await writeFile(textPath, "before\n", "utf8");
    await writeFile(textPath, "before\n", "utf8");
    await writeFile(binaryPath, Buffer.from([0, 1, 2]));
    await git(root, "init", "--quiet");
    await git(root, "config", "user.name", "Fixture");
    await git(root, "config", "user.email", "fixture@example.invalid");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "fixture");
    return { root, textPath, binaryPath };
}


afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
        })
    )
});

describe("diff tool", () => {
    it("returns a bounded unified diff for a validated path", async () => {
        const fixture = await createGitWorkspace();
        await writeFile(fixture.textPath, "after\nextra\n", "utf8");

        const result = await diffToolRegistration.invoke(
            { paths: ["src/message.txt"], contextLines: 3},
            { workspaceRoot: fixture.root }
        );

        expect(result.ok).toBe(true);
        if (
            !result.ok ||
            typeof result.output !== "object" ||
            result.output === null ||
            Array.isArray(result.output)
        ) {
            throw new Error("Expected structured diff output")
        }
        const output = result.output as { readonly [key: string]: unknown };
        const patch = output.patch;

        expect(typeof patch).toBe("string");
        expect(patch).toContain(
            "diff --git a/src/message.txt b/src/message.txt"
        );
        expect(patch).toContain("--- a/src/message.txt");
        expect(patch).toContain("+++ b/src/message.txt");
        expect(patch).toContain("@@");
        expect(patch).toContain("-before");
        expect(patch).toContain("+after");
        expect(output.changedFiles).toBe(1);
    });

    it("rejects paths outside the workspace", async () => {
        const fixture = await createGitWorkspace();
        const result = await diffToolRegistration.invoke(
        { paths: ["../outside.txt"] },
        { workspaceRoot: fixture.root }
        );

        expect(result).toMatchObject({
            ok: false,
            error: { code: "PATH_OUTSIDE_ROOT" }
        });
    });
});