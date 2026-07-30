import { symbolsToolRegistration } from "@repo-circuit/tools";
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

describe("symbols tool", () => {
    it("extracts deterministic top-level TypeScript declarations", async () => {
        fixture = await createTemporaryRepository();

        const result = await symbolsToolRegistration.invoke(
            { path: "src" },
            { workspaceRoot: fixture.repoRoot }
        );

        expect(result).toMatchObject({
            ok: true,
            output: {
                symbols: expect.arrayContaining(
                    [
                        expect.objectContaining({name: "greet", kind: "function"}),
                        expect.objectContaining({name: "courseWeek", kind: "variable"}),
                        expect.objectContaining({name: "Point", kind: "interface"}),
                        expect.objectContaining({name: "Point", kind: "interface"})
                    ]
                ),
                parser: "w2-declaration-scanner"
            }
        });
    });

    it("supports name filtering and bounded results", async ()=> {
        fixture = await createTemporaryRepository();

        await expect(
            symbolsToolRegistration.invoke(
                { path: "src", query: "greet", maxResults: 1},
                { workspaceRoot: fixture.repoRoot}
            )
        ).resolves.toMatchObject(
            {
                ok: true,
                output: {
                    symbols: [expect.objectContaining({ name: "greet" })]
                }
            }
        );
    });

    it("rejects an explicit selected unsupported file", async () => {
        fixture = await createTemporaryRepository();

        await expect(
            symbolsToolRegistration.invoke(
                { path: "README.md" },
                { workspaceRoot: fixture.repoRoot }
            )
        ).resolves.toMatchObject({
            ok: false,
            error: { code: "UNSUPPORTED_FILE_TYPE"}
        });
    });
});


