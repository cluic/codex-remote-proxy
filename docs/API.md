# Local Admin API

## Conventions

- Base URL: `http://127.0.0.1:15101/api/v1`.
- JSON request and response bodies.
- Mutations are idempotent where an idempotency key is practical.
- Complete credentials are write-only.

## Authentication and Browser Security

- Bind only to loopback and reject unexpected `Host` and `Origin` values.
- Disable CORS.
- Establish a local SameSite session and require a CSRF token for mutations.
- CLI uses a `0600` local control token.
- Read endpoints return only `credentialConfigured` and a masked preview.

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

`details` must be sanitized and safe to display.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
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
| PATCH | `/settings` | Update supported settings with validation |
| POST | `/codex/bootstrap` | Back up and idempotently set the fixed Codex provider/proxy entry |
| POST | `/diagnostics/export` | Produce a redacted local diagnostic bundle |

## State Conflict Rules

- Activating an untested or failed provider returns `409 PROVIDER_NOT_READY`.
- Deleting the active provider returns `409 PROVIDER_ACTIVE`.
- Lifecycle commands already in progress return their current operation instead of starting a second one.
- Changing the fixed proxy port requires successful Codex bootstrap and an explicit UI warning.

## Contract Change Rules

Update this document and contract tests in the same change. Breaking API changes require a new `/api/vN` prefix and a migration path for the bundled UI and CLI.
