# AI Handoff

## Product Summary

CRP preserves ChatGPT login/remote features while routing Codex model traffic to a selected OpenAI-compatible upstream. Named Providers, lifecycle management, bounded provider-model discovery, the local Admin API, Codex history repair, anonymous operational Metrics, and a responsive bilingual Web UI are implemented. M2E/V8 replaces the prior Web source with a v0-aligned React + TypeScript SPA while production remains an exact three-file static package. V8.1 refines model selection, global feedback, sidebar routing/lifecycle, cookie-session recovery, and Provider duplication. Copied-corpus, cross-platform, and release gates remain separate.

## Current Scope

Tasks 1 through 11 and the core-first/V5/V6/V7 slices remain historical foundations. M2E/V8 is implemented on the current working tree: `node/ui-src/` is build-time React + TypeScript source, Vite emits exactly `node/ui/index.html`, `app.js`, and `styles.css`, and the exact package allowlist is 34 files with the MIT License and `src/supervisor/metrics-store.mjs`. Task 12 package/platform gates remain parked. Production macOS D2 passed on its reviewed historical tree with native Keychain and a real Dusapi upstream; it does not prove the current V8 browser or cross-platform release tree.

`docs/WEB_PRODUCT_SPEC.md` preserves the historical v0 input beneath an explicit V8 override. Current `docs/API.md`, `docs/DATA_MODEL.md`, `docs/UIUX.md`, `docs/STATUS.md`, `docs/TESTING.md`, and tested runtime behavior are authoritative when historical sections differ.

Historical user acceptance on 2026-07-15 confirmed real provider creation and hot switching, then exposed three CLI presentation gaps: human `provider list` discarded provider summaries, human `status` showed only Supervisor presence, and layered `-h`/`--help` was missing. V5 repaired those gaps without changing machine contracts; V6 later superseded alias/help defaults, and V8 later superseded the frozen Web tree.

Historical V5 behavior added the safe human provider/status projections and layered help, passing 24/24 focused and 313/313 aggregate tests on that tree. M2C/V6 intentionally supersedes its alias/help-default contract: help is English unless `--locale zh-CN` is explicit, and `init`/`install`/`setup` now return side-effect-free `CLI_COMMAND_REMOVED` replacement guidance.

The current release-preparation behavior further removes environment and browser-language inference: all CLI human output and a first-time Web session default to English. Chinese requires an explicit CLI `--locale zh-CN` or a Web language selection; only the Web selection is retained in `crp.locale`.

The M2C/V6 CLI adds optional `provider add --model` as create then test; creation stays committed on a failed result or second-stage operational error. Provider test/activate/delete/models accepts ID XOR exact case-insensitive name. `provider models` refreshes a bounded authenticated no-redirect `/models` catalog into an independent schema-1 private cache; Admin GET reads the cache without upstream traffic. CLI compatibility tests opt into initial selection; the first successful test wins a registry compare-and-set only while the Worker is stopped, writes `activeProviderId`, reports `workerStarted: false`, and never starts or reconfigures the Worker. Admin defaults `activateIfNone` to false; V8 conditional Setup explicitly opts in, while ordinary Provider-page tests omit it.

M2D/V7 reads the root Codex `model_provider` and its selected provider `base_url` from one locked pre-patch snapshot. The shared inspection/patch scanner supports the relevant quoted, dotted, multiline, and collection syntax, rejects invalid UTF-8 and malformed or ambiguous selected bindings, and intentionally does not validate unrelated TOML semantics. Repair is URL-only: first creation and the same normalized effective URL perform no history scan, including provider-name-only changes. A different or missing URL triggers discovery; an empty write set uses a config-only commit, while a nonempty set snapshots exact rollout bytes and SQLite logical state, publishes a private pending journal, publishes the fixed config, and forward-repairs only provider metadata.

The recovery protocol uses `pending.json -> pending.json.clearing -> removed`, exact source/target hashes, atomic rollout backups, exclusive fsynced SQLite Online Backup API snapshots, pre-rename rollout metadata durability, affected-parent fsync, and repeated config/lock checks. A committed history uncertainty preserves a marker or config lock and returns `pending:true`; config-only uncertainty returns `CODEX_CONFIG_COMMITTED_DEGRADED` with `pending:false`. Canonical SQLite files and `-wal/-shm/-journal` sidecars must be regular, non-symlink, and single-link. Codex must be fully stopped because external concurrent sidecar creation is outside CRP's lock.

