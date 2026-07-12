# Testing

## Environment Requirements

- Node.js 22.13 or newer.
- macOS runner with Keychain access for platform integration tests.
- Windows runner with Credential Manager access for platform integration tests.
- Linux runner for CLI and proxy regression coverage.
- Chromium for browser E2E and screenshot comparison.

## Required and Mocked Services

- Deterministic local mock upstreams for JSON responses, SSE, timeouts, TLS errors, 401, 404, compressed requests, and disconnects.
- Native credential stores are exercised in platform integration jobs; unit tests use an in-memory adapter.
- No real API key is required in CI.

## Current Commands

- Portable syntax check: `cd node && npm run lint`
- Existing full suite: `cd node && npm test`
- Top-level unit suite: `cd node && npm run test:unit`
- Task 2 focused suite: `cd node && node --test test/codex-config.test.mjs`
- Task 3 focused suite: `cd node && node --test test/provider-registry.test.mjs`
- Runtime audit: `cd node && npm audit --omit=dev`

`npm run lint` recursively checks `.mjs` and `.js` files under `bin`, `src`, `scripts`, and `ui`, skipping source roots that have not landed. On Node 22.19, the Task 2 focused suite passes 15/15 tests. Its coverage verifies OpenAI provider creation and update, custom-provider and CRLF preservation, byte idempotency, one-time adjacent backup, exclusive same-timestamp backup collision handling, CRP lock contention, external source-change rejection, atomic mode-preserving replacement, deterministic rename-failure cleanup and original preservation, all nine injected-home paths, safe public error serialization, `start`/`install`/`setup` JSON and managed-state backup propagation, and accurate guide backup semantics.

The Node 22.19 Task 3 focused suite passes 23/23 tests and the current full suite passes 50/50 tests; `npm run lint` syntax-checks 11 source files. Task 3 coverage includes normalized CRUD, multi-instance lock serialization and read refresh, stale uniqueness rejection, immutable fields, canonical safe URLs, header and auth-scheme validation, model policy defaults, test-state invalidation/reset, timestamp ordering, activation and deletion, strict reload rejection, lazy first persistence, `0600` lock and file modes, same-directory fsync/rename ordering, validation and rename rollback, transient and permanent lock cleanup, primary-error preservation, foreign-lock and temporary-file preservation, defensive copies, and exact public projection. Real Windows and Linux rename and permission semantics remain unverified.

`npm run test:unit` runs only top-level `test/*.test.mjs` files. The `test:integration` runner is present and recursively discovers `test/integration/**/*.test.mjs`, but no integration tests exist yet, so it intentionally fails with an explicit no-files error and is not part of the current runnable gate. `test:e2e` and the combined `test:all` command are also not current gates until the UI, Playwright configuration, and E2E specs land.

## Test Authoring Rules

- File-watcher tests must wait for observable state and register cleanup before assertions.
- Configuration persistence tests must verify no-op writes, exclusive backup collisions, lock cleanup, external source changes, and source permission preservation.
- Registry mutation must persist successfully before replacing in-memory state.
- Registry mutations must reload while holding the registry lock before replacing state.
- Lock cleanup must never mask a primary registry error or make a durable mutation appear retryable.
- A recorded residual registry lock must never be inspected or removed automatically.

## Test Matrix

| Area | Required Tests |
| --- | --- |
| Provider registry | Validation, duplicate names, strict schema rejection, atomic persistence, rollback; migration is covered by the future migration suite |
| Credentials | Native adapter contract, file fallback permission, masking, deletion, log redaction |
| Worker protocol | Version mismatch, acknowledgement, stale generation rejection, crash handling |
| Proxy behavior | Auth rewrite, HTTP/SSE, compression, timeout, disconnect, optional model override |
| Activation | Failed test rejection, atomic new-request switch, in-flight old snapshot |
| Restart | Drain timeout, SIGTERM escalation, port release, same-port spawn, health failure |
| Codex bootstrap | Backup, idempotency, stable OpenAI provider, fixed URL, recovery |
| Admin API | Auth/session, CSRF, Host/Origin rejection, error contracts, secret write-only behavior |
| UI E2E | First-run flow, two-provider switch, restart, errors, keyboard and accessibility scan |
| Cross-platform | macOS and Windows UI path; Linux CLI regression |

## First Vertical Slice Acceptance

1. Start from an isolated temporary home directory.
2. Launch `crp ui` without a saved provider.
3. Create and test two mock providers through the browser.
4. Activate provider A and complete a proxied request.
5. Keep a request in flight while activating provider B; verify old/new snapshot behavior.
6. Verify the Codex provider key remains `OpenAI` and the proxy URL remains fixed.
7. Restart the worker from the UI and verify supervisor availability and same-port recovery.
8. Confirm API responses, logs, activity, capture headers, and diagnostics contain no complete key.
9. Capture approved macOS and Windows screenshots and run accessibility checks.

## Verification Gate

Credential, config migration, lifecycle, and browser-security tests must all pass before L3 expert review. Passing unit tests alone is insufficient.

Tasks 2 and 3 do not remove the L3 requirement, and atomic rename and permission behavior remain unverified on real Windows and Linux hosts.
