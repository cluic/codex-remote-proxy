# Testing

## Environment Requirements

- Node.js 22.13 or newer.
- macOS runner with Keychain access for platform integration tests.
- Windows runner with Credential Manager access for platform integration tests.
- Linux runner for CLI and proxy regression coverage.
- Chromium for browser E2E and screenshot comparison.

## Required and Mocked Services

- Deterministic local mock upstreams for JSON responses, SSE, timeouts, TLS errors, 401, 404, compressed requests, and disconnects.
- Native credential stores remain a platform integration target; Task 4 unit tests use injected entry loaders and an in-memory adapter without invoking the real addon loader or constructing a native entry.
- No real API key is required in CI.

## Current Commands

- Portable syntax check: `cd node && npm run lint`
- Existing full suite: `cd node && npm test`
- Top-level unit suite: `cd node && npm run test:unit`
- Task 2 focused suite: `cd node && node --test test/codex-config.test.mjs`
- Task 3 focused suite: `cd node && node --test test/provider-registry.test.mjs`
- Task 4 focused suite: `cd node && node --test test/credential-store.test.mjs`
- Task 4 combined credential/provider suite: `cd node && node --test test/credential-store.test.mjs test/provider-registry.test.mjs`
- Task 5 focused suite: `cd node && node --test test/runtime-settings.test.mjs test/server.test.mjs`
- Task 6 focused suite: `cd node && node --test test/worker-protocol.test.mjs test/integration/worker-entry.test.mjs`
- Task 7 focused suite: `cd node && node --test test/worker-manager.test.mjs test/integration/worker-restart.test.mjs`
- Task 9 focused suite: `cd node && node --test test/session-auth.test.mjs test/provider-service.test.mjs test/integration/admin-server.test.mjs`
- Task 8 focused suite: `cd node && node --test test/activity-store.test.mjs test/migration.test.mjs test/provider-service.test.mjs`
- Worker integration suite: `cd node && npm run test:integration`
- Runtime audit: `cd node && npm audit --omit=dev`

`npm run lint` recursively checks `.mjs` and `.js` files under `bin`, `src`, `scripts`, and `ui`, skipping source roots that have not landed. On Node 22.19, the Task 2 focused suite passes 15/15 tests. Its coverage verifies OpenAI provider creation and update, custom-provider and CRLF preservation, byte idempotency, one-time adjacent backup, exclusive same-timestamp backup collision handling, CRP lock contention, external source-change rejection, atomic mode-preserving replacement, deterministic rename-failure cleanup and original preservation, all nine injected-home paths, safe public error serialization, `start`/`install`/`setup` JSON and managed-state backup propagation, and accurate guide backup semantics.

The Node 22.19 Task 3 focused suite passes 23/23 tests. The Task 4 credential suite passes 41/41, the combined credential/provider suite passes 64/64, and the current full suite passes 91/91; `npm run lint` syntax-checks 14 source files. Task 4 coverage includes the shared async adapter contract, lazy native-loader failure, construction-only fallback, no operation replay for native get/set/has/delete outages, explicit file-label restart continuity without migration, exact schema and string persistence, reload and refreshed reads, no enumeration API, two-instance lost-update prevention, strict parent/file modes, POSIX no-follow and simulated-Windows descriptor identity, symlink-swap rejection before byte reads, fsync/rename order, rollback cleanup, bounded secret-temp cleanup and permanent uncommitted degradation, gate-covered atomic lock claims, preexisting foreign-gate preservation, claim-before-delete gate release under an immediate foreign replacement, canonical blocker restoration, synchronous second-instance rejection during gate claim validation, normal claim cleanup and subsequent mutation, fresh-instance busy behavior, permanent committed lock degradation, input validation, and public provider masking. Tests never invoke the default native loader or construct or query a real native credential entry. Real native-backend verification remains L3 on every supported system, including Windows and Linux; file permission and rename semantics on Windows and Linux also remain unverified.

The Node 22.19 Task 5 focused suite passes 13/13 and the current full suite passes 102/102; `npm run lint` syntax-checks 15 source files. Coverage verifies generation validation and failure atomicity, deep clone/freeze behavior, public allowlisting, exactly one request-start snapshot capture, delayed A versus immediate B switching, a transport-option spy for TLS pinning before body arrival, pinned authentication, headers, timeout, capture context and request IDs, static compatibility, unconfigured-source rejection, dynamic health secret scans, request/response short and custom authentication debug masking, and bidirectional custom-auth capture redaction.

