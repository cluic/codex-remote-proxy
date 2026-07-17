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
- UI typecheck: `cd node && npm run typecheck:ui`
- UI production build: `cd node && npm run build:ui`
- Exact synchronized three-file UI verification: `cd node && npm run verify:ui-build`
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
- Detached-startup migration-error focus: `cd node && node --test test/crp.test.mjs test/migration.test.mjs test/integration/admin-server.test.mjs`
- Current V8 browser suite: `cd node && npm run test:e2e -- --project=chromium --workers=1`
- Current session/Admin regression: `cd node && node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs`
- Task 12 focused release gates: `cd node && node --test test/package-content.test.mjs test/native-keyring-smoke.test.mjs test/release-workflows.test.mjs`
- Task 12 package dry run: `cd node && npm pack --dry-run --json --ignore-scripts`
- Task 12 Changeset status: `cd node && npm run changeset -- status`
- Task 12 post-security focus: `cd node && node --test test/crp.test.mjs test/provider-service.test.mjs test/integration/admin-server.test.mjs`
- Core CLI/i18n/config focus: `cd node && node --test test/crp.test.mjs test/cli-i18n.test.mjs test/codex-config.test.mjs test/integration/admin-server.test.mjs`
- CLI human-output/help focus: `cd node && node --test test/cli-i18n.test.mjs`
- M2C provider-model cache focus: `cd node && node --test test/provider-model-cache.test.mjs`
- M2C CLI focus: `cd node && node --test test/crp.test.mjs test/cli-i18n.test.mjs`
- M2C control-plane sources: `cd node && node --test test/provider-registry.test.mjs test/provider-service.test.mjs test/integration/admin-server.test.mjs`
- M2D/V7 history/config focus: `cd node && node --test test/codex-config.test.mjs test/codex-history-repair.test.mjs`
- M2D/V7 strict status/lifecycle focus: `cd node && node --test test/crp.test.mjs test/worker-manager.test.mjs test/integration/admin-server.test.mjs test/integration/crp-lifecycle.test.mjs test/integration/worker-restart.test.mjs`
- M2E/V8 Metrics focus: `cd node && node --test test/metrics-store.test.mjs test/server.test.mjs test/worker-protocol.test.mjs test/worker-manager.test.mjs test/provider-service.test.mjs test/integration/admin-server.test.mjs`
- Capture reconciliation focus: `cd node && node --test test/capture-store.test.mjs`
- Serial production-component D1: `cd node && node scripts/run-test-group.mjs core-chain`
- Worker integration suite: `cd node && npm run test:integration`
- Runtime audit: `cd node && npm audit --omit=dev`

## M2E/V8 Final Local Gate

V8 browser fixtures use the production Admin enum values, response shapes, Setup CAS-selection semantics, and explicit activation start-on-stopped-Worker behavior. V8.1 coverage adds full model selection/manual preservation, sidebar route/lifecycle actions, Provider duplication, fixed message geometry, and explicit recovery after GET-only re-entry. The suite also covers conditional first setup, 24h/7d Metrics success/empty/degraded/unavailable states, Provider-card switching, Activity/System, terminal authentication, keyboard focus, and desktop/narrow responsive layouts.

Final local evidence on Node 22.19 is exact `npm test` 463/463 (`412` unit-core + `8` isolated capture + `42` ordinary integration + `1` serial core-chain), Metrics focus 6/6, lint across 33 source files, UI typecheck/build/exact-output verification, package-content 3/3 against the exact 33-file allowlist, Chromium 33/33, and zero vulnerabilities in both full and runtime audits. The Chromium suite includes the complete English/Chinese 1440/1024/390 responsive matrix with no skipped case.

Visual evidence is retained at `output/web-v8/`: matched 1272x716 v0/implementation Overview captures and their side-by-side comparison, Provider cards at desktop width, and the narrow Overview capture. `design-qa.md` records no page-level horizontal overflow, incoherent overlap, or focusable closed navigation and ends `PASS` with no unresolved P0/P1/P2. These temporary-loopback tests do not replace remote platform or real-home L3 release evidence.