Bootstrap, explicit Provider activation, Worker start/restart, and unexpected-exit recovery share one FIFO Codex readiness gate. Queued automatic recovery rechecks its cancellation generation before spawn, so stop/close cannot release a stale recovery. CLI bootstrap has a dedicated bounded 300-second request timeout; discovery remains 2 seconds and ordinary operations 30 seconds. V8 Setup sends `save -> test with activateIfNone/CAS selection -> bootstrap/history repair -> start`; the CAS never starts the Worker. Explicit Provider activation is the separate production switch operation and starts a stopped Worker.

Do not describe workflow definitions as platform results. The local macOS native-keyring/upstream D2 pass is not remote or cross-platform evidence. GitHub-runner macOS/Windows/Linux native-service results, macOS/Windows screenshots, real-home migration/rollback, cross-platform hardlink/`O_NOFOLLOW`/ACL behavior, and expert approval are still pending release gates.

## Architecture

Implemented: shared paths, safe public errors, idempotent Codex bootstrap/history repair, strict Provider/model-catalog storage, secure credential adapters, immutable request snapshots, strict Worker IPC, reliable Worker management, bounded sanitized Activity, strict anonymous Metrics aggregation, transactional v0.2.2 migration, serialized Provider orchestration, private local sessions, the exact Admin route/security boundary, readiness-gated Supervisor composition, state-discovered CLI dispatch, and the responsive packaged three-file bilingual Web UI. Codex remains on `model_provider = "OpenAI"` and fixed `http://127.0.0.1:15100`; Supervisor Admin API defaults to `127.0.0.1:15101`.

The latest V8.1 UI patch aligns the Setup model-refresh button with the model input/select top edge, resets the offset in narrow single-column layouts, and has a focused 1/1 Chromium geometry regression plus sanitized screenshot evidence under `output/playwright/v81/setup-model-alignment-fixed.png`.

Core-first implementation retains the safe bootstrap, CLI, D1, timeout, URL-join, detached-startup, and Capture-reconciliation behavior described in historical evidence. M2C/V6 added model/test fields and independent cache; M2D/V7 added bounded history-repair output and recovery state. M2E/V8 adds read-only `GET /metrics/overview`, strict 32 MiB private hourly Metrics storage, generation-to-Provider attribution, and the rebuilt Web. V8.1 adds `POST /session/resume` under the same API version without changing registry schema, fixed addresses, or Codex provider identity.

The CLI adapter exposes `ui` and `start` as the two setup/start entry points. Removed `init`, `install`, and `setup` commands do not discover the Supervisor or mutate state. `stop` continues to stop only the Worker while `shutdown` exits the Supervisor.

## Data and API

- Non-secret profiles now live in the implemented schema-versioned registry.
- Model catalogs live in independent strict schema-version-1 `provider-model-cache.json`; registry schema 2 and provider public fields are unchanged.
- Anonymous Metrics lives in independent strict schema-version-1 `metrics.json`, retains at most 168 UTC hourly buckets, and is capped at 32 MiB so every valid maximum-cardinality document remains persistable. It is reconstructable and independent from Capture.
- Admin `GET`/`POST /providers/:id/models` distinguish cached reads from authenticated refreshes. Provider test accepts optional `activateIfNone` default false and always returns an `initialActivation` projection; V8 Setup is the Web caller that opts in.
- Admin `GET /metrics/overview?window=24h|7d` returns bounded request/result, observed-Token, Provider/model, fixed-histogram latency, and data-quality summaries without per-request fields.
- Admin `POST /session/resume` accepts only a valid browser cookie with exact Origin and `X-CRP-Session-Resume: 1`, rejects bearer/query/body aliases, rotates session and CSRF, invalidates old values, and preserves the original absolute expiry.
- Admin `POST /codex/bootstrap` returns only bounded repair counts/flags and distinguishes config-only committed degradation from a pending history transition. `GET /status` reports not ready for pending markers, config locks, unsafe identity, invalid UTF-8, or invalid selected bindings.
- Public Supervisor startup requires the landed native adapter. UI, CLI, and Admin expose no file-backend selector; the lower-level private file adapter is trusted-injection only pending a future L3 startup-consent design.
- Local API contract is in `docs/API.md`; data contract is in `docs/DATA_MODEL.md`.

