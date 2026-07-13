# Agent Coordination

## Active Workstreams

None. Task 12 must be claimed here with an exact writable scope and no-edit areas before implementation begins.

## Completed Workstreams

| Workstream | Owner | Scope | Files/Areas | Status | No-Edit Areas |
| --- | --- | --- | --- | --- | --- |
| Task 11 guided bilingual Web UI | `/root/task11_ui` | Implement and verify the user-approved English/Simplified Chinese static UI | `node/ui/index.html`; `node/ui/styles.css`; `node/ui/app.js`; `node/playwright.config.mjs`; `node/test/e2e/crp-ui-fixture.mjs`; `node/test/e2e/onboarding.spec.mjs`; `node/test/e2e/provider-switch.spec.mjs`; `node/test/e2e/restart-and-errors.spec.mjs` | Completed, committed as `d114061`, and released on 2026-07-14; no active write authority | All backend, CLI, manifest, existing non-E2E test, contract, and release files |
| Task 11 documentation closeout | `/root/task11_docs_closeout` | Synchronize verified Task 11 facts and hand off Task 12 | `AGENTS.md`; `docs/AGENT_COORDINATION.md`; `docs/AI_HANDOFF.md`; `docs/STATUS.md`; `docs/ROADMAP.md`; `docs/TESTING.md`; `docs/UIUX.md`; existing Task 11 design/plan docs | Completed and released on 2026-07-14; no active write authority | `node/**`; `output/**`; manifests; implementation and release workflow files |

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

- No Task 11 source or documentation writer remains active; both completed writer scopes are permanently released.
- `node/package.json` and `node/package-lock.json` are no-edit by default because Playwright and the E2E scripts landed in Task 1; a discovered manifest defect must return to the coordinator for a separate scope decision.
- The Task 11 shared E2E helper is `node/test/e2e/crp-ui-fixture.mjs`; no second fixture file was added.
- Future agents must not change shared contracts without first updating the owning doc and coordination row.
- Credential, migration, and lifecycle work must be isolated from UI styling work until contracts pass review.

## Decisions Needed

Task 11 source and documentation writer scopes are closed; the exact source commit prerequisite is satisfied by `d114061`, and the completed closeout is included in this documentation commit. The next authorized slice is Task 12, "Complete Migration, Cross-Platform Gates, Docs, and Release Readiness," after a new coordination row assigns its workflow, packaging, release-documentation, and platform-test files. Work remains on the dedicated branch `codex/harness-product-design`; Task 11 has not been merged or pushed, and cross-platform evidence, packaging/release checks, and L3 expert confirmation remain outstanding.