`npm run lint` recursively checks `.mjs` and `.js` files under `bin`, `src`, `scripts`, and `ui`, skipping source roots that have not landed. On Node 22.19, the Task 2 focused suite passes 15/15 tests. Its coverage verifies OpenAI provider creation and update, custom-provider and CRLF preservation, byte idempotency, one-time adjacent backup, exclusive same-timestamp backup collision handling, CRP lock contention, external source-change rejection, atomic mode-preserving replacement, deterministic rename-failure cleanup and original preservation, all nine injected-home paths, safe public error serialization, `start`/`install`/`setup` JSON and managed-state backup propagation, and accurate guide backup semantics.

The Node 22.19 Task 3 focused suite passes 23/23 tests. The Task 4 credential suite passes 41/41, the combined credential/provider suite passes 64/64, and the current full suite passes 91/91; `npm run lint` syntax-checks 14 source files. Task 4 coverage includes the shared async adapter contract, lazy native-loader failure, trusted injected private-file selection, no operation replay for native get/set/has/delete outages, explicit file-label restart continuity without migration, exact schema and string persistence, reload and refreshed reads, no enumeration API, two-instance lost-update prevention, strict parent/file modes, POSIX no-follow and simulated-Windows descriptor identity, symlink-swap rejection before byte reads, fsync/rename order, rollback cleanup, bounded secret-temp cleanup and permanent uncommitted degradation, gate-covered atomic lock claims, preexisting foreign-gate preservation, claim-before-delete gate release under an immediate foreign replacement, canonical blocker restoration, synchronous second-instance rejection during gate claim validation, normal claim cleanup and subsequent mutation, fresh-instance busy behavior, permanent committed lock degradation, input validation, and public provider masking. The public Supervisor requires native storage and exposes no file selector. Tests never invoke the default native loader or construct or query a real native credential entry. Real native-backend verification remains L3 on every supported system, including Windows and Linux; private file permission and rename semantics on Windows and Linux also remain unverified.

The Node 22.19 Task 5 focused suite passes 13/13 and the current full suite passes 102/102; `npm run lint` syntax-checks 15 source files. Coverage verifies generation validation and failure atomicity, deep clone/freeze behavior, public allowlisting, exactly one request-start snapshot capture, delayed A versus immediate B switching, a transport-option spy for TLS pinning before body arrival, pinned authentication, headers, timeout, capture context and request IDs, static compatibility, unconfigured-source rejection, dynamic health secret scans, request/response short and custom authentication debug masking, and bidirectional custom-auth capture redaction.

The Node 22.19 Task 6 focused suite passes 21/21, `npm run test:integration` passes 11/11, and `npm test` passes 112/112 top-level tests followed by 11/11 integration tests without duplication; `npm run lint` syntax-checks 18 source files. Coverage verifies exact directional schemas, HTTPS-or-loopback URL enforcement, HTTP-token authentication fields, Node-compatible final authentication values, sensitive and authentication-conflicting header rejection, secret sanitization, fixed invalid-message fatal IDs, and real child-process ready/configure/reconfigure/proxy/status/drain/shutdown flows. Synchronized tests prove configure is rejected after drain begins without replacing generation or losing its acknowledgement, duplicate drain requests keep both acknowledgements and later status drained, and parent disconnect terminates within a deadline despite a hanging upstream both before and after shutdown starts waiting. Invalid authentication values, configuration, stale generation, occupied-port startup, port release, request settlement, stderr/stdout scans, and deterministic deadline-driven cleanup remain covered.