The Node 22.19 Task 6 focused suite passes 21/21, `npm run test:integration` passes 11/11, and `npm test` passes 112/112 top-level tests followed by 11/11 integration tests without duplication; `npm run lint` syntax-checks 18 source files. Coverage verifies exact directional schemas, HTTPS-or-loopback URL enforcement, HTTP-token authentication fields, Node-compatible final authentication values, sensitive and authentication-conflicting header rejection, secret sanitization, fixed invalid-message fatal IDs, and real child-process ready/configure/reconfigure/proxy/status/drain/shutdown flows. Synchronized tests prove configure is rejected after drain begins without replacing generation or losing its acknowledgement, duplicate drain requests keep both acknowledgements and later status drained, and parent disconnect terminates within a deadline despite a hanging upstream both before and after shutdown starts waiting. Invalid authentication values, configuration, stale generation, occupied-port startup, port release, request settlement, stderr/stdout scans, and deterministic deadline-driven cleanup remain covered.

The Node 22.19 Task 7 strict-unhandled focused suite passes 22/22. Exact `npm test` passes 126/126 non-capture unit assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run test:unit` passes all 133/133 top-level assertions; `npm run lint` syntax-checks 19 source files. Coverage verifies ready/configure/health startup, strict request correlation, acknowledgement-atomic generation changes, concurrent restart Promise identity and zero snapshot inspection before shared-operation reuse, restart prevalidation without drain side effects when no operation exists, send-failure waiter cancellation without unhandled rejections, early acknowledgement retention, graceful drain/shutdown, TERM/KILL escalation, retained retryable control after termination timeout, partial-start error preservation, fixed-port cleanup, same-port real-worker PID replacement, sanitized fatal and malformed messages, old-epoch isolation, cancellable injected-clock crash recovery, immediate failure on the fifth crash in 60 seconds, and idempotent close with no child, timer, listener, process, or port residue. The fifth in-window crash does not schedule the 4000 ms capped delay; only the first four 250/500/1000/2000 ms delays execute before the threshold.

The Node 22.19 Task 9 focused suite passes 42/42. Exact `npm test` passes 179/179 core assertions, 7/7 isolated capture assertions, and 23/23 integration assertions; `npm run lint` syntax-checks 26 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage verifies private descriptor-validated control tokens, browser expiry and CSRF, exact Host/Origin/CORS rejection, bounded exact JSON and empty-body contracts, every approved route, safe activity pagination, read-only settings, positive response/error/diagnostic projections, static asset allowlisting, active-only lifecycle credentials with in-flight command reuse, supervisor migration-before-registry composition, readiness-gated `0600` state, construction/listen rollback, independent Codex/state adapters, and idempotent signal cleanup. All new integration boundaries use temporary homes, injected stores/services, and loopback HTTP; real HOME, native keyring, external provider traffic, and actual UI assets remain outside this deterministic gate.

The Node 22.19 Task 8 focused suite passes 42/42. Exact `npm test` passes 168/168 core assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run lint` syntax-checks 22 source files. Coverage verifies the expanded activity denylist and full-file secret scans, Error/cycle/non-JSON handling, retention, atomic failure preservation, foreign lock replacement, and canonical degraded blocking; descriptor-safe temp-only migration, symlink rejection, byte-exact backups, exclusive final-path registry creation, identity/byte-owned rollback, foreign registry preservation, transaction locks, committed schema reconciliation, and canonical release blockers; active-update rejection, no-follow redirect behavior across two loopback origins, CRUD/credential committed outcomes, replacement rollback safety, selected credentials, explicit serialization, and deterministic `1 -> 2 -> 3` rollback after health or acknowledgement uncertainty. No test accesses a real HOME, native credential backend, or live upstream network.

`npm run test:unit` retains its public behavior and runs all top-level `test/*.test.mjs` files. The exact `npm test` gate runs the same top-level set without duplication as two sequential groups: every non-capture unit file first, then `capture-store.test.mjs` alone, followed by recursively discovered `test/integration/**/*.test.mjs`. This isolates the polling watcher registration baseline from unrelated unit load and keeps real child-process integration after watcher cleanup. `test:e2e` and the combined `test:all` command are not current gates until the UI, Playwright configuration, and E2E specs land.

