import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@repo-circuit/core";
import { JsonlEventWriter } from "@repo-circuit/trace";
import { expect, it } from "vitest";


it("writes one independently parseable JSON object per line", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "repo-circuit-trace-"));
    const tracePath = join(temporaryRoot, "nested", "trace.jsonl");

    try {
        const writer = await JsonlEventWriter.create(tracePath);
        const events: AgentEvent[] = [
            {
                schemaVersion: 1,
                runId: "writer-test",
                seq: 1,
                type: "run.begin",
                data: {
                    taskId: "writer-test",
                    instruction: "Read 中文\ntext",
                }
            },
            {
                schemaVersion: 1,
                runId: "writer-test",
                seq: 2,
                type: "run.end",
                data: {
                    status: "completed",
                    steps: 0,
                }
            }
        ];

        for (const event of events) {
            await writer.append(event);
        }
        await writer.close();

        const content = await readFile(tracePath, "utf8");
        expect(content.endsWith("\n")).toBe(true);
        const parsed = content.trimEnd().split("\n")
        .map((line) => JSON.parse(line));

        expect(parsed).toEqual(events);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});