The Node 22.19 Task 7 strict-unhandled focused suite passes 22/22. Exact `npm test` passes 126/126 non-capture unit assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run test:unit` passes all 133/133 top-level assertions; `npm run lint` syntax-checks 19 source files. Coverage verifies ready/configure/health startup, strict request correlation, acknowledgement-atomic generation changes, concurrent restart Promise identity and zero snapshot inspection before shared-operation reuse, restart prevalidation without drain side effects when no operation exists, send-failure waiter cancellation without unhandled rejections, early acknowledgement retention, graceful drain/shutdown, TERM/KILL escalation, retained retryable control after termination timeout, partial-start error preservation, fixed-port cleanup, same-port real-worker PID replacement, sanitized fatal and malformed messages, old-epoch isolation, cancellable injected-clock crash recovery, immediate failure on the fifth crash in 60 seconds, and idempotent close with no child, timer, listener, process, or port residue. The fifth in-window crash does not schedule the 4000 ms capped delay; only the first four 250/500/1000/2000 ms delays execute before the threshold.

The Node 22.19 Task 9 focused suite passes 42/42. Exact `npm test` passes 179/179 core assertions, 7/7 isolated capture assertions, and 23/23 integration assertions; `npm run lint` syntax-checks 26 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage verifies private descriptor-validated control tokens, browser expiry and CSRF, exact Host/Origin/CORS rejection, bounded exact JSON and empty-body contracts, every approved route, safe activity pagination, read-only settings, positive response/error/diagnostic projections, static asset allowlisting, active-only lifecycle credentials with in-flight command reuse, supervisor migration-before-registry composition, readiness-gated `0600` state, construction/listen rollback, independent Codex/state adapters, and idempotent signal cleanup. All new integration boundaries use temporary homes, injected stores/services, and loopback HTTP; real HOME, native keyring, external provider traffic, and actual UI assets remain outside this deterministic gate.

The Node 22.19 Task 8 focused suite passes 42/42. Exact `npm test` passes 168/168 core assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run lint` syntax-checks 22 source files. Coverage verifies the expanded activity denylist and full-file secret scans, Error/cycle/non-JSON handling, retention, atomic failure preservation, foreign lock replacement, and canonical degraded blocking; descriptor-safe temp-only migration, symlink rejection, byte-exact backups, exclusive final-path registry creation, identity/byte-owned rollback, foreign registry preservation, transaction locks, committed schema reconciliation, and canonical release blockers; active-update rejection, no-follow redirect behavior across two loopback origins, CRUD/credential committed outcomes, replacement rollback safety, selected credentials, explicit serialization, and deterministic `1 -> 2 -> 3` rollback after health or acknowledgement uncertainty. No test accesses a real HOME, native credential backend, or live upstream network.

The Node 22.19 Task 10 focused suite passes 27/27. Exact `npm test` passes 202/202 core assertions, 7/7 isolated capture assertions, and 24/24 integration assertions; `npm run lint` syntax-checks 27 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage verifies private state discovery, authenticated CLI dispatch for lifecycle and provider commands, browser-session discovery for `ui`, explicit legacy secret-bearing flag rejection, startup readiness and owner cleanup, `pid` plus `startedAt` shutdown identity, and bounded failed-spawn cleanup without child or state residue. `git diff --check` and the static secret-pattern scan pass. Tests use temporary homes and injected spawn/client boundaries; real HOME, native keyrings, external provider traffic, browser launch behavior, and cross-platform process identity and signal handling remain L3.

The 2026-07-14 Task 11 gate uses Playwright 1.61.1 and Chrome for Testing 149.0.7827.55. `npm run test:e2e -- --project=chromium --workers=1` passes 40/40, the focused session/Admin regression passes 16/16, exact `npm test` passes 202/202 core plus 7/7 isolated capture plus 24/24 integration assertions (233 total), `npm run lint` syntax-checks 28 source files, and `npm audit --omit=dev` reports zero vulnerabilities. Coverage verifies complete `en`/`zh-CN` dictionary parity and locale precedence, only explicit `crp.locale` persistence, onboarding, provider CRUD/test/activation and production invalidation rules, production activity values (`proxy`, `start`/`stop`/`restart`, and `failed`/`degraded`), validated mock-upstream HTTP/auth/Responses contracts, lifecycle confirmation, degraded/committed errors, read-only Settings, GET-only valid-cookie re-entry without a fragment, terminal exchange/session/CSRF failures, keyboard/focus semantics, fixture failure cleanup, and 390x844 automatic layout. Full-secret collectors await and scan console/page errors, request and response bodies, activity, diagnostics, DOM/input values, URL/history, local/session storage, IndexedDB, attachments, and screenshot bytes after the visible DOM scan. Requirements review and the subsequent quality/security/accessibility reviews ended `APPROVED` with no unresolved finding.

The 2026-07-17 V8.1 gate passes 37/37 focused session/Admin tests, 414/414 unit-core, 8/8 isolated Capture, 43/43 ordinary integration, and 39/39 Chromium E2E. UI typecheck/build/exact-output, lint across 33 source files, package-content 3/3, runtime audit with zero vulnerabilities, diff checks, desktop/mobile screenshots under `output/playwright/v81/`, and independent security/React/test reviews pass. The single serial core-chain test did not start because the user's existing CRP Worker held fixed port `127.0.0.1:15100`; no process was stopped or signalled, so this is an explicit remaining environment gate rather than passing evidence.

