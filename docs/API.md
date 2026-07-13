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
    "code": "PROVIDER_AUTH_FAILED",
    "message": "The provider rejected the API key.",
    "action": "Update the API key and test again.",
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
| POST | `/codex/bootstrap` | Back up and idempotently set the fixed Codex provider/proxy entry |
| POST | `/diagnostics/export` | Produce a redacted local diagnostic bundle |

## Request Contracts

- `POST /providers`: `{ "provider": { ...public input fields }, "credential": "write-only", "fallbackConsent": false }`.
- `PATCH /providers/:id`: `{ "patch": { ...editable fields }, "replacementCredential"?: "write-only" }`.
- `POST /providers/:id/test`: `{ "model": "non-empty-model" }`.
- `PATCH /settings`: currently accepts only a boolean `captureEnabled` shape, then returns `409 SETTINGS_READ_ONLY` without mutation.
- Session exchange, delete, activate, proxy lifecycle, Codex bootstrap, and diagnostics export require an empty body.
- Root objects reject unknown fields. Malformed JSON returns `400 API_BODY_INVALID`, unsupported media types return `415 API_CONTENT_TYPE_UNSUPPORTED`, and oversized input returns `413 API_BODY_TOO_LARGE`.

`GET /activity` accepts one bounded `limit` from 1 through 100 and one `offset` from 0 through 9999. It returns `{ events, page: { limit, offset, nextOffset } }` with newest events first.

## Static UI Boundary

The Admin server supports only `index.html`, `styles.css`, and `app.js` with explicit MIME types, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Extensionless client routes fall back to `index.html`; unknown asset extensions, unsafe decoded paths, and non-GET/HEAD UI methods are rejected. The actual UI assets land in Task 11.

## State Conflict Rules

- Activating an untested or failed provider returns `409 PROVIDER_NOT_READY`.
- Deleting the active provider returns `409 PROVIDER_ACTIVE`.
- Lifecycle commands already in progress return their current operation instead of starting a second one.
- Changing the fixed proxy port requires successful Codex bootstrap and an explicit UI warning.

## Contract Change Rules

Update this document and contract tests in the same change. Breaking API changes require a new `/api/vN` prefix and a migration path for the bundled UI and CLI.
