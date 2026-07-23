import { fileURLToPath } from "node:url";

import {
    parseTaskSpec,
    runAgent,
    type AgentEvent,
    type EventSink,
    type RegisteredTool,
    type TaskSpec
} from "@repo-circuit/core";

import {
    createWeekOneMockProvider,
    ScriptedMockProvider
} from "@repo-circuit/providers";

import { readFileToolRegistration } from "@repo-circuit/tools";
import { describe, expect, it } from "vitest";

class MemoryEventSink implements EventSink {
    readonly events: AgentEvent[] = [];

    async append(event: AgentEvent): Promise<void> {
        this.events.push(event);
    }
}

const fixtureRoot = fileURLToPath(
    new URL("../fixtures/hello-repo", import.meta.url)
)

const task: TaskSpec = {
    schemaVersion: 1,
    id: "fixture-readme",
    title: "Read the fixture README",
    instruction: "Read README.md and report the fixture project name.",
    workspace: { root: "." },
    constraints: {
        allowedTools: ["read_file"]
    },
    budget: { maxSteps: 4}
}

async function executeFixture() {
    const provider = createWeekOneMockProvider();
    const sink = new MemoryEventSink();
    const state = await runAgent({
        runId: "fixture-readme-run",
        task,
        workspaceRoot: fixtureRoot,
        provider,
        tools: [readFileToolRegistration],
        events: sink
    });
    return { provider, sink, state };
}

describe("runAgent", () => {
    it("completes the Provider -> Tool -> Provider loop", async () => {
        const { provider, sink, state } = await executeFixture();

        expect(state.status).toBe("completed");
        if (state.status !== "completed") {
            throw new Error("Agent did not complete successfully");
        }
        expect(state.step).toBe(2);
        expect(state.finalOutput).toBe("Fixture README read successfully: RepoCircuit Fixture.");
            expect(provider.requests).toHaveLength(2);
        expect(provider.requests[0]?.messages.some((message) => message.role === "tool")).toBe(
        false
        );
        expect(provider.requests[1]?.messages.some((message) => message.role === "tool")).toBe(
        true
        );
        expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
        "# RepoCircuit Fixture"
        );
        expect(sink.events.map((event) => event.type)).toEqual([
        "run.begin",
        "step.begin",
        "tool.call",
        "tool.result",
        "step.end",
        "step.begin",
        "assistant.final",
        "step.end",
        "run.end"
        ]);
        expect(sink.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(
        sink.events
            .filter((event) => event.type === "step.end")
            .map((event) => event.data.reason)
        ).toEqual(["tool_use", "end_turn"]);
        expect(
        sink.events.filter(
            (event) => event.type === "run.end" || event.type === "run.error"
        )
        ).toHaveLength(1);
    });

    it("produces byte-identical deterministic events for identical input", async () => {
        const first = await executeFixture();
        const second = await executeFixture();

        expect(JSON.stringify(first.sink.events)).toEqual(JSON.stringify(second.sink.events));
    })

})

