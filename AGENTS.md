# CodeL Architecture and Contribution Guide

This document describes the repository architecture and the invariants that contributors and coding agents should preserve. User-facing setup and CLI instructions live in [README.md](README.md).

## Project overview

CodeL is a TypeScript monorepo for a command-line coding agent. The runtime is intentionally independent from transport, persistence, and concrete tools: the CLI composes a task, a model provider, registered tools, and an event sink; the runtime coordinates them and emits typed events; the session package persists those events as an append-only conversation graph.

The repository uses:

- Node.js 22.12 or newer;
- pnpm workspaces;
- TypeScript in strict ESM mode;
- Vitest for unit and integration tests;
- TypeScript project references for production builds.

## Repository layout

```text
apps/cli/
  src/index.ts          CLI entry point, argument parsing and dependency wiring
  src/system-prompt.ts  Default coding-agent system prompt
  bin/codel.mjs         Published-style executable shim

packages/core/
  src/contracts.ts      Provider, tool, task, message and event contracts
  src/task-spec.ts      Runtime validation for external TaskSpec JSON
  src/runtime.ts        Deterministic Agent loop, budgets and event emission

packages/context/
  src/full-compaction.ts  Pure ContextStrategy and Full Compaction projection

packages/providers/
  src/scripted.ts       Deterministic provider for tests and offline scenarios
  src/openai.ts         OpenAI-compatible streaming provider

packages/tools/
  src/index.ts          Tool registrations exposed to a Host
  src/path-safety.ts    Workspace containment and filesystem safety rules
  src/*.ts              Tree, symbols, read, grep, patch, diff and exec support

packages/session/
  src/event-log.ts      JSONL encoding, parsing and conversation-graph validation
  src/projection.ts     Folds Agent Events into resumable Session state
  src/store.ts          Session lifecycle and durable EventSink integration
  src/branch.ts         Fork construction
  src/types.ts          Public Session types

tests/                  Unit and cross-package integration tests
fixtures/               Small deterministic workspaces and TaskSpec examples
benchmarks/             CLI smoke scenarios
```

Generated `dist/` files are build output. Change source files and rebuild instead of editing generated JavaScript or declarations by hand.

## Dependency boundaries

The intended workspace dependency graph is:

```text
apps/cli ─┬─> core
          ├─> context ─> core
          ├─> providers ─> core
          ├─> tools ─────> core
          └─> session ───> context ─> core
```

Preserve these rules:

1. `packages/core` must not import the CLI, providers, concrete tools, session storage, UI, or databases.
2. Providers translate an external model protocol into core `ModelResponse` values. They do not execute tools or own the Agent loop.
3. Tools operate within the workspace supplied by the Host and must use the shared path-safety and limit helpers.
4. Session persistence consumes core `AgentEvent` values. Core must remain usable without Session storage.
5. Context projection is pure and depends only on Core contracts. Session applies persisted Context checkpoints during replay.
6. `apps/cli` is the composition root. Provider selection, environment variables, filesystem paths and concrete registrations belong there.

## Runtime data flow

```text
TaskSpec JSON
  -> CLI parses and validates configuration
  -> CLI constructs Provider, Tools and SessionEventSink
  -> runAgent restores optional AgentResumeState
  -> Provider returns assistant text or Tool calls
  -> Runtime validates budgets and executes allowed Tools
  -> Runtime updates AgentState and emits ordered AgentEvents
  -> SessionEventSink appends enriched events to JSONL
  -> Context checkpoints may replace only the model-visible projection
  -> Session projection can later rebuild resumable state
```

`TaskSpec` is external input and must always pass runtime validation. TypeScript types alone are not a trust boundary. Likewise, model-generated tool names and inputs must be validated before any filesystem or process operation.

## Agent runtime invariants

- Agent Events within one run have a continuous sequence beginning at 1.
- A Tool result must match a previously emitted Tool call by call ID, name and Step.
- Only tools that are both registered by the Host and listed in `constraints.allowedTools` may execute.
- Step, Tool-call and Token budgets are checked by the runtime, not delegated to prompts.
- Usage accounting must survive persistence and Resume, including incomplete or invalid Provider responses.
- Durable event persistence is part of the run contract: the runtime must not report completion for an event that failed to commit.
- Provider protocol failures and interruption paths must terminate in a typed, replayable state.

When adding or changing an event, update the core type, runtime emission, Session validation, Session projection, Resume behavior and tests together.

## Session model

Each Session is stored as one `<session-id>.jsonl` file. A physical line is a top-level `AgentEvent` enriched with:

- `sessionId` — the owning Session;
- `uuid` — the event's graph identity;
- `parentUuid` — the previous event on that branch, or `null` at the root;
- `timestamp` — display and inspection metadata;
- `cwd` — the workspace associated with the event.

There is no separate manifest, checkpoint event or file snapshot protocol.

Important behavior:

- The file is append-only. Rewind does not truncate abandoned events.
- The active branch is the chain ending at the last physically appended leaf.
- Projection folds the active chain into messages, usage, pending calls and completed-Step state.
- Resume reuses the original Session ID and appends to its selected head.
- Rewind selects a completed Step and lets the next run append a new branch in the same file.
- Fork copies the selected chain into a self-contained child Session.
- Full Compaction appends `context.compacted`; it never truncates canonical rows.
- A Context checkpoint is valid only at a closed Tool-safe point and carries a
  `ContextSelectionManifest` binding it to the exact source chain.
- Rewind is conversation-only. It does not restore repository files.
- A torn final write may be repaired at the end of the file; malformed complete rows or invalid graph/protocol transitions must not be silently accepted.

Do not add locks, database indexes, provider fingerprints, checksums, file snapshots or new persistence envelopes unless a concrete requirement justifies the extra protocol and migration cost.

## Tool safety

- Resolve all model-provided paths against the configured workspace root.
- Reject absolute paths, traversal and symlink escapes where the operation requires containment.
- Keep output and file-size limits deterministic.
- `apply_patch` must validate the patch and target before mutating a file.
- Process execution must use Host-defined command profiles, arguments, environment rules and time limits. Never allow the model to invent an unrestricted shell command.
- Avoid leaking API keys, environment secrets or unrelated host files into Tool results or Session logs.

## Testing and verification

Run the complete local gate from the repository root:

```bash
pnpm verify
```

Equivalent individual commands are:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests should be deterministic and should not require a real API key unless they are explicitly designated as manual integration scenarios. For behavior changes, add the narrow unit test first, then add an integration test when the contract crosses package boundaries.

Session changes should cover both the live runtime state and the state reconstructed from JSONL. Branching tests should retain abandoned rows and verify that Resume selects the intended active chain.
Context changes should additionally verify that old transcript bytes remain
unchanged, Tool Call/Result pairs stay sealed, and manifest Hash mismatches fail
closed.

## Contribution workflow

1. Inspect the relevant package boundary before editing.
2. Keep changes scoped; do not mix generated output or unrelated formatting into a functional commit.
3. Preserve existing public contracts unless the change intentionally includes a migration.
4. Update README examples when CLI flags, environment variables or user-visible behavior change.
5. Run `pnpm verify` before submitting a change.
6. Never commit credentials, local Session transcripts, copied workspaces or temporary benchmark output.

The repository may already contain uncommitted user work. Preserve unrelated changes and stage only files that belong to the current task.
