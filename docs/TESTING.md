# Testing

## Environment Requirements

- Node.js 22.13 or newer.
- macOS runner with Keychain access for platform integration tests; local macOS D2 has passed, while remote-runner evidence remains required for release.
- Windows runner with Credential Manager access for platform integration tests.
- Linux runner for CLI and proxy regression coverage.
- Chromium for browser E2E and screenshot comparison.

## Required and Mocked Services

- Deterministic local mock upstreams for JSON responses, SSE, timeouts, TLS errors, 401, 404, compressed requests, and disconnects.
- Task 4 unit tests use injected entry loaders and an in-memory adapter without invoking the real addon loader or constructing a native entry. A separate authorized local macOS D2 has passed with the production native adapter and login Keychain; Windows, Linux, and remote macOS evidence remain platform targets.
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
- Task 10 focused suite: `cd node && node --test test/crp.test.mjs test/integration/crp-lifecycle.test.mjs`
- Task 11 browser suite: `cd node && npm run test:e2e -- --project=chromium --workers=1`
- Task 11 session/Admin regression: `cd node && node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs`
- Task 12 focused release gates: `cd node && node --test test/package-content.test.mjs test/native-keyring-smoke.test.mjs test/release-workflows.test.mjs`
- Task 12 package dry run: `cd node && npm pack --dry-run --json --ignore-scripts`
- Task 12 Changeset status: `cd node && npm run changeset -- status`
- Task 12 post-security focus: `cd node && node --test test/crp.test.mjs test/provider-service.test.mjs test/integration/admin-server.test.mjs`
- Core CLI/i18n/config focus: `cd node && node --test test/crp.test.mjs test/cli-i18n.test.mjs test/codex-config.test.mjs test/integration/admin-server.test.mjs`
- Serial production-component D1: `cd node && node scripts/run-test-group.mjs core-chain`
- Worker integration suite: `cd node && npm run test:integration`
- Runtime audit: `cd node && npm audit --omit=dev`

`npm run lint` recursively checks `.mjs` and `.js` files under `bin`, `src`, `scripts`, and `ui`, skipping source roots that have not landed. On Node 22.19, the Task 2 focused suite passes 15/15 tests. Its coverage verifies OpenAI provider creation and update, custom-provider and CRLF preservation, byte idempotency, one-time adjacent backup, exclusive same-timestamp backup collision handling, CRP lock contention, external source-change rejection, atomic mode-preserving replacement, deterministic rename-failure cleanup and original preservation, all nine injected-home paths, safe public error serialization, `start`/`install`/`setup` JSON and managed-state backup propagation, and accurate guide backup semantics.

The Node 22.19 Task 3 focused suite passes 23/23 tests. The Task 4 credential suite passes 41/41, the combined credential/provider suite passes 64/64, and the current full suite passes 91/91; `npm run lint` syntax-checks 14 source files. Task 4 coverage includes the shared async adapter contract, lazy native-loader failure, trusted injected private-file selection, no operation replay for native get/set/has/delete outages, explicit file-label restart continuity without migration, exact schema and string persistence, reload and refreshed reads, no enumeration API, two-instance lost-update prevention, strict parent/file modes, POSIX no-follow and simulated-Windows descriptor identity, symlink-swap rejection before byte reads, fsync/rename order, rollback cleanup, bounded secret-temp cleanup and permanent uncommitted degradation, gate-covered atomic lock claims, preexisting foreign-gate preservation, claim-before-delete gate release under an immediate foreign replacement, canonical blocker restoration, synchronous second-instance rejection during gate claim validation, normal claim cleanup and subsequent mutation, fresh-instance busy behavior, permanent committed lock degradation, input validation, and public provider masking. The public Supervisor requires native storage and exposes no file selector. Tests never invoke the default native loader or construct or query a real native credential entry. Real native-backend verification remains L3 on every supported system, including Windows and Linux; private file permission and rename semantics on Windows and Linux also remain unverified.