## Test Authoring Rules

- File-watcher tests must wait for observable state and register cleanup before assertions.
- Configuration persistence tests must verify no-op writes, exclusive backup collisions, lock cleanup, external source changes, and source permission preservation.
- Registry mutation must persist successfully before replacing in-memory state.
- Registry mutations must reload while holding the registry lock before replacing state.
- Lock cleanup must never mask a primary registry error or make a durable mutation appear retryable.
- A recorded residual registry lock must never be inspected or removed automatically.
- File credential fallback must never be selected without explicit consent.
- Native operation failures must never be replayed into the independent file credential namespace.
- A construction-time file fallback label must be explicitly reused across restart; Task 4 performs no credential migration.
- Credential-store tests must inject native entry loaders and must never invoke the default loader or access a developer's real OS credential store.
- Secret files must be read from a validated descriptor, never by path after a metadata check.
- Secret-temp cleanup failure must degrade the instance instead of permitting another mutation.
- Credential mutation must remain gate-protected, and the canonical primary lock must cover gate claim validation.
- Gate release must atomically claim the canonical path and delete only an ownership-verified claim; it must never delete the canonical path after a separate identity check.
- Primary lock release must follow gate claim validation or proven blocker restoration; an uncertain gate state must retain the primary path.
- Runtime snapshots must be cloned and deeply frozen before the active reference is replaced.
- Proxy tests must prove one snapshot read before body listeners and pin every request-level upstream decision to it.
- Snapshot-switch tests must make every pre-fix routing path terminate deterministically.
- Request and response debug/capture tests must use the active custom authentication header and scan for complete short and long secret values.
- Worker protocol tests must reject unknown fields and versions, remote plaintext upstreams, non-token authentication fields, and sensitive or authentication-conflicting extra headers, and prove that child messages and sanitized projections contain no configure settings, complete secrets, or unvalidated request IDs.
- Child-process integration tests must use observable events and bounded deadlines instead of fixed sleeps, register cleanup before assertions, and leave no worker or test process behind.
- Worker drain must close idle keep-alive sockets after the final in-flight response before acknowledging.
- Worker configuration must be rejected once drain begins without replacing generation or losing the pending drain acknowledgement.
- Duplicate drain requests must keep every acknowledgement and subsequent status in the drained phase.
- Configure tests must validate the exact authentication header value and prove invalid keys are absent from child IPC, stdout, and stderr.
- Parent IPC disconnect cleanup must start or reuse bounded escalation even when shutdown is already waiting on an upstream request.
- Real-fork integration tests must run after watcher-bearing top-level tests, never concurrently with that group.
- Worker lifecycle tests must drive injected clocks and observable process, IPC, HTTP, and port events; fixed sleeps are prohibited.
- Polling watcher suites without an observable ready event must run in an isolated sequential group.
- Restart validation must complete before any drain message, phase change, or current-worker mutation.
- IPC acknowledgement waiters must be observed immediately and cancelled on send failure.
- Lifecycle code must retain child control after termination timeout until exit and port release are confirmed.
- Host-header security tests must use a transport that preserves the explicit `Host` value; browser-style fetch implementations may normalize restricted headers.
- Admin contract tests must scan every serialized success and failure for complete credentials, credential references, session/control tokens, raw causes, stacks, and unknown error details.
- Supervisor tests must hold Admin readiness behind an observable gate and prove state is absent before readiness, private afterward, and removed by idempotent reverse-order cleanup.
- Activity tests must scan the complete persisted file for every generated secret and cover retention, atomic-write failure, foreign locks, and committed lock degradation.
- Migration tests must use only injected temporary paths/adapters and cover byte-exact exclusive backups, schema-2 idempotency, reverse rollback, residual-lock degradation, and backup retention.
- Provider-service compensation tests must fail before implementation and cover create, credential replacement, delete, active-delete ordering, stable test classifications, selected credentials, explicit concurrency serialization, and activation rollback.
- Post-ack activation rollback must use a newer generation and confirm both acknowledgement and health before replacing the confirmed snapshot.
- A rejected worker start/apply Promise must be treated as an unknown commit once sending was attempted; prior state requires a higher-generation deterministic rollback, while no-prior state requires bounded stop.
- Committed/degraded mutation tests must reconcile registry and credential facts without inverse compensation, and replacement rollback must never restore `passed` unless the old secret was restored successfully.

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
