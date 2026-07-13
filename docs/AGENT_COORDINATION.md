# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| V1 sequential implementation | Primary Codex plus Task 7 implementation agent | Resolve Task 7 lifecycle review findings with one writer | Task 7 owns `node/src/supervisor/worker-manager.mjs`, `node/test/fixtures/fake-worker.mjs`, `node/test/worker-manager.test.mjs`, `node/test/integration/worker-restart.test.mjs`, `node/scripts/run-tests.mjs`, the minimal group selection in `node/scripts/run-test-group.mjs`, and affected living docs | Task 7 review fixes complete and deterministic gates pass; pending re-review | Task 7 commit `9129df281a3fb58724aeb5866d0bb08aabf2747d` | Task 6 protocol/worker entry, Task 5 server/runtime settings and capture source/tests, provider and credential stores, Codex, CLI/bin, Admin API, UI, package scripts, and every other module; no simultaneous writable agent |

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