The Node 22.19 Task 5 focused suite passes 13/13 and the current full suite passes 102/102; `npm run lint` syntax-checks 15 source files. Coverage verifies generation validation and failure atomicity, deep clone/freeze behavior, public allowlisting, exactly one request-start snapshot capture, delayed A versus immediate B switching, a transport-option spy for TLS pinning before body arrival, pinned authentication, headers, timeout, capture context and request IDs, static compatibility, unconfigured-source rejection, dynamic health secret scans, request/response short and custom authentication debug masking, and bidirectional custom-auth capture redaction.

The Node 22.19 Task 6 focused suite passes 21/21, `npm run test:integration` passes 11/11, and `npm test` passes 112/112 top-level tests followed by 11/11 integration tests without duplication; `npm run lint` syntax-checks 18 source files. Coverage verifies exact directional schemas, HTTPS-or-loopback URL enforcement, HTTP-token authentication fields, Node-compatible final authentication values, sensitive and authentication-conflicting header rejection, secret sanitization, fixed invalid-message fatal IDs, and real child-process ready/configure/reconfigure/proxy/status/drain/shutdown flows. Synchronized tests prove configure is rejected after drain begins without replacing generation or losing its acknowledgement, duplicate drain requests keep both acknowledgements and later status drained, and parent disconnect terminates within a deadline despite a hanging upstream both before and after shutdown starts waiting. Invalid authentication values, configuration, stale generation, occupied-port startup, port release, request settlement, stderr/stdout scans, and deterministic deadline-driven cleanup remain covered.

The Node 22.19 Task 7 strict-unhandled focused suite passes 22/22. Exact `npm test` passes 126/126 non-capture unit assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run test:unit` passes all 133/133 top-level assertions; `npm run lint` syntax-checks 19 source files. Coverage verifies ready/configure/health startup, strict request correlation, acknowledgement-atomic generation changes, concurrent restart Promise identity and zero snapshot inspection before shared-operation reuse, restart prevalidation without drain side effects when no operation exists, send-failure waiter cancellation without unhandled rejections, early acknowledgement retention, graceful drain/shutdown, TERM/KILL escalation, retained retryable control after termination timeout, partial-start error preservation, fixed-port cleanup, same-port real-worker PID replacement, sanitized fatal and malformed messages, old-epoch isolation, cancellable injected-clock crash recovery, immediate failure on the fifth crash in 60 seconds, and idempotent close with no child, timer, listener, process, or port residue. The fifth in-window crash does not schedule the 4000 ms capped delay; only the first four 250/500/1000/2000 ms delays execute before the threshold.

The Node 22.19 Task 9 focused suite passes 42/42. Exact `npm test` passes 179/179 core assertions, 7/7 isolated capture assertions, and 23/23 integration assertions; `npm run lint` syntax-checks 26 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage verifies private descriptor-validated control tokens, browser expiry and CSRF, exact Host/Origin/CORS rejection, bounded exact JSON and empty-body contracts, every approved route, safe activity pagination, read-only settings, positive response/error/diagnostic projections, static asset allowlisting, active-only lifecycle credentials with in-flight command reuse, supervisor migration-before-registry composition, readiness-gated `0600` state, construction/listen rollback, independent Codex/state adapters, and idempotent signal cleanup. All new integration boundaries use temporary homes, injected stores/services, and loopback HTTP; real HOME, native keyring, external provider traffic, and actual UI assets remain outside this deterministic gate.

The Node 22.19 Task 8 focused suite passes 42/42. Exact `npm test` passes 168/168 core assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run lint` syntax-checks 22 source files. Coverage verifies the expanded activity denylist and full-file secret scans, Error/cycle/non-JSON handling, retention, atomic failure preservation, foreign lock replacement, and canonical degraded blocking; descriptor-safe temp-only migration, symlink rejection, byte-exact backups, exclusive final-path registry creation, identity/byte-owned rollback, foreign registry preservation, transaction locks, committed schema reconciliation, and canonical release blockers; active-update rejection, no-follow redirect behavior across two loopback origins, CRUD/credential committed outcomes, replacement rollback safety, selected credentials, explicit serialization, and deterministic `1 -> 2 -> 3` rollback after health or acknowledgement uncertainty. No test accesses a real HOME, native credential backend, or live upstream network.

