# Data Model

Task 3 has implemented strict schema-version-2 provider validation and atomic metadata-registry persistence. Credential adapters, provider-service orchestration, and migration remain target-state work.

## ProviderProfile

| Field | Type | Rules |
| --- | --- | --- |
| `id` | opaque string | Stable, non-empty, and immutable |
| `name` | string | Required, unique case-insensitively |
| `baseUrl` | canonical HTTPS/HTTP URL | C0/DEL rejected before parsing; HTTP allowed only for loopback |
| `credentialRef` | opaque string | Points to a credential adapter entry; immutable after profile creation |
| `authHeader` | string | Default `authorization` |
| `authScheme` | string | Default `Bearer`; empty for raw keys, otherwise an HTTP token |
| `extraHeaders` | string map | Sensitive compacted names and values rejected by Node header validation are not allowed |
| `modelMode` | enum | `passthrough` or `override` |
| `modelOverride` | string/null | Required when mode is `override` |
| `lastTestAt` | ISO timestamp/null | Set after compatibility test and bounded by `createdAt` / `updatedAt` |
| `lastTestStatus` | enum | `untested`, `passed`, `failed` |
| `lastTestCode` | string/null | Sanitized stable error code |
| `createdAt` / `updatedAt` | ISO timestamp | Supervisor-owned |

## RegistryDocument

```json
{
  "schemaVersion": 2,
  "activeProviderId": "provider-id-or-null",
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

The implemented registry accepts only complete schema-version-2 documents with the exact fixed settings above. Provider IDs and case-folded names must be unique, and a non-null `activeProviderId` must reference an existing profile. A missing file starts as this empty document in memory and is created only by the first successful mutation.

Every mutation acquires an exclusive `0600` sidecar lock, reloads the registry while holding that lock, validates a cloned complete document, writes it through a same-directory exclusive `0600` temporary file, fsyncs the file, and renames it over the registry before replacing in-memory state and releasing the lock. Registry reads refresh committed disk state and return defensive copies. Automatic schema migration is not part of Task 3.

Lock close and removal receive bounded cleanup retries. Cleanup failure never masks an earlier mutation failure; permanent cleanup failure after a durable rename reports a non-retryable committed/degraded error while retaining the committed disk and in-memory state. An instance that records a permanent residual lock never inspects or auto-removes that path; explicit operator repair and restart are required.

Changing `baseUrl`, authentication fields, extra headers, or model policy resets the compatibility-test state to `untested`; changing only the display name preserves it. Credential replacement can explicitly record the same reset. Public provider projection uses an explicit field allowlist and requires a boolean credential-configured flag.

## RuntimeState

Runtime state includes supervisor PID, worker PID, worker status, snapshot generation, start timestamps, restart count, and the last sanitized error. It is observational and can be reconstructed.

## ActivityEvent

Activity events record timestamp, category, action, provider ID, result, stable error code, and sanitized details. They never contain complete keys, authorization headers, cookies, or request/response bodies.

## Relationships

- One registry has zero or one active provider.
- Each provider has exactly one credential reference after it is saved.
- A worker snapshot references one provider and one resolved credential for its process lifetime.

## Lifecycle and Deletion

The following provider-service lifecycle behavior remains target state; Task 3 implements only profile test-state recording, active-ID persistence, active-profile delete rejection, and inactive-profile metadata deletion.

- A profile must pass a Responses compatibility test before first activation.
- Deleting the active profile is rejected until another profile is activated or the proxy is stopped.
- Deleting a profile removes its native credential entry and writes an activity event.
- Activity retention defaults to 30 days or 10,000 events, whichever limit is reached first.

## Migration

On first version-2 start, back up existing CRP files, convert the flat upstream to a provider named `Default`, move the API key into the selected credential backend, persist schema version 2, and verify the resulting profile before removing the old secret field. Migration must be transactional and recoverable from its backup.
