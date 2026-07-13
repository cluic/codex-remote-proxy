# Status

## Current Milestone

V1 implementation: provider lifecycle end to end.

## In Progress

- Sequential execution of the approved V1 plan; Tasks 1 through 10 are complete. The Task 11 Overview visual and English/Simplified Chinese runtime-dictionary design are approved, its single-writer scope is claimed, and implementation has not started.

## Done

- Audited v0.2.2 behavior and verified the four reported product gaps.
- Selected Supervisor + Proxy Worker architecture.
- Defined stable Codex provider and fixed proxy invariants.
- Defined provider/credential model, local Admin API, guided utility UI, security boundary, and verification path.
- Created the project harness and living docs.
- Received written specification approval.
- Created and self-reviewed the detailed V1 implementation plan.
- Completed Task 1 portable syntax, unit-test, E2E script, packaging, and dependency gates.
- Stabilized capture watcher tests with condition-based waits and assertion-safe cleanup on Node 22.19 and Node 24.2.
- Completed Task 2 shared path and public-error contracts plus line-ending-preserving, lock-serialized, idempotent and atomic Codex bootstrap behavior, covered by 15/15 focused and 27/27 full Node 22.19 tests.
- Completed Task 3 strict provider validation and lock-serialized atomic schema-version-2 registry behavior, covered by 23/23 focused and 50/50 full Node 22.19 tests.
- Completed Task 4 native and explicit-consent file credential adapters, including construction-only fallback without operation replay, explicit file-label restart continuity, descriptor-safe reads, degraded temp cleanup, canonical lock restoration, and primary-blocked claim-before-delete gate release, covered by 41/41 focused, 64/64 combined credential/provider, and 91/91 full Node 22.19 tests; syntax checking covers 14 source files.
- Completed Task 5 monotonic immutable runtime settings and request-start snapshot capture. In-flight A remains internally consistent while new traffic switches to B; dynamic health, transport and timeout pinning, request/response short and custom authentication log masking, and bidirectional custom-auth capture redaction are covered by 13/13 focused and 102/102 full Node 22.19 tests; syntax checking covers 15 source files.
- Completed Task 6 strict version-1 worker IPC and the proxy-worker child entrypoint. Configure enforces HTTPS-or-loopback upstreams, HTTP-token authentication fields, Node-compatible final authentication values, and sensitive/header-collision rejection; the worker remains unbound until valid configuration, rejects configure after drain begins without losing the pending drain acknowledgement, keeps repeated drain acknowledgements and status drained, bounds parent-disconnect cleanup when an upstream hangs before or during shutdown, uses a fixed correlation ID for invalid-message fatals, releases its port on shutdown, and emits only sanitized child messages. Coverage passes 21/21 focused and 11/11 integration tests; the full gate passes 112/112 top-level tests followed by 11/11 integration tests without duplication. Syntax checking covers 18 source files, including the sequential group runner that isolates real-fork load from watcher tests.
- Completed Task 7 reliable worker lifecycle management and its review fixes. Startup requires ready, correlated configure acknowledgement, and matching health; snapshot generations advance only after matching acknowledgement; concurrent restart calls reuse the current operation before inspecting a new snapshot, while an unshared restart validates the complete snapshot before drain; send failures synchronously cancel observed acknowledgement waiters; stop and restart bound drain, TERM, and KILL, confirm exclusive fixed-port release, retain control after termination timeout, and isolate old child epochs. Unexpected exits recover with cancellable injected-clock backoff and fail immediately on the fifth crash in 60 seconds. Strict-unhandled coverage passes 22/22 focused tests; the exact full gate passes 126/126 non-capture unit assertions, 7/7 isolated capture assertions, and 12/12 integration tests; the all-top-level compatibility command passes 133/133. Syntax checking covers 19 source files, and the runtime audit reports zero vulnerabilities.
- Completed Task 8 sanitized activity, transactional legacy migration, and provider orchestration. Activity uses an exact event allowlist, expanded recursive denylist, bounded retention, atomic replacement, and ownership-checked degraded locks. Migration uses descriptor-safe source/registry reads, symlink rejection, byte-exact exclusive backups, transaction locking, exclusive final-path registry creation, identity-checked rollback, committed-state reconciliation, and canonical blockers. Provider CRUD/test/activation rejects active edits, refuses redirects, reconciles committed mutations, serializes selected-credential operations, and deterministically rolls an uncertain candidate back with a newer generation. Focused coverage passes 42/42; exact full coverage passes 168/168 core, 7/7 capture, and 12/12 integration assertions; syntax covers 22 source files. All tests use temporary paths, injected adapters, and loopback mocks; real HOME/keyring/live-network migration remains an L3 gate.
- Completed Task 9 secured loopback Admin API and supervisor composition. Private 32-byte control/session/CSRF tokens, exact Host/Origin and disabled-CORS enforcement, bounded exact request contracts, positive public/error projections, every approved Admin route, activity pagination, read-only settings, static-asset allowlisting, active-only proxy lifecycle facades with in-flight command reuse, migration-before-registry composition, readiness-gated `0600` state, construction/listen rollback, separate Codex/state filesystem adapters, and idempotent signal cleanup are covered. Focused coverage passes 42/42; exact full coverage passes 179/179 core, 7/7 capture, and 23/23 integration assertions; syntax checks 26 source files and the runtime audit reports zero vulnerabilities. Actual UI assets, CLI routing, real HOME/keyring/network use, and cross-platform browser security remain later gates.
- Completed Task 10 supervisor-backed CLI routing. State discovery and authenticated Admin API dispatch now cover `ui`, lifecycle commands, and provider commands; legacy secret-bearing flags are rejected, owner identity is checked before shutdown signaling, and failed supervisor spawns receive bounded cleanup. Focused coverage passes 27/27; the exact full gate passes 202/202 core, 7/7 capture, and 24/24 integration assertions; syntax checks 27 source files, the runtime audit reports zero vulnerabilities, and diff plus static secret-pattern checks pass. Actual Web UI assets and real HOME/keyring/network, browser, signal, and cross-platform behavior remain later L3 gates.

## Blocked

- No current blocker is recorded for the bounded Task 11 implementation.

## Next

1. Execute the approved Task 11 bilingual UI plan against the existing Admin API without changing backend contracts.
2. Keep product implementation within the approved V1 task order and fixed provider/proxy invariants.

## Risks

- Future V1 implementation is L3 because it handles credentials, local browser security, Codex configuration, and process lifecycle.
- Cross-platform credential APIs and restart semantics require real macOS and Windows verification.
- Provider-registry atomic rename and permission semantics remain unverified on real Windows and Linux hosts.
- Task 4 tests inject the native loader and never invoke the real addon loader or touch an OS credential store; native verification remains L3 on every supported system, including Windows and Linux.
- Task 10 tests use temporary homes and injected process/client boundaries; real HOME, native keyrings, external provider traffic, browser launch behavior, and cross-platform process identity and signal handling remain L3.
