import { treeToolRegistration } from "@repo-circuit/tools";
import { afterEach, describe, expect, it } from "vitest";

import { symlink } from "node:fs/promises";
import { join } from "node:path";

import {
    createTemporaryRepository,
    type TemporaryRepository
} from "./helpers/temp-repo.js";

let fixture: TemporaryRepository | undefined;

afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
});

describe("tree tool", () => {
    it("is deterministic and never follows repository symlinks", async () => {
        fixture = await createTemporaryRepository();
        const input = { path: ".", maxDepth: 4, maxEntries: 100 };
        const context = { workspaceRoot: fixture.repoRoot };

        const first = await treeToolRegistration.invoke(input, context);
        const second = await treeToolRegistration.invoke(input, context);

        expect(first).toStrictEqual(second);
        expect(first).toMatchObject({
            ok: true,
            output: {
                entries: expect.arrayContaining([
                    { path: "escape", type: "symlink" }
                ])
            }
        });
        expect(first).not.toMatchObject({
            output: {
                entries: expect.arrayContaining([
                    { path: "escape/secret.txt" }
                ])
            }
        });
    });

    it("returns an explicit truncation marker at the entry limit", async () => {
        fixture = await createTemporaryRepository();

        await expect(
            treeToolRegistration.invoke(
                { path: ".", maxDepth: 4, maxEntries: 1 },
                { workspaceRoot: fixture.repoRoot}
            )
        ).resolves.toMatchObject(
            {
                ok: true,
                output: {
                    entries: [expect.any(Object)],
                    truncated: true
                }
            }
        )
    });

    it("does not follow a directory symlink supplied as the tree root", async () => {
        fixture = await createTemporaryRepository();
        await symlink(
            join(fixture.repoRoot, "src"),
            join(fixture.repoRoot, "src-alias"),
            "dir"
        );

        await expect(
            treeToolRegistration.invoke(
                { path : "src-alias" },
                { workspaceRoot: fixture.repoRoot}
            )
        ).resolves.toMatchObject(
            {
                ok: false,
                error: { code : "SYMLINK_FORBIDDEN" }
            }
        );
    })

    it ("rejects a file where a directory is required", async () => {
        fixture = await createTemporaryRepository();

        await expect(
            treeToolRegistration.invoke(
                { path : "README.md" },
                { workspaceRoot: fixture.repoRoot}
            )
        ).resolves.toMatchObject(
            {
                ok: false,
                error: { code : "NOT_A_DIRECTORY" }
            }
        );
    });

});