## Permissions

One authenticated local OS user. Admin API is loopback-only, origin/host checked, CSRF protected, and never returns full keys. See `docs/PERMISSIONS.md`.

## Current Progress

M2E/V8 implementation and local acceptance are complete. V8.1 adds complete catalog/manual model selection, compact global sidebar switching and lifecycle controls, non-reflowing closable messages, explicit management recovery from a still-valid GET-only cookie session, and Provider duplication without credential/state copying. React/TypeScript/Vite remain build-time only and production output remains exactly three static files.

V8.1 verification passes session/Admin focus 37/37, exact `npm test` 466/466 (`414` unit-core + `8` isolated Capture + `43` ordinary integration + `1` serial core-chain), Chromium 39/39, lint 33, UI typecheck/build/exact-output, exact package-content 3/3, both audits at zero vulnerabilities, diff checks, visual inspection, and independent security/React/test reviews. The user-authorized temporary Supervisor and Worker were shut down cleanly before the fixed-port rerun; ports `15100` and `15101` were released afterward.

The current MIT and deterministic-language preparation rerun passes CLI/i18n 30/30, Chromium 39/39, UI typecheck/build/exact-output, lint, runtime audit, package/release tests 21/21, the exact 34-file package dry run, and exact `npm test` 467/467 (`415` unit-core + `8` Capture + `43` ordinary integration + `1` serial core chain) with both fixed ports released.

Final V8 evidence is exact `npm test` 463/463 (`412` unit-core + `8` capture + `42` integration + `1` core-chain), Metrics focus 6/6, lint 33, UI typecheck/build/exact-output pass, package-content 3/3 against 33 files, Chromium 33/33 including English/Chinese 1440/1024/390, both audits at zero vulnerabilities, and matched visual evidence under `output/web-v8/` plus `design-qa.md`. No deterministic gate may be reported as real Codex-history, native-credential, or external-provider evidence; the earlier production D2 result remains historical native/upstream evidence for its reviewed tree.

Production D2 used the real CLI, production native-keyring adapter and login Keychain, a real Dusapi upstream, and a detached Supervisor. CRP paths were isolated through `CRP_HOME` while the real `HOME` remained available to Keychain. Provider test succeeded, activation and proxy start succeeded, a real `/responses` request returned HTTP `200 OK`, health passed, restart kept the Supervisor PID and replaced the worker PID, and stop/shutdown plus process/state/port/temporary-state cleanup passed. A separate detached clean-home run created `.codex`/`config.toml` privately with fixed `OpenAI`/`15100` and passed bootstrap evidence. This completes the local core D2 gate.

## How To Run Current Code

