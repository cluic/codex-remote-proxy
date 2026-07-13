# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| V1 sequential implementation | Primary Codex plus Task 9 implementation agent | Build the secured loopback Admin API and supervisor composition with one writer | Task 9 owns `node/src/supervisor/session-auth.mjs`, `node/src/supervisor/admin-server.mjs`, `node/src/supervisor/supervisor.mjs`, `node/src/supervisor/supervisor-entry.mjs`, `node/test/session-auth.test.mjs`, `node/test/integration/admin-server.test.mjs`, a minimal lifecycle facade in `node/src/supervisor/provider-service.mjs` with its focused tests in `node/test/provider-service.test.mjs`, and affected living docs | Task 9 implementation and deterministic gates are complete; independent review is next; real HOME, native keyrings, external network, UI, CLI, and runner changes remain prohibited | Task 8 commit `776265c8113f39b26f2bb5cd1418cfc275c4156e` | Provider registry, credential adapters, worker manager internals, server/runtime settings, capture, Codex adapter internals, migration/activity persistence, UI, CLI/bin, runners, package scripts, and every other module; no simultaneous writable agent |

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
