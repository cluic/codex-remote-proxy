# AI Handoff

## Product Summary

CRP preserves ChatGPT login/remote features while routing Codex model traffic to an OpenAI-compatible upstream. The approved next milestone adds named providers, reliable lifecycle management, and a local Web UI for ordinary users.

## Current Scope

V1 implementation is underway. Tasks 1 through 6 have landed, including atomic provider metadata, secure credential adapters, snapshot-based proxy settings, and the versioned proxy-worker IPC entrypoint. Task 7, reliable worker lifecycle management, is next. Read `docs/PRD.md`, the formal design spec, and `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md` before changing code.

## Architecture

Landed: shared paths, safe public errors, idempotent Codex bootstrap with source-EOL preservation and atomic replacement, strict provider-schema validation, a lock-serialized atomic schema-version-2 provider registry, credential adapters with explicit-only file fallback, monotonic immutable runtime snapshots captured once per proxied request, and a strict version-1 child-process protocol whose worker listens only after valid configuration. Target: worker-manager orchestration, provider-service orchestration, and the long-lived supervisor control plane. Codex remains on `model_provider = "OpenAI"` and fixed `http://127.0.0.1:15100`; supervisor Admin API defaults to `127.0.0.1:15101`.

## Data and API

- Non-secret profiles now live in the implemented schema-versioned registry.
- API keys use the landed native adapter by default or the landed schema-version-1 `0600` file adapter only after explicit consent.
- Local API contract is in `docs/API.md`; data contract is in `docs/DATA_MODEL.md`.

## Permissions

One authenticated local OS user. Admin API is loopback-only, origin/host checked, CSRF protected, and never returns full keys. See `docs/PERMISSIONS.md`.

## Current Progress

Architecture, provider model, core flows, UI direction, errors, testing, and MVP boundary were visually reviewed and approved on 2026-07-10. The written specification and detailed V1 plan are approved, subagent-driven sequential execution is selected, and Tasks 1 through 6 are complete.

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
- Node 24.2 stability: `node --test test/capture-store.test.mjs` passes 7/7 without hanging after replacing fixed watcher sleeps with bounded condition waits and pre-assertion cleanup.
- Future V1 gate: the full matrix and acceptance flow in `docs/TESTING.md`.

## Known Risks

Credential migration, localhost browser security, worker-manager crash recovery and restart escalation, in-flight activation semantics, secret leakage, and cross-platform atomic rename and permission semantics.

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
