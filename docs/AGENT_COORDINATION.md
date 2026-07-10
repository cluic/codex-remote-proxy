# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| Harness and design | Primary Codex | Documentation only | `AGENTS.md`, `.codex/`, `docs/` | In review | User design approval | Product code under `node/` |

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

- No parallel writable work is authorized while the written spec is under review.
- Future agents must not change shared contracts without first updating the owning doc and coordination row.
- Credential, migration, and lifecycle work must be isolated from UI styling work until contracts pass review.

## Decisions Needed

No blocking decision remains for planning. File ownership and worktree assignments must be added before any parallel implementation begins.