The 2026-07-17 Setup alignment patch passes the focused 1/1 Chromium model-catalog test with an explicit bounding-box assertion that the refresh button and model control share the same top coordinate. The synchronized three-file UI build, UI typecheck, and exact-output verification pass; sanitized visual evidence is `output/playwright/v81/setup-model-alignment-fixed.png`.

The 2026-07-14 Task 12 package/platform gate at `af918d5` passes the 21/21 focused package/native/workflow suite, exact 30-file package dry run, `actionlint`, and workflow policy checks. Safety commit `210cb71` then passes 67/67 post-security focused tests, 41/41 Chromium E2E, exact `npm test` with 227/227 core plus 7/7 isolated capture plus 24/24 integration assertions (258 total), `npm run lint` across 29 source files, `npm audit --omit=dev` with zero vulnerabilities, and diff checks. Coverage adds strict `init` alias rejection before discovery/writes, native-only public credential boundaries, rejected fallback fields, active-provider edit/delete blocking, metadata-only diagnostics, and secret-negative assertion ordering.

The earlier Task 12 documentation tree records: `npm run lint` checks 29 source files; `npm test` passes 258/258 (`227` core + `7` isolated capture + `24` integration); `npm run test:integration` passes 24/24; Chromium E2E passes 41/41; `npm audit --omit=dev` reports zero vulnerabilities; package-content passes 3/3 against the exact 30-file allowlist; Changeset status since `origin/main` is minor; and the cached diff check is clean. The workflow matrix is implemented but remote macOS/Windows/Linux run URLs do not yet exist in this review record. Remote platform native services, Windows screenshots, real-home migration/rollback, and cross-platform process/filesystem behavior remain pending L3 evidence. That earlier Task 12 local gate used no real provider credential or external upstream; the later D2 evidence is recorded separately below.

The host-locale/capture-corrected core-first tree superseded the earlier full-suite counts without changing Web files. Under a Chinese `LC_ALL`/`LANG`, `npm test` passed 296/296 as four serial groups: `unit-core` 262, isolated capture 8, ordinary integration 25, and `core-chain` 1. `npm run lint` syntax-checked 29 source files. The three host-sensitive CLI assertions passed 3/3 after their helper explicitly selected English, while production locale precedence remained unchanged. Capture focus passed 8/8 after replacing the first asynchronous stat baseline with a synchronous SHA-256 content fingerprint, an unconditional startup reload, and 500 ms reconciliation; `start` remains idempotent, `close` clears interval/debounce/fingerprint state, and a startup-rewrite regression covers the former race. A directed review set passed 58/58, two capture suites passed 20 concurrent repetitions, and independent review reported `PASS` with zero findings. D1 runs `runCli -> SupervisorClient -> Admin -> registry/provider service -> WorkerManager -> real forked worker -> loopback upstreams`; it covers clean-home bootstrap, provider add/list/test/activate, actual Responses forwarding, A/B switching while A remains in flight, same-port restart with a new PID, status, stop, shutdown, secret scans, and process/state/port/temporary-root cleanup. Only credentials and upstreams are substituted, so this is deterministic composition evidence rather than native/external evidence. Added unit coverage proves a 2-second discovery probe returns a client with a separate 30-second operation timeout and proves structured proxy URL joining for root, `/v1`, trailing-slash, encoded-path, and combined-query cases.

The preceding detached-startup repair tree's focused command passes 69/69 and proves exact static error projection, asynchronous IPC send-before-disconnect ordering, close-before-message delivery, malformed/unknown fallback, late-error guarding, successful discovery cleanup, and divergent legacy credentials with no backup creation, credential-store access, registry mutation, or source mutation while recording only a sanitized Activity outcome. Its exact `npm test` passes 304/304 (`268` unit-core + `8` isolated capture + `27` ordinary integration + `1` serial core-chain), and package-content matches the exact reviewed 30-file allowlist. These remain historical repair/package facts, not the current V5 aggregate evidence.

Historical V5 evidence: the CLI human-output/help focus passed 24/24 on Node 22, exact `npm test` passed 313/313 (`277` unit-core + `8` capture + `27` integration + `1` core-chain), lint checked 29 source files, audit reported zero vulnerabilities, and independent review reported `PASS`. That tree covered the then-current compatibility-alias help/copy; V6 intentionally supersedes only those current contracts.

