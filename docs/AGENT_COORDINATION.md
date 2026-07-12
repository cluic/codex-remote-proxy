# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| V1 sequential implementation | Primary Codex plus Task 6 implementation agent | Resolve the final Task 6 shutdown/disconnect escalation review finding with one writer | Task 6 owns `node/src/worker/worker-entry.mjs`, `node/test/integration/worker-entry.test.mjs`, and affected living docs; the completed protocol and grouped test runner remain unchanged | Task 6 bounded shutdown/disconnect escalation fix complete on `codex/harness-product-design`; Task 7 is next | Task 6 amended commit | Task 5 server/runtime settings and capture source/tests, test runner/package, supervisor/manager, providers, credentials, Codex, CLI/bin, Admin API, UI, and every other module; no simultaneous writable agent |

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
