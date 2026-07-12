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
- Runtime audit: `cd node && npm audit --omit=dev`

`npm run lint` recursively checks `.mjs` and `.js` files under `bin`, `src`, `scripts`, and `ui`, skipping source roots that have not landed. On Node 22.19, the Task 2 focused suite passes 15/15 tests. Its coverage verifies OpenAI provider creation and update, custom-provider and CRLF preservation, byte idempotency, one-time adjacent backup, exclusive same-timestamp backup collision handling, CRP lock contention, external source-change rejection, atomic mode-preserving replacement, deterministic rename-failure cleanup and original preservation, all nine injected-home paths, safe public error serialization, `start`/`install`/`setup` JSON and managed-state backup propagation, and accurate guide backup semantics.

The Node 22.19 Task 3 focused suite passes 23/23 tests. The Task 4 credential suite passes 41/41, the combined credential/provider suite passes 64/64, and the current full suite passes 91/91; `npm run lint` syntax-checks 14 source files. Task 4 coverage includes the shared async adapter contract, lazy native-loader failure, construction-only fallback, no operation replay for native get/set/has/delete outages, explicit file-label restart continuity without migration, exact schema and string persistence, reload and refreshed reads, no enumeration API, two-instance lost-update prevention, strict parent/file modes, POSIX no-follow and simulated-Windows descriptor identity, symlink-swap rejection before byte reads, fsync/rename order, rollback cleanup, bounded secret-temp cleanup and permanent uncommitted degradation, gate-covered atomic lock claims, preexisting foreign-gate preservation, claim-before-delete gate release under an immediate foreign replacement, canonical blocker restoration, synchronous second-instance rejection during gate claim validation, normal claim cleanup and subsequent mutation, fresh-instance busy behavior, permanent committed lock degradation, input validation, and public provider masking. Tests never invoke the default native loader or construct or query a real native credential entry. Real native-backend verification remains L3 on every supported system, including Windows and Linux; file permission and rename semantics on Windows and Linux also remain unverified.

The Node 22.19 Task 5 focused suite passes 13/13 and the current full suite passes 102/102; `npm run lint` syntax-checks 15 source files. Coverage verifies generation validation and failure atomicity, deep clone/freeze behavior, public allowlisting, exactly one request-start snapshot capture, delayed A versus immediate B switching, a transport-option spy for TLS pinning before body arrival, pinned authentication, headers, timeout, capture context and request IDs, static compatibility, unconfigured-source rejection, dynamic health secret scans, request/response short and custom authentication debug masking, and bidirectional custom-auth capture redaction.

`npm run test:unit` runs only top-level `test/*.test.mjs` files. The `test:integration` runner is present and recursively discovers `test/integration/**/*.test.mjs`, but no integration tests exist yet, so it intentionally fails with an explicit no-files error and is not part of the current runnable gate. `test:e2e` and the combined `test:all` command are also not current gates until the UI, Playwright configuration, and E2E specs land.

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