Historical M2D/V7 exact `npm test` passed 451/451 (`401` unit-core + `8` isolated capture + `41` ordinary integration + `1` serial core-chain). History/config 98/98 and strict status/lifecycle 105/105 focuses also passed. Lint checked 31 source files, package-content passed 3/3 against the exact 32-file allowlist, runtime audit reported zero vulnerabilities, `git diff --check` passed, and request-order-only Chromium regression passed 41/41. Coverage included URL-only repair decisions; the shared selected-binding scanner; invalid UTF-8 and ambiguity rejection; exact rollout and SQLite logical snapshots; fixed pending/clearing markers; crash resume; final config/hash/lock checks; rollout metadata and parent-directory durability; canonical SQLite/sidecar hardlink and symlink rejection; both committed-degraded classes; FIFO readiness for activation/start/restart/automatic recovery; recovery cancellation; and the bounded bootstrap-only timeout. Both fixed ports were free after the gates. Tests used temporary roots and synthetic state and did not touch real Codex history, credentials, or an external provider. Final independent L3 review returned `PASS` with no unresolved P0/P1/P2.

The V8.1 local evidence recorded before the license addition passes exact `npm test` 466/466 (`414` unit-core + `8` isolated Capture + `43` ordinary integration + `1` serial core-chain), Chromium 39/39, syntax 33, UI typecheck/build/exact-output, package/release tests 21/21 against the then-current exact 33-file package, installed-tarball CLI smoke, and both full and runtime-only audits with zero vulnerabilities. These remain temporary-root, synthetic-credential, and loopback results rather than copied-real-history or remote platform release evidence.

Current release-preparation coverage additionally verifies that process locale variables never change default CLI human output, validation errors remain English without an explicit locale, a Chinese-preferring browser starts the Web UI in English, and an explicit Chinese Web selection persists across reload. The exact current package allowlist is 34 files, including the shipped MIT License.

The current rerun passes CLI/i18n 30/30, Chromium 39/39, UI typecheck/build/exact-output, lint, runtime audit, package/release tests 21/21, the 34-file package dry run, and exact `npm test` 467/467 (`415` unit-core + `8` Capture + `43` ordinary integration + `1` serial core chain) after both fixed ports were released.

Final manual D2 evidence uses real CLI processes, the production native-keyring adapter and login Keychain, a real Dusapi upstream, and a detached Supervisor. CRP paths and `CRP_HOME` are isolated while the real `HOME` remains available to Keychain. Provider test succeeds, activate/start succeed, the real proxy `/responses` request returns HTTP `200 OK`, health succeeds, restart preserves the Supervisor PID and replaces the worker PID, and stop/shutdown plus process/state/port/temporary-state cleanup succeed. A separate isolated clean-home detached run proves private `.codex`/`config.toml` creation, fixed `OpenAI`/`15100`, and bootstrap behavior. D2 passes the local core gate; it is not remote or cross-platform release evidence.

`npm run test:unit` retains its public behavior and runs all top-level `test/*.test.mjs` files. The exact `npm test` gate runs without duplication as four sequential groups: every non-capture top-level unit file, `capture-store.test.mjs` alone, recursively discovered ordinary integration tests excluding `core-real-chain.test.mjs`, then that fixed-port core chain alone. This isolates polling watcher registration and fixed-port process composition from unrelated load. `test:e2e` is a required UI gate; Task 12 combines the final-tree gate with cross-platform release evidence.

## Historical Task 11 Visual Evidence

The Task 11 suite explicitly writes sanitized English and Simplified Chinese Overview images at 1440x900 after clearing launch-token and credential state:

- `output/playwright/task11/onboarding-onboards-in-Eng-57b0b-ce-and-finishes-on-Overview-chromium/overview-en.png`
- `output/playwright/task11/onboarding-onboards-in-Eng-57b0b-ce-and-finishes-on-Overview-chromium/overview-zh-CN.png`

These files are local review attachments under untracked `output/`, not source inputs and not part of the exact eight-file Task 11 commit. Do not stage or relocate them during release closeout. Automatic screenshots, traces, video, and failure artifacts remain disabled. The repository-retained evidence is the accepted visual contract and deterministic test that regenerates the images. Task 12 remote macOS and Windows jobs must attach fresh sanitized screenshots to the L3 review record; those artifact URLs are still pending, and no current rule requires committing PNGs to Git.

## Test Authoring Rules

