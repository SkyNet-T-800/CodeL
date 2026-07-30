import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    readFileToolRegistration,
    readToolRegistration
} from "@repo-circuit/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
    createTemporaryRepository,
    type TemporaryRepository
} from "./helpers/temp-repo.js";

let fixture: TemporaryRepository | undefined;

afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
});

describe("read tool", () => {
    it("returns exact text, line metadata and a reusable pre-image hash", async () => {
        fixture = await createTemporaryRepository();

        const result = await readToolRegistration.invoke(
            { path: "src/greeting.ts", startLine: 1, endLine: 3 },
            { workspaceRoot: fixture.repoRoot }
        );

        expect(result).toMatchObject({
            ok: true,
            output: {
                path: "src/greeting.ts",
                content:
                "export function greet(name: string): string {\n" +
                "  return `Hello, ${name}!`;\n" +
                "}\n",
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                startLine: 1,
                endLine: 3,
                totalLines: 5
            }
        });
    });

    it("keeps the W1 read_file result shape while using W2 safety checks", async () => {
        fixture = await createTemporaryRepository();

        await expect(
        readFileToolRegistration.invoke(
            { path: "README.md" },
            { workspaceRoot: fixture.repoRoot }
        )
        ).resolves.toEqual({
        ok: true,
        output: {
            path: "README.md",
            content: expect.stringContaining("# RepoCircuit W2 Fixture")
        }
        });
    });

    it("rejects binary input", async () => {
        fixture = await createTemporaryRepository();

        await expect(
        readToolRegistration.invoke(
            { path: "binary.bin" },
            { workspaceRoot: fixture.repoRoot }
        )
        ).resolves.toMatchObject({
        ok: false,
        error: { code: "BINARY_FILE" }
        });
    });


    it("rejects a result that would exceed the output budget", async () => {
        fixture = await createTemporaryRepository();
        await writeFile(
            join(fixture.repoRoot, "large-output.txt"),
            "x".repeat(300 * 1024),
            "utf8"
        );

        await expect(
            readToolRegistration.invoke(
                { path: "large-output.txt" },
                { workspaceRoot: fixture.repoRoot }
            )
        ).resolves.toMatchObject({
                ok: false,
                error: { code: "OUTPUT_TOO_LARGE" }
        });
    });

})
