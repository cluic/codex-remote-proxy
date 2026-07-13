# AI Handoff

## Product Summary

CRP preserves ChatGPT login/remote features while routing Codex model traffic to an OpenAI-compatible upstream. The approved next milestone adds named providers, reliable lifecycle management, and a local Web UI for ordinary users.

## Current Scope

V1 implementation is underway. Tasks 1 through 10 have landed, including atomic provider metadata, secure credential adapters, snapshot-based proxy settings, versioned worker IPC, reliable fixed-port lifecycle management, sanitized activity, transactional migration, provider orchestration, the secured loopback Admin control plane, and supervisor-backed CLI routing. Task 11, the actual Web UI assets, is next. Read `docs/PRD.md`, the formal design spec, and `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md` before changing code.

## Architecture

Landed: shared paths, safe public errors, idempotent Codex bootstrap, strict provider storage, secure credential adapters, immutable request snapshots, strict worker IPC, reliable worker management, bounded sanitized activity, transactional v0.2.2 migration, serialized provider orchestration, private local sessions, the exact Admin route/security boundary, readiness-gated supervisor composition, and state-discovered CLI dispatch through the Admin API. Target: the actual Web UI. Codex remains on `model_provider = "OpenAI"` and fixed `http://127.0.0.1:15100`; supervisor Admin API defaults to `127.0.0.1:15101`.

## Data and API

- Non-secret profiles now live in the implemented schema-versioned registry.
- API keys use the landed native adapter by default or the landed schema-version-1 `0600` file adapter only after explicit consent.
- Local API contract is in `docs/API.md`; data contract is in `docs/DATA_MODEL.md`.

## Permissions

One authenticated local OS user. Admin API is loopback-only, origin/host checked, CSRF protected, and never returns full keys. See `docs/PERMISSIONS.md`.

## Current Progress

Architecture, provider model, core flows, UI direction, errors, testing, and MVP boundary were visually reviewed and approved on 2026-07-10. The written specification and detailed V1 plan are approved, subagent-driven sequential execution is selected, and Tasks 1 through 10 are complete.

## How To Run Current Code

```bash
cd node
npm ci
npm run lint
npm test
npm run test:unit
node bin/crp.mjs --help
```

Do not run `crp start` against a real home directory during tests because it modifies Codex configuration.

## Verification