- File-watcher tests must wait for observable state and register cleanup before assertions.
- CLI human-output tests must set an explicit locale instead of inheriting the developer environment.
- File reconciliation must establish its content baseline synchronously before periodic asynchronous checks begin.
- Configuration persistence tests must verify no-op writes, exclusive backup collisions, lock cleanup, external source changes, and source permission preservation.
- Codex binding inspection and patch tests must share one semantic statement scanner and cover supported quoted/dotted/multiline/collection forms, invalid UTF-8, duplicate or ambiguous selected bindings, and explicit non-claims about whole-document TOML validation.
- History-repair tests must prove the URL-only trigger, no scan on first creation or same effective URL, config-only operation for an empty write set, and zero CRP-provider-switch coupling.
- Journal cleanup tests must cover `pending.json -> pending.json.clearing -> removed`, dual-marker conflict, clearing-only resume, marker reconstruction after delete durability failure, and retained config lock when no marker can be restored.
- History backup tests must prove byte-exact rollout backup reuse, exclusive SQLite logical snapshot publication, partial-temp cleanup, destination races, symlink/hardlink rejection for canonical SQLite and sidecars, and no mutation of an unbacked resource.
- Rollout replacement tests must prove mode/atime/mtime plus file durability before rename and final fsync of every affected parent directory.
- Committed-state tests must distinguish config-only `{ pending: false }` from journaled history `{ pending: true }`, recheck target config hash and lock ownership before writes and clear, and scan every public projection for private paths, IDs, values, and credentials.
- Activation, start, restart, and unexpected-exit recovery tests must share the FIFO Codex gate; blocked automatic recovery must honor stop/close cancellation generations and expose neither readiness causes nor snapshots.
- Registry mutation must persist successfully before replacing in-memory state.
- Registry mutations must reload while holding the registry lock before replacing state.
- Initial-provider compare-and-set tests must prove exactly one winner, a stopped Worker prerequisite, no Worker start/reconfiguration, no-op CAS without registry rewrite, ownership-proven rollback after activation Activity failure, and no selection after committed-degraded test Activity failure.
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
- Provider-service compensation tests must fail before implementation and cover create, credential replacement, delete, active-delete ordering, stable test classifications, selected credentials, explicit concurrency serialization, committed-degraded test/model Activity outcomes, and activation rollback.
- Provider-model cache tests must cover exact schema 1, 512-entry and 16 MiB document bounds, bounded IDs/catalogs, source-fingerprint invalidation, fresh/stale/missing projections, private atomic persistence, busy/foreign/degraded locks, committed cleanup, delete, and last-good preservation without ever storing a credential.
- Model-discovery tests must bound response bytes, reject redirects/auth/HTTP/invalid JSON/invalid lists, reject any model ID containing the complete selected credential before persistence or projection, prove only selected credentials and safe headers are sent, and prove provider test/activation/Worker state remains unchanged.
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
- Detached Supervisor startup tests must race only exact allowlisted child errors against readiness, retain a late-error guard, and prove asynchronous send completion precedes disconnect.
- Divergent legacy-credential tests must prove no backup creation, credential-store access, registry mutation, or source mutation plus a secret-free stable Activity code before comparing expected errors.

## Test Matrix

