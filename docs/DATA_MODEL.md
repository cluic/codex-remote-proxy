# Data Model

## ProviderProfile

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Immutable |
| `name` | string | Required, unique case-insensitively |
| `baseUrl` | HTTPS/HTTP URL | HTTP allowed only for loopback |
| `credentialRef` | opaque string | Points to a credential adapter entry |
| `authHeader` | string | Default `authorization` |
| `authScheme` | string | Default `Bearer` |
| `extraHeaders` | string map | Sensitive-looking names are rejected |
| `modelMode` | enum | `passthrough` or `override` |
| `modelOverride` | string/null | Required when mode is `override` |
| `lastTestAt` | ISO timestamp/null | Set after compatibility test |
| `lastTestStatus` | enum | `untested`, `passed`, `failed` |
| `lastTestCode` | string/null | Sanitized stable error code |
| `createdAt` / `updatedAt` | ISO timestamp | Supervisor-owned |

## RegistryDocument

```json
{
  "schemaVersion": 2,
  "activeProviderId": "uuid-or-null",
  "providers": [],
  "settings": {
    "proxyHost": "127.0.0.1",
    "proxyPort": 15100,
    "adminHost": "127.0.0.1",
    "adminPort": 15101,
    "captureEnabled": false
  }
}
```

## RuntimeState

Runtime state includes supervisor PID, worker PID, worker status, snapshot generation, start timestamps, restart count, and the last sanitized error. It is observational and can be reconstructed.

## ActivityEvent

Activity events record timestamp, category, action, provider ID, result, stable error code, and sanitized details. They never contain complete keys, authorization headers, cookies, or request/response bodies.

## Relationships

- One registry has zero or one active provider.
- Each provider has exactly one credential reference after it is saved.
- A worker snapshot references one provider and one resolved credential for its process lifetime.

## Lifecycle and Deletion

- A profile must pass a Responses compatibility test before first activation.
- Deleting the active profile is rejected until another profile is activated or the proxy is stopped.
- Deleting a profile removes its native credential entry and writes an activity event.
- Activity retention defaults to 30 days or 10,000 events, whichever limit is reached first.

## Migration

On first version-2 start, back up existing CRP files, convert the flat upstream to a provider named `Default`, move the API key into the selected credential backend, persist schema version 2, and verify the resulting profile before removing the old secret field. Migration must be transactional and recoverable from its backup.
