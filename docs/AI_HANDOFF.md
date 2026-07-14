# AI Handoff

## Product Summary

CRP preserves ChatGPT login/remote features while routing Codex model traffic to a selected OpenAI-compatible upstream. Named providers, lifecycle management, the local Admin API, and a bilingual Web UI are implemented; the active milestone now proves the CLI/core path before further Web refinement.

## Current Scope

Tasks 1 through 11 are implemented and documented in `d114061` and `dd4de3f`. Task 12 package/platform gates are `af918d5`; safety commit `210cb71` removes public fallback inputs, makes `init` a strict `ui` alias, and aligns diagnostic summary behavior; `5fecf45` closes the release-documentation preparation. On 2026-07-14 the user paused Web and release work and approved the core-first design in `docs/superpowers/specs/2026-07-14-crp-core-first-cli-design.md`; the executable TDD plan is `docs/superpowers/plans/2026-07-14-crp-core-first-cli-implementation.md`. Its implementation and evidence are pending. Task 12 remains parked, not complete.

Do not describe workflow definitions as platform results. Remote macOS/Windows/Linux run URLs, real Keychain/Credential Manager/Secret Service evidence, macOS/Windows screenshots, real-home migration/rollback, and expert approval are still pending.

## Architecture

Implemented: shared paths, safe public errors, idempotent Codex bootstrap, strict provider storage, secure credential adapters, immutable request snapshots, strict worker IPC, reliable worker management, bounded sanitized activity, transactional v0.2.2 migration, serialized provider orchestration, private local sessions, the exact Admin route/security boundary, readiness-gated supervisor composition, state-discovered CLI dispatch through the Admin API, and the packaged three-file bilingual Web UI. Codex remains on `model_provider = "OpenAI"` and fixed `http://127.0.0.1:15100`; supervisor Admin API defaults to `127.0.0.1:15101`.

Approved but not implemented: bootstrap must privately and atomically create a missing `.codex/config.toml`; all human CLI output must support `en` and `zh-CN`; JSON failures and start phases must be stable; a production-component integration gate and a separately authorized real provider/native-keyring smoke must pass. No aggregate setup endpoint, API version, registry schema, fixed address, provider identity, or Web contract changes are approved.

## Data and API

- Non-secret profiles now live in the implemented schema-versioned registry.
- Public Supervisor startup requires the landed native adapter. UI, CLI, and Admin expose no file-backend selector; the lower-level private file adapter is trusted-injection only pending a future L3 startup-consent design.
- Local API contract is in `docs/API.md`; data contract is in `docs/DATA_MODEL.md`.

## Permissions

One authenticated local OS user. Admin API is loopback-only, origin/host checked, CSRF protected, and never returns full keys. See `docs/PERMISSIONS.md`.

## Current Progress

Architecture, provider model, core flows, UI direction, errors, testing, and MVP boundary were visually reviewed and approved on 2026-07-10. The user approved the Task 11 Overview visual and required complete English/Simplified Chinese UI coverage on 2026-07-13. On 2026-07-14 the implementation and deterministic acceptance completed: locale precedence is stored `crp.locale` then supported `navigator.languages` then English; only explicit selection persists; Settings is read-only; a valid cookie without a fragment opens a GET-only workspace; any failed session exchange and later session/CSRF authentication failure are terminal. Requirements and code-quality/security/accessibility reviews ended `APPROVED` after fixes, with no unresolved finding.

Latest code evidence at `210cb71` is 258/258 full tests (`227` core + `7` capture + `24` integration), 67/67 post-security focused tests, 41/41 E2E, 29 syntax-checked source files, and zero runtime vulnerabilities. The `af918d5` package gate separately proves the exact reviewed 30-file tarball and workflow policy. Final-tree local verification also passes lint 29, `npm test` 258/258 (`227` core + `7` capture + `24` integration), integration 24/24, Chromium E2E 41/41, audit 0, package-content 3/3 against the exact 30-file allowlist, minor Changeset status since `origin/main`, and a clean cached diff check. Human L3 and external review evidence remain pending.