```bash
cd node
npm ci
npm run lint
npm run typecheck:ui
npm run build:ui
npm run verify:ui-build
npm test
node scripts/run-test-group.mjs core-chain
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
- Core-first tree after the host-locale/capture correction: Chinese-environment `npm test` passes 296/296 (`262` unit-core + `8` isolated capture + `25` ordinary integration + `1` serial core-chain), lint syntax-checks 29 source files, the host-sensitive CLI focus passes 3/3, capture focus passes 8/8, directed review passes 58/58, and two capture suites pass 20 concurrent repetitions. Independent review reports `PASS` with zero findings. The earlier `4bbb97c` runtime audit remains zero-vulnerability evidence and package verification remains the exact 30-file allowlist. The core-chain uses production components but substitutes an in-memory credential adapter and loopback upstreams; it remains D1 evidence.
- Local macOS D2: production native Keychain, detached Supervisor discovery, real Dusapi provider test and `/responses` HTTP `200 OK`, activate/start/restart/health/stop/shutdown, stable Supervisor PID, changed worker PID, and cleanup all pass. Separate clean-home detached bootstrap evidence also passes. D2 completes the local core gate without satisfying cross-platform release evidence.
- Capture stability: `node --test test/capture-store.test.mjs` passes 8/8 after replacing the first asynchronous stat baseline with a synchronous SHA-256 content fingerprint and 500 ms reconciliation; the added startup-rewrite regression covers the former race, and two capture suites pass 20 concurrent repetitions.
- Detached startup and migration-input repair: `node --test test/crp.test.mjs test/migration.test.mjs test/integration/admin-server.test.mjs` passes 69/69; exact `npm test` passes 304/304 (`268` unit-core + `8` capture + `27` integration + `1` core-chain), lint checks 29 source files, runtime audit reports zero vulnerabilities, and independent read-only review found no code blocker. Tests use only temporary/injected boundaries; the user's real HOME, credentials, and existing processes were not changed.
- M2B CLI human-output/help repair: `node --test test/cli-i18n.test.mjs` passes 24/24; exact `npm test` passes 313/313 (`277` unit-core + `8` capture + `27` integration + `1` core-chain); lint checks 29 source files; `npm audit --omit=dev` reports zero vulnerabilities; independent final code/test review reports `PASS`. JSON, Admin, lifecycle, fixed `OpenAI`/`15100`, Web, and Task 12 contracts remain unchanged.
- M2C/V6 final local gate: exact `npm test` 358/358 (`320` unit-core + `8` capture + `29` integration + `1` core-chain); provider-model cache 20/20; CLI 70/70; control-plane 74/74; post-review risk focus 157/157; lint 30 source files; package-content 3/3 against the exact 31-file allowlist; audit 0; diff check pass; unchanged-Web Chromium 41/41. Coverage includes exact cache schema/bounds/private persistence, source invalidation, credential-echo rejection, last-good preservation, committed-degraded store/Activity semantics, additive Admin projections, name snapshot revalidation, two-stage add/test semantics, first-wins Worker-free initial selection, explicit test outcomes, English-default help/current guide, and removed-alias no-side-effect errors.
- M2D/V7 final local gate on Node 22.19: history/config 98/98; strict status/lifecycle 105/105; exact `npm test` 451/451 (`401` unit-core + `8` capture + `41` integration + `1` core-chain); lint 31 source files; package-content 3/3 against the exact 32-file allowlist; audit 0; diff check pass; request-order-only Chromium 41/41; fixed ports released. Coverage includes URL-only trigger decisions, shared selected-binding scanning, crash-safe journal/backup/recovery, final config/lock validation, strict SQLite and sidecar identities, both committed-degraded classes, FIFO readiness for every Worker spawn, cancellation-safe automatic recovery, and the bounded bootstrap timeout. Tests used temporary roots and synthetic state only.
- M2E/V8 final local gate: exact 463/463, Metrics 6/6, lint 33, UI typecheck/build/exact-output pass, package-content 3/3 against 33 files, Chromium 33/33 with English/Chinese 1440/1024/390 coverage, audits 0, diff and sensitive-pattern scans pass, matched visual comparison plus `design-qa.md` pass, and independent final review `PASS`. Tests use temporary roots, synthetic credentials, and loopback upstreams.
- Pending V1 release gate: remote platform/native/visual evidence, real-home migration/rollback evidence, and human L3 approval in `docs/TESTING.md`; pull request, push, merge, versioning, publication, and release also remain pending.

## Known Risks

Credential migration on a real home, real localhost browser launch/security, cross-platform native credential backends, cross-platform worker signal/port-release semantics, cross-platform hardlink/`O_NOFOLLOW`/ACL and atomic rename/permission semantics, and macOS/Windows visual behavior remain L3 release gates. General child-process environment minimization is separate deferred L3 hardening and does not block local core completion. Push, pull request, merge, versioning, and publishing have not occurred.

Provider model-cache atomic rename/mode behavior remains platform-sensitive. `/models` is not universal among OpenAI-compatible providers; refresh failure must remain non-destructive and manually entered test models remain supported.

V7 has deterministic temporary-root evidence only. A copied large real-home corpus must still prove the 300-second budget, storage growth, interruption/retry time, platform directory fsync/hardlink behavior, and absence of concurrent Codex sidecar creation. The URL-only decision intentionally leaves same-URL provider-name-only custom migrations for operator review.

The current `provider add --api-key <KEY>` interface remains an explicitly deferred argv/history exposure by user decision and will be redesigned later. The completed D2 evidence, not the injected D1 chain, satisfies the local real provider/native-keyring core gate.

V8 implementation supersedes the prior frozen Web and its parked field-alignment/stale-step defects. Final local browser and visual acceptance passes; deterministic browser evidence does not replace copied-corpus real-home or cross-platform release evidence.

## Recent Decisions

- Use harness-builder `iterate` mode.
- M2E/V8 supersedes the historical Web freeze with a clean v0-aligned React implementation while preserving the three-file package and existing security boundary.
- Keep existing Admin route meanings, API version, and provider registry schema; do not add an aggregate setup endpoint.
- Add model catalogs through independent schema-1 storage and additive `/api/v1` routes; keep provider registry schema 2.
- Compose `provider add --model` as durable create then test, and resolve CLI provider names without changing ID-addressed Admin routes.
- Let CLI and conditional Web Setup tests opt into first-provider selection; use a stopped-Worker first-wins compare-and-set and never start the Worker implicitly. Keep ordinary tests non-selecting and explicit activation start-capable.
- Default help to English; require explicit `--locale zh-CN` for Chinese help and remove `init`/`install`/`setup` with local migration guidance.
- Create a missing Codex config privately and atomically with no backup, while preserving backup/mode/idempotency behavior for existing files.
- Support human CLI output in `en` and `zh-CN`; keep JSON keys, codes, enums, messages, and actions stable English contracts.
- Require both deterministic production-component composition and a separately authorized real provider/native-keyring smoke before claiming local core completion; both gates now pass.
- Retain `provider add --api-key <KEY>` for now, record rather than conceal its exposure risk, and defer redesign to later work.
- Target ordinary users with CLI + local Web UI.
- Support macOS/Windows UI first and preserve Linux CLI.
- Use Supervisor + Proxy Worker.
- Keep Codex provider and proxy URL stable.
- Use guided utility console UI.
- Ship complete `en` and `zh-CN` runtime dictionaries in `app.js`; only explicit `crp.locale` selection may persist.
- Start valid-cookie, missing-fragment re-entry as GET-only; permit only explicit exact-origin recovery within the original expiry, and keep failed launch exchange, expired recovery, and later business-session/CSRF failures terminal.
- Keep Task 11 screenshots as explicit sanitized local `output/` review attachments, not source files; Task 12 owns macOS/Windows review attachments.
- Require package tests to match the exact reviewed allowlist and platform native-keyring gates to probe the intended service without fallback.
- Require tests to use declared direct dependencies and every checkout before pull-request code to disable persisted credentials.
- Keep V1 release, platform, and real-home migration approval classified as L3.
- Treat `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md` as the historical Tasks 1-12 plan. The core-first TDD plan is `docs/superpowers/plans/2026-07-14-crp-core-first-cli-implementation.md`; Scopes A/B, D1, corrections, and local D2 are complete.
- Treat detached lifecycle/bootstrap evidence as only partial D2 unless native credential retrieval and the real upstream request also complete; the final macOS run meets that full boundary.
- Keep Supervisor liveness probes short without reusing that timeout for provider-test or other normal Admin operations.
- Join proxy target URLs structurally; string concatenation of a normalized trailing-slash base and incoming path is prohibited.
- CLI human-output tests must select their locale explicitly instead of inheriting the developer environment.
- File reconciliation must establish its comparison baseline synchronously before periodic asynchronous checks begin.
- Keep file-watcher tests condition-based and cleanup-safe across supported Node versions.
- Atomic configuration writes must compare content first and preserve source file permissions.
- Registry mutation must persist successfully before replacing in-memory state.
- Registry mutations must reload while holding the registry lock before replacing state.
- Public Supervisor startup must require native credentials; lower-level file storage remains trusted-injection only until a future L3 startup-consent design.
- Detached Supervisor startup errors must use the one-shot exact static allowlist; arbitrary child messages, actions, details, and causes must never cross into CLI output.
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
- Distinct credentials across validated legacy sources must fail as `MIGRATION_INPUT_INVALID` before backups, credential access, registry creation, or source mutation.
- CLI discovery must use the private supervisor state and dispatch lifecycle and provider commands through the authenticated loopback Admin API; legacy secret-bearing flags are prohibited.
- Lifecycle fake waits must advance the injected clock and simulate owner cleanup.
- Before signaling a process, verify `pid` plus `startedAt` and never mutate state first.
- A failed supervisor spawn must receive bounded termination and state cleanup before the CLI returns its public error.