The Node 22.19 Task 10 focused suite passes 27/27. Exact `npm test` passes 202/202 core assertions, 7/7 isolated capture assertions, and 24/24 integration assertions; `npm run lint` syntax-checks 27 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage verifies private state discovery, authenticated CLI dispatch for lifecycle and provider commands, browser-session discovery for `ui`, explicit legacy secret-bearing flag rejection, startup readiness and owner cleanup, `pid` plus `startedAt` shutdown identity, and bounded failed-spawn cleanup without child or state residue. `git diff --check` and the static secret-pattern scan pass. Tests use temporary homes and injected spawn/client boundaries; real HOME, native keyrings, external provider traffic, browser launch behavior, and cross-platform process identity and signal handling remain L3.

The 2026-07-14 Task 11 gate uses Playwright 1.61.1 and Chrome for Testing 149.0.7827.55. `npm run test:e2e -- --project=chromium --workers=1` passes 40/40, the focused session/Admin regression passes 16/16, exact `npm test` passes 202/202 core plus 7/7 isolated capture plus 24/24 integration assertions (233 total), `npm run lint` syntax-checks 28 source files, and `npm audit --omit=dev` reports zero vulnerabilities. Coverage verifies complete `en`/`zh-CN` dictionary parity and locale precedence, only explicit `crp.locale` persistence, onboarding, provider CRUD/test/activation and production invalidation rules, production activity values (`proxy`, `start`/`stop`/`restart`, and `failed`/`degraded`), validated mock-upstream HTTP/auth/Responses contracts, lifecycle confirmation, degraded/committed errors, read-only Settings, GET-only valid-cookie re-entry without a fragment, terminal exchange/session/CSRF failures, keyboard/focus semantics, fixture failure cleanup, and 390x844 automatic layout. Full-secret collectors await and scan console/page errors, request and response bodies, activity, diagnostics, DOM/input values, URL/history, local/session storage, IndexedDB, attachments, and screenshot bytes after the visible DOM scan. Requirements review and the subsequent quality/security/accessibility reviews ended `APPROVED` with no unresolved finding.

The 2026-07-14 Task 12 package/platform gate at `af918d5` passes the 21/21 focused package/native/workflow suite, exact 30-file package dry run, `actionlint`, and workflow policy checks. Safety commit `210cb71` then passes 67/67 post-security focused tests, 41/41 Chromium E2E, exact `npm test` with 227/227 core plus 7/7 isolated capture plus 24/24 integration assertions (258 total), `npm run lint` across 29 source files, `npm audit --omit=dev` with zero vulnerabilities, and diff checks. Coverage adds strict `init` alias rejection before discovery/writes, native-only public credential boundaries, rejected fallback fields, active-provider edit/delete blocking, metadata-only diagnostics, and secret-negative assertion ordering.

The earlier Task 12 documentation tree records: `npm run lint` checks 29 source files; `npm test` passes 258/258 (`227` core + `7` isolated capture + `24` integration); `npm run test:integration` passes 24/24; Chromium E2E passes 41/41; `npm audit --omit=dev` reports zero vulnerabilities; package-content passes 3/3 against the exact 30-file allowlist; Changeset status since `origin/main` is minor; and the cached diff check is clean. The workflow matrix is implemented but remote macOS/Windows/Linux run URLs do not yet exist in this review record. Remote platform native services, Windows screenshots, real-home migration/rollback, and cross-platform process/filesystem behavior remain pending L3 evidence. That earlier Task 12 local gate used no real provider credential or external upstream; the later D2 evidence is recorded separately below.

