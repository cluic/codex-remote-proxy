# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| V1 sequential implementation | Primary Codex plus Task 5 implementation agent | Resolve the Task 5 response-log review finding with one writer and read-only re-review | Task 5 owns `node/src/worker/runtime-settings.mjs`, `node/src/server.mjs`, `node/test/runtime-settings.test.mjs`, `node/test/server.test.mjs`, and affected living docs | Task 5 P1 response-log fix implemented; re-review next | Task 4 credential adapters | Credentials, providers, Codex bootstrap, CLI, IPC, UI, and every other module; no simultaneous writable agent |

## Shared Contracts

- Stable Codex provider and proxy URL invariants: `docs/ARCHITECTURE.md`.
- Provider schema: `docs/DATA_MODEL.md`.
- Admin HTTP contract: `docs/API.md`.
- Security boundary: `docs/PERMISSIONS.md`.
- Acceptance gate: `docs/TESTING.md`.

## Integration Points

- Supervisor owns persistent state and spawns the worker.
- Worker receives versioned immutable snapshots over authenticated parent-child IPC.
- UI and CLI use the same Admin API semantics.
- Credential adapters share one contract but have platform-specific implementations.

## Locks / Avoid Editing

- No parallel writable work is authorized; only one task implementer may write at a time, and review agents are read-only.
- Future agents must not change shared contracts without first updating the owning doc and coordination row.
- Credential, migration, and lifecycle work must be isolated from UI styling work until contracts pass review.

## Decisions Needed

Subagent-driven execution is selected. Work remains on the dedicated branch `codex/harness-product-design`; no linked worktree or parallel writable work is in use.