| Area | Required Tests |
| --- | --- |
| Provider registry, model cache, and migration | Registry validation, duplicate names, strict schema rejection, first-wins active-ID compare-and-set, atomic persistence, and rollback; independent cache schema/bounds/fingerprint/TTL/private persistence/degraded locks; migration descriptor-safe legacy reads, byte-exact backups, schema-2 idempotency, reverse rollback, foreign replacements, committed/rollback degradation, and divergent credentials rejected as `MIGRATION_INPUT_INVALID` before backup creation, credential-store access, registry mutation, or source mutation while recording only a sanitized Activity outcome |
| Credentials | Required public native adapter, trusted-injection-only private file adapter, masking, deletion, log redaction |
| Worker protocol | Version mismatch, acknowledgement, stale generation rejection, crash handling |
| Proxy behavior | Auth rewrite, HTTP/SSE, compression, timeout, disconnect, optional model override |
| Activation | Failed test rejection, CLI opt-in first-success selection with stopped Worker and no implicit start, concurrent first-wins CAS, strict Codex readiness gate, atomic explicit new-request switch, in-flight old snapshot |
| Restart and automatic recovery | Codex FIFO readiness, blocked-gate stop/close cancellation, bounded secret-free backoff, drain timeout, SIGTERM escalation, port release, same-port spawn, and health failure |
| Codex bootstrap | Missing private parent/file creation with no backup, repeat byte idempotency, existing-file backup/mode preservation, no-follow identity/race rejection, selected-binding scanner/UTF-8 validation, stable OpenAI provider/fixed URL, and both committed-degraded classes |
| Codex history repair | URL-only trigger, exact write-set discovery, rollout and SQLite logical snapshots, fixed pending/clearing markers, crash resume from source/target hash, config/lock final checks, metadata and directory durability, encrypted-content preservation, hardlink/symlink rejection, bounded public summaries, and zero-write conflicts |
| Admin API | Auth/session, explicit exact-origin cookie-session recovery with raw-target/custom-header/body/method rejection and absolute-expiry-preserving rotation, CSRF, Host/Origin rejection, error contracts, secret write-only behavior, additive model cache/refresh routes, optional `activateIfNone` default false, bounded Metrics query/projection, and positive projections |
| Anonymous Metrics | Strict Worker observation, first non-empty response-body response-start timing, generation-to-Provider attribution, fixed histograms, UTC hourly retention, 32 MiB maximum-cardinality persistence, corrupt/write degradation, Capture independence, and secret/per-request-field absence |
| CLI human adapter | Locale-explicit safe provider summaries/model catalogs and empty states; detailed Supervisor/Worker/active-provider/Codex status; terminal-safe values; ID XOR name selectors with per-ID snapshot revalidation; create-then-test retention and committed-degraded metadata; explicit test pass/failure codes; English-default root/group/action help and current guide without discovery; stop/shutdown wording; removed-alias migration errors; stable JSON/Admin dispatch |
| Core composition | Real CLI/Admin/registry/provider/WorkerManager/forked-worker path, A/B in-flight switching, same-port restart, stable JSON, secret scans, and exact cleanup |
| Native/upstream D2 | Locally passed on macOS: real detached Supervisor, production native Keychain retrieval, real Dusapi provider test and Responses request, fixed Codex config, redacted evidence, PID transition, and process/state/port cleanup; remote/cross-platform proof remains a release gate |
| UI E2E | Save → complete model select/manual fallback → test+CAS select → Codex bootstrap/history repair → start first-run flow; sidebar and card Provider switching including stopped-Worker start semantics; Provider duplication without secret/state copying; fixed feedback without reflow; explicit read-only recovery; Metrics windows/states; Activity/System; disabled Forwarding Records; terminal security; restart/errors; keyboard, accessibility, and responsive overflow scan |
| Cross-platform | Remote macOS and Windows UI artifacts; real native backend on macOS, Windows, and Linux; Linux CLI regression; workflow run URLs retained |

The existing migration suite uses injected temporary paths and adapters. Migration and rollback against a real home, native credential service, and platform filesystem remain pending L3 confirmation.

## First Vertical Slice Acceptance

1. Start from an isolated temporary home directory.
2. Launch `crp ui` without a saved provider.
3. Create and test two mock providers through the browser.
4. Test provider A with `activateIfNone: true`, prove CAS selection left the Worker stopped, bootstrap the fixed Codex binding/history repair, start the Worker, and complete a proxied request.
5. Keep a request in flight while activating provider B; verify old/new snapshot behavior.
6. Verify the Codex provider key remains `OpenAI` and the proxy URL remains fixed.
7. Restart the worker from the UI and verify supervisor availability and same-port recovery.
8. Confirm API responses, logs, activity, capture headers, and diagnostics contain no complete key.
9. Capture approved desktop and 390x844 local comparisons, then retain macOS and Windows platform screenshots for Task 12 and run accessibility checks.

## Verification Gate

Credential, config/history migration, lifecycle, browser-security, exact package, release-policy, and platform workflow tests must all pass before L3 expert release review. M2E/V8 additionally requires UI typecheck/build/exact-output verification, Metrics focus, the exact 34-file package, complete Chromium E2E, responsive/accessibility checks, and same-state visual comparison. Detached lifecycle alone, native entry metadata alone, workflow definitions, historical V7 41/41, or partial V8 browser results remain insufficient; historical local D2 does not replace real-home history performance/recovery or remote macOS/Windows/Linux native-service, filesystem/ACL, visual, migration, and human evidence.

Tasks 2 and 3 do not remove the L3 requirement, and atomic rename and permission behavior remain unverified on real Windows and Linux hosts.
