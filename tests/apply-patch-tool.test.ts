import {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyPatchToolRegistration } from "@repo-circuit/tools";

import { sha256Hex } from "@repo-circuit/tools"

const temporaryRoots: string[] = [];

async function createWorkspace(): Promise<{
  readonly temporaryRoot: string;
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly source: string;
}> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "repo-circuit-patch-"));
  temporaryRoots.push(temporaryRoot);
  const workspaceRoot = join(temporaryRoot, "repo");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  const filePath = join(workspaceRoot, "src", "message.txt");
  const source = "alpha\nold\nomega\n";
  await writeFile(filePath, source, "utf8");
  return { temporaryRoot, workspaceRoot, filePath, source };
}

function validPatch(replacement = "new"): string {
  return [
    "diff --git a/src/message.txt b/src/message.txt",
    "--- a/src/message.txt",
    "+++ b/src/message.txt",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-old",
    `+${replacement}`,
    " omega",
    ""
  ].join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    })
  );
});

describe("apply_patch tool", () => {
    it("applies one exact text patch atomically and returns before/after hashes", async () => {
        const fixture = await createWorkspace();
        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch: validPatch()
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toEqual({
            ok: true,
            output: {
                path: "src/message.txt",
                beforeHash: sha256Hex(fixture.source),
                afterHash: sha256Hex("alpha\nnew\nomega\n"),
                appliedHunks: 1,
                bytesWritten: Buffer.byteLength("alpha\nnew\nomega\n")
            }
        });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe("alpha\nnew\nomega\n");
    });

    it("accepts omitted unit counts in a standard hunk header", async () => {
        const fixture = await createWorkspace();
        const patch = [
            "diff --git a/src/message.txt b/src/message.txt",
            "--- a/src/message.txt",
            "+++ b/src/message.txt",
            "@@ -2 +2 @@",
            "-old",
            "+new",
            ""
        ].join("\n");

        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({ ok: true });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            "alpha\nnew\nomega\n"
        );
    });

    it("accepts ordinary unified-diff file headers", async () => {
        const fixture = await createWorkspace();
        const patch = [
            "--- src/message.txt",
            "+++ src/message.txt",
            "@@ -2 +2 @@",
            "-old",
            "+new",
            ""
        ].join("\n");

        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({ ok: true });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            "alpha\nnew\nomega\n"
        );
    });

    it("accepts a patch that begins directly with a standard hunk", async () => {
        const fixture = await createWorkspace();
        const patch = [
            "@@ -2 +2 @@",
            "-old",
            "+new",
            ""
        ].join("\n");

        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({ ok: true });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            "alpha\nnew\nomega\n"
        );
    });

    it("rejects a stale base hash without changing the file", async () => {
        const fixture = await createWorkspace();
        const result = await applyPatchToolRegistration.invoke(
        {
            path: "src/message.txt",
            baseHash: "0".repeat(64),
            patch: validPatch()
        },
        { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
        ok: false,
        error: { code: "HASH_MISMATCH" }
        });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
        fixture.source
        );
    });

    it("handles an empty-range insertion without fuzzy hunk relocation", async () => {
        const fixture = await createWorkspace();
        await writeFile(fixture.filePath, "", "utf8");
        const patch = [
        "diff --git a/src/message.txt b/src/message.txt",
        "--- a/src/message.txt",
        "+++ b/src/message.txt",
        "@@ -0,0 +1,2 @@",
        "+first",
        "+second",
        ""
        ].join("\n");

        const result = await applyPatchToolRegistration.invoke(
        {
            path: "src/message.txt",
            baseHash: sha256Hex(""),
            patch
        },
        { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
            ok: true,
            output: { appliedHunks: 1 }
        });
        
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            "first\nsecond\n"
            );
    });

    it("rejects mismatched or escaping patch headers", async () => {
        const fixture = await createWorkspace();
        const maliciousPatch = validPatch().replaceAll(
        "src/message.txt",
        "../outside.txt"
        );
        const result = await applyPatchToolRegistration.invoke(
        {
            path: "src/message.txt",
            baseHash: sha256Hex(fixture.source),
            patch: maliciousPatch
        },
        { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
        ok: false,
        error: { code: "PATCH_INVALID" }
        });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
        fixture.source
        );
    });

    it("rejects mismatched ordinary unified-diff headers", async () => {
        const fixture = await createWorkspace();
        const patch = [
            "--- src/other.txt",
            "+++ src/other.txt",
            "@@ -2 +2 @@",
            "-old",
            "+new",
            ""
        ].join("\n");
        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
            ok: false,
            error: { code: "PATCH_INVALID" }
        });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            fixture.source
        );
    });

    it("accepts a bare hunk when its source lines identify one location", async () => {
        const fixture = await createWorkspace();
        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch: "@@\n alpha\n-old\n+new\n omega\n"
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({ ok: true });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            "alpha\nnew\nomega\n"
        );
    });

    it("rejects a bare hunk whose source lines are ambiguous", async () => {
        const fixture = await createWorkspace();
        await writeFile(fixture.filePath, "old\nold\n", "utf8");
        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex("old\nold\n"),
                patch: "@@\n-old\n+new\n"
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
            ok: false,
            error: { code: "PATCH_APPLY_FAILED" }
        });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            "old\nold\n"
        );
    });

    it("rejects a patch containing a second file", async () => {
        const fixture = await createWorkspace();
        const patch = [
            "diff --git a/src/message.txt b/src/message.txt",
            "--- a/src/message.txt",
            "+++ b/src/message.txt",
            "@@ -2 +2 @@",
            "-old",
            "+new",
            "diff --git a/src/other.txt b/src/other.txt",
            "--- a/src/other.txt",
            "+++ b/src/other.txt",
            "@@ -1 +1 @@",
            "-before",
            "+after",
            ""
        ].join("\n");
        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
            ok: false,
            error: { code: "PATCH_INVALID" }
        });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            fixture.source
        );
    });

    it("recomputes inaccurate declared hunk counts from the body", async () => {
        const fixture = await createWorkspace();
        const patch = [
            "@@ -2,2 +2 @@",
            "-old",
            "+new",
            ""
        ].join("\n");
        const result = await applyPatchToolRegistration.invoke(
            {
                path: "src/message.txt",
                baseHash: sha256Hex(fixture.source),
                patch
            },
            { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({ ok: true });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
            "alpha\nnew\nomega\n"
        );
    });

    it("rejects a patch whose hunk context does not exactly match", async () => {
        const fixture = await createWorkspace();
        const result = await applyPatchToolRegistration.invoke(
        {
            path: "src/message.txt",
            baseHash: sha256Hex(fixture.source),
            patch: validPatch().replace(" alpha", " different")
        },
        { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
        ok: false,
        error: { code: "PATCH_CONTEXT_MISMATCH" }
        });
        await expect(readFile(fixture.filePath, "utf8")).resolves.toBe(
        fixture.source
        );
    });

    it("rejects a final-component symbolic link", async () => {
        const fixture = await createWorkspace();
        const outsidePath = join(fixture.temporaryRoot, "outside.txt");
        await writeFile(outsidePath, fixture.source, "utf8");
        await symlink(outsidePath, join(fixture.workspaceRoot, "link.txt"));
        const patch = validPatch()
        .replaceAll("src/message.txt", "link.txt");

        const result = await applyPatchToolRegistration.invoke(
        {
            path: "link.txt",
            baseHash: sha256Hex(fixture.source),
            patch
        },
        { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
        ok: false,
        error: { code: "SYMLINK_ESCAPE" }
        });
        await expect(readFile(outsidePath, "utf8")).resolves.toBe(fixture.source);
    });

    it("rejects binary targets", async () => {
        const fixture = await createWorkspace();
        const binaryPath = join(fixture.workspaceRoot, "src", "binary.bin");
        const binary = Buffer.from([0, 1, 2, 3]);
        await writeFile(binaryPath, binary);
        const patch = validPatch().replaceAll(
        "src/message.txt",
        "src/binary.bin"
        );

        const result = await applyPatchToolRegistration.invoke(
        {
            path: "src/binary.bin",
            baseHash: sha256Hex(binary),
            patch
        },
        { workspaceRoot: fixture.workspaceRoot }
        );

        expect(result).toMatchObject({
            ok: false,
            error: { code: "BINARY_FILE" }
        });
    });
})
