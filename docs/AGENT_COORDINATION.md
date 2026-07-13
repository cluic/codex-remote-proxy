# Agent Coordination

## Active Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | Depends On | No-Edit Areas |
| --- | --- | --- | --- | --- | --- | --- |
| Task 11 guided bilingual Web UI | `/root/task11_ui` | Implement the user-approved English/Simplified Chinese static UI and deterministic browser acceptance from base `7a87466` | `node/ui/index.html`; `node/ui/styles.css`; `node/ui/app.js`; `node/playwright.config.mjs`; `node/test/e2e/onboarding.spec.mjs`; `node/test/e2e/provider-switch.spec.mjs`; `node/test/e2e/restart-and-errors.spec.mjs`; only if shared setup is required, `node/test/e2e/crp-ui-fixture.mjs` | Claimed; implementation not started | Completed Tasks 1-10; approved 2026-07-13 UI/i18n addendum and Task 11 plan | All `node/src/**`, `node/bin/**`, existing tests outside `node/test/e2e/**`, package manifests, root release docs, API/data/security contracts, credential/migration/lifecycle code, and every file not listed in Files/Areas; no simultaneous writable agent |

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

- `/root/task11_ui` is the only authorized Task 11 implementation writer. Review agents remain read-only.
- `node/package.json` and `node/package-lock.json` are no-edit by default because Playwright and the E2E scripts landed in Task 1; a discovered manifest defect must return to the coordinator for a separate scope decision.
- The optional shared E2E helper, if needed, must use the exact path `node/test/e2e/crp-ui-fixture.mjs`; no other fixture file is authorized.
- Future agents must not change shared contracts without first updating the owning doc and coordination row.
- Credential, migration, and lifecycle work must be isolated from UI styling work until contracts pass review.

## Decisions Needed

Subagent-driven execution is selected. The Task 11 writer must follow `docs/superpowers/specs/2026-07-13-crp-ui-i18n-design.md` and `docs/superpowers/plans/2026-07-13-crp-task11-ui-i18n-implementation.md`, return verification evidence to the coordinator, and must not expand the file boundary. Work remains on the dedicated branch `codex/harness-product-design`; no linked worktree or parallel writable work is in use.