- Node 22.19 baseline and Task 1 gate: `npm test` passes 12/12 tests and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 22.19 Task 2 gate: `node --test test/codex-config.test.mjs` passes 15/15, including deterministic rename failure, exclusive same-timestamp backup collision, busy lock, external source change, CRLF preservation, guide semantics, and all three start aliases; `npm test` passes 27/27, `npm run lint` syntax-checks 9 source files, and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 22.19 Task 3 gate: `node --test test/provider-registry.test.mjs` passes 23/23, including multi-instance lock serialization, strict schema and header validation, test-state invalidation, primary-error preservation, degraded lock cleanup, refreshed defensive copies, and public allowlisting; `npm test` passes 50/50, `npm run lint` syntax-checks 11 source files, and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 22.19 Task 4 gate: `node --test test/credential-store.test.mjs` passes 41/41, the combined credential/provider focus passes 64/64, `npm test` passes 91/91, and `npm run lint` syntax-checks 14 source files. Coverage includes construction-only fallback without operation replay, explicit file-label restart continuity, descriptor identity, strict parent/file modes, degraded temp cleanup, canonical lock restoration, claim-before-delete gate release, foreign replacement preservation, and synchronous second-instance blocking while a gate claim is validated. Native tests inject the loader and never invoke the real addon loader or touch the OS credential store; real native verification remains L3 on every supported system, including Windows and Linux.
- Node 22.19 Task 5 gate: `node --test test/runtime-settings.test.mjs test/server.test.mjs` passes 13/13, `npm test` passes 102/102, and `npm run lint` syntax-checks 15 source files. Coverage includes strict generations, clone-before-freeze replacement, public-state allowlisting, one snapshot read per request before body listeners, delayed A versus immediate B switching, transport/TLS and timeout pinning, unconfigured-source rejection, health secret scans, request/response dynamic auth-header log masking, and bidirectional custom-auth capture redaction.
- Node 22.19 Task 6 gate: `node --test test/worker-protocol.test.mjs test/integration/worker-entry.test.mjs` passes 21/21, `npm run test:integration` passes 11/11, and `npm test` passes a nonduplicated 112/112 top-level group followed by 11/11 integration tests; `npm run lint` syntax-checks 18 source files. Coverage includes exact version-1 directional schemas, HTTPS-or-loopback upstreams, HTTP-token authentication fields, final authentication-value validation, sensitive and conflicting header rejection, parent-only configure secrets, fixed invalid-message fatal IDs, configure-before-listen, monotonic reconfiguration, configure rejection after drain begins, retained in-flight drain acknowledgement, idempotent duplicate drain, health/status, idle keep-alive closure, clean shutdown, bounded parent-disconnect cleanup with a hanging upstream before or during shutdown, safe startup failures, stale generations, port conflicts, port release, and child-process cleanup without fixed sleeps. Real-fork integration runs after the ordinary group so it cannot race watcher readiness in another test process.
- Node 22.19 Task 7 gate: strict-unhandled `node --test test/worker-manager.test.mjs test/integration/worker-restart.test.mjs` passes 22/22; exact `npm test` passes 126/126 non-capture unit assertions, 7/7 isolated capture assertions, and 12/12 integration tests without duplication; `npm run test:unit` retains all-top-level coverage and passes 133/133. `npm run lint` syntax-checks 19 source files, and `npm audit --omit=dev` reports zero vulnerabilities. Coverage includes ready/configure/health startup, acknowledgement-atomic snapshot application, concurrent restart reuse before inspecting its snapshot, restart prevalidation before drain when no operation exists, immediate waiter observation and send-failure cancellation, graceful drain/shutdown, TERM/KILL escalation, retained child control after termination timeout, same-port real-worker restart with a changed PID, partial-start and port-release cleanup, correlated fatal and malformed-message sanitization, old-epoch isolation, cancellable injected-clock crash backoff, immediate failure on the fifth crash in 60 seconds, and idempotent retryable close without child, timer, listener, or port residue. The exact runner isolates the preexisting polling capture watcher between the core unit and real-fork integration groups so its registration baseline cannot race unrelated unit load.
- Node 22.19 Task 8 gate: `node --test test/activity-store.test.mjs test/migration.test.mjs test/provider-service.test.mjs` passes 42/42; exact `npm test` passes 168/168 core assertions, 7/7 isolated capture assertions, and 12/12 integration tests; `npm run lint` syntax-checks 22 source files. Tests use only temporary paths, injected credential adapters/fetch responses, fake worker boundaries, and loopback redirect servers. Coverage includes recursive lifecycle-field redaction, ownership-checked activity locks, descriptor-safe migration paths, exclusive final-path registry creation, symlink and foreign-replacement preservation, committed-state reconciliation, redirect refusal, active-update rejection, replacement-secret compensation, selected credentials, explicit operation serialization, and conservative activation rollback `1 -> 2 -> 3` after health or lost-ACK uncertainty. Real HOME migration, native keyrings, cross-platform filesystem semantics, and live upstreams remain prohibited until L3 platform review.
- Node 22.19 Task 9 gate: `node --test test/session-auth.test.mjs test/provider-service.test.mjs test/integration/admin-server.test.mjs` passes 42/42; exact `npm test` passes 179/179 core assertions, 7/7 isolated capture assertions, and 23/23 integration tests; `npm run lint` syntax-checks 26 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage includes descriptor-safe private control tokens, expiring browser sessions/CSRF, exact Host/Origin/CORS rules, bounded request schemas, every Admin route, response/error secret scans, static allowlisting without actual UI files, active-only lifecycle credentials with in-flight command reuse, migration-before-registry composition, readiness-gated private state, startup compensation, separate Codex/state adapters, and signal cleanup. Real HOME, native keyring, external provider traffic, actual UI assets, and cross-platform browser behavior remain prohibited until their later gates.
- Node 22.19 Task 10 gate: `node --test test/crp.test.mjs test/integration/crp-lifecycle.test.mjs` passes 27/27; exact `npm test` passes 202/202 core assertions, 7/7 isolated capture assertions, and 24/24 integration assertions; `npm run lint` syntax-checks 27 source files and `npm audit --omit=dev` reports zero vulnerabilities. Coverage includes state discovery, authenticated lifecycle and provider dispatch, `ui` browser-session discovery, legacy secret-bearing flag rejection, owner-identity-checked shutdown, startup waiting, and failed-spawn cleanup without process or state residue. `git diff --check` and the static secret-pattern scan pass. Tests use temporary homes and injected spawn/client boundaries; real HOME, native keyrings, external provider traffic, browser launch behavior, and cross-platform process identity and signal handling remain L3.
- Node 24.2 stability: `node --test test/capture-store.test.mjs` passes 7/7 without hanging after replacing fixed watcher sleeps with bounded condition waits and pre-assertion cleanup.
- Future V1 gate: the full matrix and acceptance flow in `docs/TESTING.md`.

## Known Risks

Credential migration, localhost browser security, in-flight activation semantics, secret leakage, cross-platform worker signal/port-release semantics, and cross-platform atomic rename and permission semantics.

## Recent Decisions

- Use harness-builder `iterate` mode.
- Target ordinary users with CLI + local Web UI.
- Support macOS/Windows UI first and preserve Linux CLI.
- Use Supervisor + Proxy Worker.
- Keep Codex provider and proxy URL stable.
- Use guided utility console UI.
- Classify future V1 implementation as L3.
- Execute the approved design through the task sequence in `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md`.
- Keep file-watcher tests condition-based and cleanup-safe across supported Node versions.
- Atomic configuration writes must compare content first and preserve source file permissions.
- Registry mutation must persist successfully before replacing in-memory state.
- Registry mutations must reload while holding the registry lock before replacing state.
- File credential fallback must never be selected without explicit consent.
- Selected native operations must never replay into the file credential namespace.
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
