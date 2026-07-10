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

- Existing suite: `cd node && npm test`
- Runtime audit: `cd node && npm audit --omit=dev`

The implementation plan must add stable scripts for `test:unit`, `test:integration`, `test:e2e`, `lint`, and UI build before their respective modules land.

## Test Matrix

| Area | Required Tests |
| --- | --- |
| Provider registry | Validation, duplicate names, atomic persistence, schema migration, rollback |
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
