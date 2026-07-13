# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| V1 sequential implementation | Primary Codex plus Task 8 implementation agent | Resolve Task 8 security-review findings with one writer | Task 8 owns `node/src/supervisor/activity-store.mjs`, `node/src/supervisor/migration.mjs`, `node/src/supervisor/provider-service.mjs`, their three focused tests, and affected living docs | Review fixes implemented; deterministic gates passing; re-review pending; real HOME/keyring/network migration remains prohibited | Task 8 commit `fa5e485468065c3f2eff54d2c9ebcc69fbcf8e35` | Existing provider registry, credential adapters, worker manager, server/runtime settings, capture, Codex, CLI/bin, Admin API, UI, runners, package scripts, and every other module; no simultaneous writable agent |

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