The evidence above predates the approved core-first implementation. Do not claim clean-home creation, CLI localization/staged JSON errors, a full production-component chain, or a real provider/native-keyring core pass until new results are recorded.

## How To Run Current Code

```bash
cd node
npm ci
npm run lint
npm test
npm run test:unit
npm run test:e2e -- --project=chromium --workers=1
node --test test/package-content.test.mjs test/native-keyring-smoke.test.mjs test/release-workflows.test.mjs
npm pack --dry-run --json --ignore-scripts
npm run changeset -- status
node bin/crp.mjs --help
```

Do not run `crp start` against a real home directory during tests because it modifies Codex configuration.

## Verification

- Node 22.19 baseline and Task 1 gate: `npm test` passes 12/12 tests and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 22.19 Task 2 gate: `node --test test/codex-config.test.mjs` passes 15/15, including deterministic rename failure, exclusive same-timestamp backup collision, busy lock, external source change, CRLF preservation, guide semantics, and all three start aliases; `npm test` passes 27/27, `npm run lint` syntax-checks 9 source files, and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 22.19 Task 3 gate: `node --test test/provider-registry.test.mjs` passes 23/23, including multi-instance lock serialization, strict schema and header validation, test-state invalidation, primary-error preservation, degraded lock cleanup, refreshed defensive copies, and public allowlisting; `npm test` passes 50/50, `npm run lint` syntax-checks 11 source files, and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 22.19 Task 4 gate: `node --test test/credential-store.test.mjs` passes 41/41, the combined credential/provider focus passes 64/64, `npm test` passes 91/91, and `npm run lint` syntax-checks 14 source files. Coverage includes trusted injected private-file selection without operation replay, explicit file-label restart continuity, descriptor identity, strict parent/file modes, degraded temp cleanup, canonical lock restoration, claim-before-delete gate release, foreign replacement preservation, and synchronous second-instance blocking while a gate claim is validated. The public Supervisor requires native storage; native tests inject the loader and never invoke the real addon loader or touch the OS credential store, so real native verification remains L3 on every supported system, including Windows and Linux.
- Node 22.19 Task 5 gate: `node --test test/runtime-settings.test.mjs test/server.test.mjs` passes 13/13, `npm test` passes 102/102, and `npm run lint` syntax-checks 15 source files. Coverage includes strict generations, clone-before-freeze replacement, public-state allowlisting, one snapshot read per request before body listeners, delayed A versus immediate B switching, transport/TLS and timeout pinning, unconfigured-source rejection, health secret scans, request/response dynamic auth-header log masking, and bidirectional custom-auth capture redaction.
- Node 22.19 Task 6 gate: `node --test test/worker-protocol.test.mjs test/integration/worker-entry.test.mjs` passes 21/21, `npm run test:integration` passes 11/11, and `npm test` passes a nonduplicated 112/112 top-level group followed by 11/11 integration tests; `npm run lint` syntax-checks 18 source files. Coverage includes exact version-1 directional schemas, HTTPS-or-loopback upstreams, HTTP-token authentication fields, final authentication-value validation, sensitive and conflicting header rejection, parent-only configure secrets, fixed invalid-message fatal IDs, configure-before-listen, monotonic reconfiguration, configure rejection after drain begins, retained in-flight drain acknowledgement, idempotent duplicate drain, health/status, idle keep-alive closure, clean shutdown, bounded parent-disconnect cleanup with a hanging upstream before or during shutdown, safe startup failures, stale generations, port conflicts, port release, and child-process cleanup without fixed sleeps. Real-fork integration runs after the ordinary group so it cannot race watcher readiness in another test process.
- Node 22.19 Task 7 gate: strict-unhandled `node --test test/worker-manager.test.mjs test/integration/worker-restart.test.mjs` passes 22/22; exact `npm test` passes 126/126 non-capture unit assertions, 7/7 isolated capture assertions, and 12/12 integration tests without duplication; `npm run test:unit` retains all-top-level coverage and passes 133/133. `npm run lint` syntax-checks 19 source files, and `npm audit --omit=dev` reports zero vulnerabilities. Coverage includes ready/configure/health startup, acknowledgement-atomic snapshot application, concurrent restart reuse before inspecting its snapshot, restart prevalidation before drain when no operation exists, immediate waiter observation and send-failure cancellation, graceful drain/shutdown, TERM/KILL escalation, retained child control after termination timeout, same-port real-worker restart with a changed PID, partial-start and port-release cleanup, correlated fatal and malformed-message sanitization, old-epoch isolation, cancellable injected-clock crash backoff, immediate failure on the fifth crash in 60 seconds, and idempotent retryable close without child, timer, listener, or port residue. The exact runner isolates the preexisting polling capture watcher between the core unit and real-fork integration groups so its registration baseline cannot race unrelated unit load.
- Node 22.19 Task 8 gate: `node --test test/activity-store.test.mjs test/migration.test.mjs test/provider-service.test.mjs` passes 42/42; exact `npm test` passes 168/168 core assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run lint` syntax-checks 22 source files. Tests use only temporary paths, injected credential adapters/fetch responses, fake worker boundaries, and loopback redirect servers. Coverage includes recursive lifecycle-field redaction, ownership-checked activity locks, descriptor-safe migration paths, exclusive final-path registry creation, symlink and foreign-replacement preservation, committed-state reconciliation, redirect refusal, active-update rejection, replacement-secret compensation, selected credentials, explicit operation serialization, and conservative activation rollback `1 -> 2 -> 3` after health or lost-ACK uncertainty. Real HOME migration, native keyrings, cross-platform filesystem semantics, and live upstreams remain prohibited until L3 platform review.
- Node 22.19 Task 9 gate: `node --test test/session-auth.test.mjs test/provider-service.test.mjs test/integration/admin-server.test.mjs` passes 42/42; exact `npm test` passes 179/179 core assertions, 7/7 isolated capture assertions, and 23/23 integration tests; `npm run lint` syntax-checks 26 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage includes descriptor-safe private control tokens, expiring browser sessions/CSRF, exact Host/Origin/CORS rules, bounded request schemas, every Admin route, response/error secret scans, static allowlisting without actual UI files, active-only lifecycle credentials with in-flight command reuse, migration-before-registry composition, readiness-gated private state, startup compensation, separate Codex/state adapters, and signal cleanup. Real HOME, native keyring, external provider traffic, actual UI assets, and cross-platform browser behavior remain prohibited until their later gates.
- Node 22.19 Task 10 gate: `node --test test/crp.test.mjs test/integration/crp-lifecycle.test.mjs` passes 27/27; exact `npm test` passes 202/202 core assertions, 7/7 isolated capture assertions, and 24/24 integration assertions; `npm run lint` syntax-checks 27 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage includes state discovery, authenticated lifecycle and provider dispatch, `ui` browser-session discovery, legacy secret-bearing flag rejection, owner-identity-checked shutdown, startup waiting, and failed-spawn cleanup without process or state residue. `git diff --check` and the static secret-pattern scan pass. Tests use temporary homes and injected spawn/client boundaries; real HOME, native keyrings, external provider traffic, browser launch behavior, and cross-platform process identity and signal handling remain L3.
- Task 11 gate on Chrome for Testing 149.0.7827.55 with Playwright 1.61.1: `npm run test:e2e -- --project=chromium --workers=1` passes 40/40; `node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs` passes 16/16; exact `npm test` passes 202/202 core, 7/7 isolated capture, and 24/24 integration assertions, 233 total; `npm run lint` syntax-checks 28 source files; `npm audit --omit=dev` reports zero vulnerabilities. Browser coverage includes both locales, locale/storage rules, onboarding, provider CRUD/test/activation, real activity enums, lifecycle, degraded errors, GET-only re-entry, terminal session/CSRF failure, semantic keyboard/focus behavior, 1440x900 visual evidence, 390x844 automatic layout, fixture cleanup, and deep scans across browser/network/state/diagnostic surfaces. The exact eight-file result is committed as `d114061`; explicit sanitized screenshots remain under `output/playwright/task11/` for local review and were not committed.
- Task 12 package/platform gate at `af918d5`: the three focused package/native/workflow tests pass 21/21 and `npm pack --dry-run --json --ignore-scripts` matches the exact reviewed 30-file allowlist; `actionlint` and workflow policy checks pass. Safety commit `210cb71` then passes 67/67 post-security focused tests, 41/41 E2E, exact 227/227 core plus 7/7 isolated capture plus 24/24 integration assertions (258 total), syntax checking across 29 source files, and zero runtime vulnerabilities. This documentation commit records final local evidence: lint 29, `npm test` 258/258, integration 24/24, Chromium E2E 41/41, audit 0, package-content 3/3 against the exact 30-file allowlist, minor Changeset status since `origin/main`, and a clean cached diff check. These are local results, not remote-platform evidence.
- Node 24.2 stability: `node --test test/capture-store.test.mjs` passes 7/7 without hanging after replacing fixed watcher sleeps with bounded condition waits and pre-assertion cleanup.
- Pending V1 release gate: remote platform/native/visual evidence, real-home migration/rollback evidence, and human L3 approval in `docs/TESTING.md`; pull request, push, merge, versioning, publication, and release also remain pending.

## Known Risks

Credential migration on a real home, real localhost browser launch/security, native credential backends, live upstream behavior, cross-platform worker signal/port-release semantics, cross-platform atomic rename/permission semantics, and macOS/Windows visual behavior remain L3 release gates. Push, pull request, merge, versioning, and publishing have not occurred.

The current `provider add --api-key <KEY>` interface remains an explicitly deferred argv/history exposure. The deterministic core-chain test may inject credentials and loopback upstreams, but only the separately authorized live smoke may satisfy real provider/native-keyring core evidence.

## Recent Decisions

- Use harness-builder `iterate` mode.
- Prioritize core CLI completion over further Web refinement; keep Web and Task 12 release execution parked until the core-first gate is complete.
- Keep existing Admin routes and schema; do not add an aggregate setup endpoint.
- Create a missing Codex config privately and atomically with no backup, while preserving backup/mode/idempotency behavior for existing files.
- Support human CLI output in `en` and `zh-CN`; keep JSON keys, codes, enums, messages, and actions stable English contracts.
- Require both deterministic production-component composition and a separately authorized real provider/native-keyring smoke before claiming core completion.
- Retain `provider add --api-key <KEY>` in this slice and record rather than conceal its exposure risk.
- Target ordinary users with CLI + local Web UI.
- Support macOS/Windows UI first and preserve Linux CLI.
- Use Supervisor + Proxy Worker.
- Keep Codex provider and proxy URL stable.
- Use guided utility console UI.
- Ship complete `en` and `zh-CN` runtime dictionaries in `app.js`; only explicit `crp.locale` selection may persist.
- Permit valid-cookie, missing-fragment re-entry only as a GET-only workspace; failed exchange and later session/CSRF authentication failures are terminal.
- Keep Task 11 screenshots as explicit sanitized local `output/` review attachments, not source files; Task 12 owns macOS/Windows review attachments.
- Require package tests to match the exact reviewed allowlist and platform native-keyring gates to probe the intended service without fallback.
- Require tests to use declared direct dependencies and every checkout before pull-request code to disable persisted credentials.
- Keep V1 release, platform, and real-home migration approval classified as L3.
- Treat `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md` as the historical Tasks 1-12 plan, not the active core-first execution plan. The created and active core-first TDD plan is `docs/superpowers/plans/2026-07-14-crp-core-first-cli-implementation.md`; implementation and evidence remain pending.
- Keep file-watcher tests condition-based and cleanup-safe across supported Node versions.
- Atomic configuration writes must compare content first and preserve source file permissions.
- Registry mutation must persist successfully before replacing in-memory state.
- Registry mutations must reload while holding the registry lock before replacing state.
- Public Supervisor startup must require native credentials; lower-level file storage remains trusted-injection only until a future L3 startup-consent design.
- Selected native operations must never replay into the private file credential namespace.
- Secret credential files must be read through a validated descriptor, never through a post-check path read.
- Credential mutation must remain gate-protected, and the primary lock must cover gate claim validation.
- Canonical gate paths must never be deleted after a separate identity check; atomically claim them to a unique path first.
- Canonical primary locks must remain until gate ownership or replacement-blocker state is proven.
- Shell validation patterns must be individually quoted so the scan itself is deterministic.
- Runtime settings must be cloned and deeply frozen before one atomic reference replacement.
- Every proxied request must capture one runtime snapshot before body listeners are registered.
- The active authentication header must be masked from debug logs and capture records, including short values and nonstandard header names.
- Worker IPC must use exact versioned directional schemas and provider-equivalent URL/header security; resolved settings may appear only in parent `configure` messages, while child messages and sanitized diagnostics expose allowlisted state and static errors only. Invalid messages always use the fixed `worker-fatal` correlation ID.
- A worker must not listen before its first valid configuration, and drain acknowledgement requires listener closure plus zero tracked in-flight requests.
- A worker must reject configuration after drain begins without replacing the active generation or losing the pending drain acknowledgement.
- Worker configure must validate the exact authentication header value that forwarding will send, without logging or returning the credential.
- Repeated drain commands must reuse the same completion and acknowledge each request without moving a drained worker back to draining.
- Parent IPC disconnect cleanup must start or reuse bounded escalation even when shutdown is already waiting on an upstream request.
- Worker lifecycle operations must share the current operation, and messages or exits from an older child epoch must never alter the replacement state.
- Lifecycle entrypoints must return the active shared operation before inspecting new call arguments.
- Restart must confirm the fixed port is exclusively bindable after bounded drain, TERM, and KILL handling before spawning and health-checking a replacement.
- The fifth crash inside a rolling 60-second window must enter `failed` immediately; the 250/500/1000/2000 ms delays are therefore used for the first four crashes, while 4000 ms remains the exponential cap rather than a fifth in-window retry.
- Restart snapshots must pass complete configure validation before the current worker is drained or its state changes.
- IPC acknowledgement promises must be observed at registration and cancelled synchronously when send fails.
- A child reference and its listeners must remain owned after TERM/KILL timeout until a later lifecycle attempt confirms exit and fixed-port release.
- Provider-service operations must use their own mutex; a worker-manager shared operation must never substitute for provider-level serialization.
- Provider lifecycle facades must reuse the current in-flight operation before queueing work or resolving credentials.
- A post-ack activation rollback must advance to a new generation; never regress a worker generation to restore the confirmed provider.
- Compensation tests must run and fail before compensation code is written.
- Migration must create a missing registry exclusively at its final path and must never adopt, modify, or delete an `EEXIST` registry.
- CLI discovery must use the private supervisor state and dispatch lifecycle and provider commands through the authenticated loopback Admin API; legacy secret-bearing flags are prohibited.
- Lifecycle fake waits must advance the injected clock and simulate owner cleanup.
- Before signaling a process, verify `pid` plus `startedAt` and never mutate state first.
- A failed supervisor spawn must receive bounded termination and state cleanup before the CLI returns its public error.