The latest core-first tree supersedes the full-suite counts above without changing Web files. `npm test` passes 295/295 as four serial groups: `unit-core` 262, isolated capture 7, ordinary integration 25, and `core-chain` 1. `npm run lint` syntax-checks 29 source files, `npm audit --omit=dev` reports zero vulnerabilities, and package-content still matches the exact reviewed 30-file allowlist. D1 runs `runCli -> SupervisorClient -> Admin -> registry/provider service -> WorkerManager -> real forked worker -> loopback upstreams`; it covers clean-home bootstrap, provider add/list/test/activate, actual Responses forwarding, A/B switching while A remains in flight, same-port restart with a new PID, status, stop, shutdown, secret scans, and process/state/port/temporary-root cleanup. Only credentials and upstreams are substituted, so this is deterministic composition evidence rather than native/external evidence. Added unit coverage proves a 2-second discovery probe returns a client with a separate 30-second operation timeout and proves structured proxy URL joining for root, `/v1`, trailing-slash, encoded-path, and combined-query cases.

Final manual D2 evidence uses real CLI processes, the production native-keyring adapter and login Keychain, a real Dusapi upstream, and a detached Supervisor. CRP paths and `CRP_HOME` are isolated while the real `HOME` remains available to Keychain. Provider test succeeds, activate/start succeed, the real proxy `/responses` request returns HTTP `200 OK`, health succeeds, restart preserves the Supervisor PID and replaces the worker PID, and stop/shutdown plus process/state/port/temporary-state cleanup succeed. A separate isolated clean-home detached run proves private `.codex`/`config.toml` creation, fixed `OpenAI`/`15100`, and bootstrap behavior. D2 passes the local core gate; it is not remote or cross-platform release evidence.

`npm run test:unit` retains its public behavior and runs all top-level `test/*.test.mjs` files. The exact `npm test` gate runs without duplication as four sequential groups: every non-capture top-level unit file, `capture-store.test.mjs` alone, recursively discovered ordinary integration tests excluding `core-real-chain.test.mjs`, then that fixed-port core chain alone. This isolates polling watcher registration and fixed-port process composition from unrelated load. `test:e2e` is a required UI gate; Task 12 combines the final-tree gate with cross-platform release evidence.

## Task 11 Visual Evidence

The Task 11 suite explicitly writes sanitized English and Simplified Chinese Overview images at 1440x900 after clearing launch-token and credential state:

- `output/playwright/task11/onboarding-onboards-in-Eng-57b0b-ce-and-finishes-on-Overview-chromium/overview-en.png`
- `output/playwright/task11/onboarding-onboards-in-Eng-57b0b-ce-and-finishes-on-Overview-chromium/overview-zh-CN.png`

These files are local review attachments under untracked `output/`, not source inputs and not part of the exact eight-file Task 11 commit. Do not stage or relocate them during release closeout. Automatic screenshots, traces, video, and failure artifacts remain disabled. The repository-retained evidence is the accepted visual contract and deterministic test that regenerates the images. Task 12 remote macOS and Windows jobs must attach fresh sanitized screenshots to the L3 review record; those artifact URLs are still pending, and no current rule requires committing PNGs to Git.

## Test Authoring Rules

