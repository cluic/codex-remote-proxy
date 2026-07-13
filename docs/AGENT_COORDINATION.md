# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| V1 sequential implementation | None | Task 10 supervisor-backed CLI routing is complete; Task 11 actual Web UI assets are next but unclaimed | No files are currently claimed; the Task 11 writer must declare exact files and no-edit areas here before editing | Task 10 complete; Task 11 not started | Completed Tasks 1 through 10 | All files remain no-edit until the next single writer records a bounded Task 11 scope; no simultaneous writable agent |

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

- No writable work is currently authorized; the next task implementer must claim a bounded scope here, and review agents remain read-only.
- Future agents must not change shared contracts without first updating the owning doc and coordination row.
- Credential, migration, and lifecycle work must be isolated from UI styling work until contracts pass review.

## Decisions Needed

Subagent-driven execution is selected. Task 11 actual Web UI assets are next but unclaimed. Its writer must derive the exact file boundary and verification gate from the approved plan and record them in the active-workstream row before editing. Work remains on the dedicated branch `codex/harness-product-design`; no linked worktree or parallel writable work is in use.
