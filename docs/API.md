# Local Admin API

## Conventions

- Base URL: `http://127.0.0.1:15101/api/v1`.
- JSON request and response bodies use UTF-8 `application/json`; request bodies are capped at 64 KiB.
- Mutations are idempotent where an idempotency key is practical.
- Complete credentials are write-only.

## Authentication and Browser Security

- Bind only to loopback and reject unexpected `Host` and `Origin` values.
- Disable CORS.
- `POST /session` exchanges the valid control-token bearer for an HttpOnly `SameSite=Strict` cookie and a CSRF token.
- Browser reads require the session cookie; browser mutations additionally require `X-CRP-CSRF`. CLI bearer mutations do not require CSRF.
- CLI uses a `0600` local control token.
- Read endpoints return only the positive public provider/worker allowlists and `credentialConfigured`; credential references and complete or partial secrets are omitted.
- Unexpected `Host`, nonmatching `Origin`, every CORS preflight, and every `/api` path outside the versioned route table are rejected.

## Error Format

```json
{
  "error": {
    "code": "PROVIDER_NOT_READY",
    "message": "The provider has not passed its compatibility test.",
    "action": "Test the provider successfully before activating it.",
    "requestId": "local-request-id",
    "details": {}
  }
}
```

`details` uses a small positive allowlist for safe validation and committed-state fields. Sensitive field names remain visible only with `[REDACTED]`; unknown detail fields are omitted. Known paths with an unsupported method return `405 API_METHOD_NOT_ALLOWED`, while unmatched API paths return `404 API_NOT_FOUND`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/session` | Exchange the local control-token bearer for a browser session and CSRF token |
| GET | `/status` | Supervisor, worker, Codex bootstrap, and active-provider status |
| GET | `/providers` | List masked provider summaries |
| POST | `/providers` | Create a profile and write its credential |
| GET | `/providers/:id` | Read one masked profile |
| PATCH | `/providers/:id` | Update metadata and optionally replace its credential |
| DELETE | `/providers/:id` | Delete an inactive profile and credential |
| POST | `/providers/:id/test` | Run connection and Responses compatibility tests |
| POST | `/providers/:id/activate` | Atomically activate a tested profile |
| POST | `/proxy/start` | Start worker on the fixed proxy port |
| POST | `/proxy/stop` | Gracefully stop worker |
| POST | `/proxy/restart` | Drain, stop, release port, restart, and health-check worker |
| GET | `/activity` | Page through sanitized lifecycle activity |
| GET | `/settings` | Read non-secret local settings |
| PATCH | `/settings` | Return `409 SETTINGS_READ_ONLY` while V1 fixed settings have no supported mutation |
| POST | `/codex/bootstrap` | Privately create or idempotently update the fixed Codex provider/proxy entry; only a changed existing file is backed up |
| POST | `/diagnostics/export` | Return in-memory diagnostic summary metadata; no bundle, file, or download is created |

## Request Contracts

- `POST /providers`: `{ "provider": { ...public input fields }, "credential": "write-only" }`; unknown fields, including any fallback selector, are rejected.
- `PATCH /providers/:id`: `{ "patch": { ...editable fields }, "replacementCredential"?: "write-only" }`.
- `POST /providers/:id/test`: `{ "model": "non-empty-model" }`.
- `PATCH /settings`: a schema-valid boolean `captureEnabled` shape always returns `409 SETTINGS_READ_ONLY` without mutation; malformed shapes fail validation.
- Session exchange, delete, activate, proxy lifecycle, Codex bootstrap, and diagnostics export require an empty body.
- Root objects reject unknown fields. Malformed JSON returns `400 API_BODY_INVALID`, unsupported media types return `415 API_CONTENT_TYPE_UNSUPPORTED`, and oversized input returns `413 API_BODY_TOO_LARGE`.

`GET /activity` accepts one bounded `limit` from 1 through 100 and one `offset` from 0 through 9999. It returns `{ events, page: { limit, offset, nextOffset } }` with newest events first.

Provider compatibility failures are successful HTTP exchanges: `POST /providers/:id/test` returns HTTP `200` with `{ "result": { "ok": false, "code": "PROVIDER_TEST_AUTH" } }` for upstream 401/403 authentication rejection. `PROVIDER_TEST_AUTH` is not an Admin error envelope.

CLI Supervisor discovery uses a 2-second `/status` liveness probe, but the authenticated client returned after discovery uses a separate 30-second operation timeout. The probe deadline must not become the deadline for provider tests or other normal Admin operations.

`POST /diagnostics/export` retains its compatibility path but returns only `{ "diagnostics": { "created": true, "generatedAt": "ISO timestamp", "eventCount": 0 } }`. The summary is generated in memory from sanitized Activity metadata and has no path, body content, bundle, persisted artifact, or download URL.

`POST /codex/bootstrap` keeps the response shape `{ "result": { "changed": true|false, "backupCreated": true|false } }`. A missing private `.codex` parent/config is created atomically with no backup; on POSIX the new directory/file modes are `0700`/`0600`. Existing files retain lock, identity/race, changed-file backup, mode-preservation, and byte-idempotency behavior. The endpoint exposes only these stable failures: `CODEX_CONFIG_PARENT_UNSAFE`, `CODEX_CONFIG_BUSY`, `CODEX_CONFIG_CHANGED`, `CODEX_CONFIG_READ_FAILED`, and `CODEX_CONFIG_WRITE_FAILED`; messages, actions, details, and request IDs remain public allowlists and never include paths, bytes, backup names, temporary names, causes, stacks, or credentials.

## Static UI Boundary

The Admin server serves the implemented packaged `index.html`, `styles.css`, and `app.js` only, with explicit MIME types, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Extensionless client routes fall back to `index.html`; unknown asset extensions, unsafe decoded paths, and non-GET/HEAD UI methods are rejected.

The UI exchanges the `crp ui` launch fragment through `POST /session`, removes and clears that fragment token, and keeps the returned CSRF value in memory. A valid cookie without a launch fragment may call GET endpoints only; every mutation control is disabled until a fresh `crp ui` launch. Failed exchange and later session/CSRF authentication failures terminate API use for that tab rather than attempting refresh.

## State Conflict Rules

- Activating an untested or failed provider returns `409 PROVIDER_NOT_READY`.
- Updating or deleting the active provider returns `409 PROVIDER_ACTIVE`, even when the worker is stopped; activate another provider first.
- Lifecycle commands already in progress return their current operation instead of starting a second one.

## Contract Change Rules

Update this document and contract tests in the same change. Breaking API changes require a new `/api/vN` prefix and a migration path for the bundled UI and CLI.

The completed core-first slice and `4bbb97c` corrections change no endpoint, request schema, response schema, registry schema, or API version. CLI locale, start-stage, and discovery/operation timeout behavior are adapter contracts, while structured proxy URL joining is a data-plane correction; none adds an Admin response field.