- File-watcher tests must wait for observable state and register cleanup before assertions.
- Configuration persistence tests must verify no-op writes, exclusive backup collisions, lock cleanup, external source changes, and source permission preservation.
- Registry mutation must persist successfully before replacing in-memory state.
- Registry mutations must reload while holding the registry lock before replacing state.
- Lock cleanup must never mask a primary registry error or make a durable mutation appear retryable.
- A recorded residual registry lock must never be inspected or removed automatically.
- Public Supervisor tests must require native credentials; only trusted injected lower-level tests may select the private file adapter.
- Native operation failures must never be replayed into the independent file credential namespace.
- An injected construction-time private file-adapter label must be explicitly reused across restart; Task 4 performs no credential migration and exposes no public selector.
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
- Lifecycle fake waits must advance the injected clock and simulate owner cleanup.
- Before signaling a process, verify `pid` plus `startedAt` and never mutate state first.
- UI fixtures must mirror production enum, invalidation, wire-request, and public-response contracts.
- Secret submissions must clear state and the current DOM before validation, request dispatch, or re-rendering.
- Delayed focus restoration must cancel stale callbacks and preserve newer user focus.
- Temporary-resource leak checks must stay inside the current `$TMPDIR` and must not traverse all of `/var/folders`.
- Package-content tests must compare the complete tarball against the exact reviewed allowlist; presence-only checks are insufficient.
- Native credential release jobs must probe the intended Keychain, Credential Manager, or Secret Service backend and must not accept file fallback as passing evidence.
- macOS native-keyring tests must isolate CRP paths through `CRP_HOME` but preserve the real `HOME` required to access the login Keychain.
- Tests must import only dependencies declared directly by this package.
- Every workflow checkout before pull-request code executes must set `persist-credentials: false`.
- Secret-bearing negative tests must assert absence before equality so a failing equality cannot print the sentinel.
- D1 core-chain tests must run alone after ordinary integration, preflight both fixed ports, use observable bounded waits, scan every retained surface for complete secrets, and prove exact cleanup.
- Loopback or injected D1 evidence and detached lifecycle-only evidence must never be labeled as a native-keyring or real-upstream D2 pass.

## Test Matrix

| Area | Required Tests |
| --- | --- |
| Provider registry and migration | Validation, duplicate names, strict schema rejection, atomic persistence, and rollback; the existing migration suite covers descriptor-safe legacy reads, byte-exact backups, schema-2 idempotency, reverse rollback, foreign replacements, and committed/rollback degradation |
| Credentials | Required public native adapter, trusted-injection-only private file adapter, masking, deletion, log redaction |
| Worker protocol | Version mismatch, acknowledgement, stale generation rejection, crash handling |
| Proxy behavior | Auth rewrite, HTTP/SSE, compression, timeout, disconnect, optional model override |
| Activation | Failed test rejection, atomic new-request switch, in-flight old snapshot |
| Restart | Drain timeout, SIGTERM escalation, port release, same-port spawn, health failure |
| Codex bootstrap | Missing private parent/file creation with no backup, repeat byte idempotency, existing-file backup/mode preservation, no-follow identity/race rejection, stable OpenAI provider/fixed URL, and stable public errors |
| Admin API | Auth/session, CSRF, Host/Origin rejection, error contracts, secret write-only behavior |
| Core composition | Real CLI/Admin/registry/provider/WorkerManager/forked-worker path, A/B in-flight switching, same-port restart, stable JSON, secret scans, and exact cleanup |
| Native/upstream D2 | Locally passed on macOS: real detached Supervisor, production native Keychain retrieval, real Dusapi provider test and Responses request, fixed Codex config, redacted evidence, PID transition, and process/state/port cleanup; remote/cross-platform proof remains a release gate |
| UI E2E | First-run flow, two-provider switch, restart, errors, keyboard and accessibility scan |
| Cross-platform | Remote macOS and Windows UI artifacts; real native backend on macOS, Windows, and Linux; Linux CLI regression; workflow run URLs retained |

The existing migration suite uses injected temporary paths and adapters. Migration and rollback against a real home, native credential service, and platform filesystem remain pending L3 confirmation.

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

Credential, config migration, lifecycle, browser-security, exact package, release-policy, and platform workflow tests must all pass before L3 expert release review. Deterministic D1 and authorized production macOS D2 now both pass, completing the local core gate. Detached lifecycle alone, native entry metadata alone, or workflow definitions remain insufficient, and local D2 does not replace remote macOS/Windows/Linux native-service, filesystem/ACL, visual, migration, or human evidence.

Tasks 2 and 3 do not remove the L3 requirement, and atomic rename and permission behavior remain unverified on real Windows and Linux hosts.
