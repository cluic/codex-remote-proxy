# Data Model

Tasks 3 through 8 have implemented strict schema-version-2 provider metadata persistence, native and explicit-consent file credential adapters, immutable runtime snapshots, strict worker IPC, bounded activity, transactional migration, and provider-service orchestration.

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

## CredentialDocument

The explicit fallback adapter persists exactly this schema and exposes only `set`, `get`, `has`, and `delete` operations by opaque reference:

```json
{
  "schemaVersion": 1,
  "credentials": {
    "credential-ref": "secret-string"
  }
}
```

Credential references are non-empty bounded ASCII identifiers, prototype-pollution keys are rejected, and every stored value is a non-empty string. The document contains no provider metadata and there is no credential enumeration API.

Every file mutation acquires an exclusive `0600` sidecar lock, reloads and validates disk state under that lock, mutates a clone, writes a same-directory exclusive `0600` temporary file, fsyncs and closes it, reapplies mode `0600`, renames it over the destination, then replaces in-memory state. A failed write leaves disk and memory unchanged. Secret-temp removal receives bounded retries; a permanent residue reports `CREDENTIAL_STORE_TEMP_DEGRADED` with `committed: false`, records instance degradation, and blocks later mutations before any new lock or temporary file is opened.

Reads refresh from disk only after validating a real private parent directory and the credential file metadata. On POSIX the parent must be exactly `0700` and the regular file exactly `0600`; the file is opened with `O_NOFOLLOW`, when available, checked with `fstat` against pre-open and post-open identity, read by descriptor, and always closed. Windows omits unsupported no-follow flags but retains descriptor and identity validation.

Every mutation first acquires an exclusive same-directory protocol gate and a canonical primary lock before persistence. Release atomically renames the canonical gate directory to a unique claim path, verifies ownership there, and removes only a matching claim; the canonical gate path is never deleted after a separate identity check. The primary lock remains canonical throughout gate claim validation. A second instance may acquire the now-empty gate, but its primary acquisition reports busy and its own gate cleanup does not touch the first claim. A foreign gate claim is preserved, and exclusive canonical `mkdir` supplies a nonsecret blocker; `EEXIST` proves another blocker or owner already occupies the path. Primary release is permitted only after gate ownership or canonical blocker state is proven; otherwise the primary lock path is retained. Primary cleanup then claims the closed lock before reading its token. A foreign or permanent primary claim is preserved and linked back to the canonical path, or a nonsecret canonical blocker is created. Fresh instances therefore report busy instead of writing through degraded state.

The native adapter lazily loads the addon during construction and stores the same opaque reference under service `org.cluic.codex-remote-proxy`. Backend selection defaults to native. Explicit file selection requires `fallbackConsent === true`; consent permits construction-time file selection only when native cannot be created before any credential operation. Once native is selected, backend-unavailable reads and mutations fail without file replay. A construction-time fallback exposes backend label `file`; callers must reuse that explicit label after restart to remain in the same namespace. Task 4 performs no automatic credential migration.

## RuntimeSettingsSnapshot

A runtime snapshot contains exactly one positive safe-integer `generation` and one plain-data `settings` graph. Applying a snapshot validates its generation, clones its settings, deeply freezes the clone, and replaces the active reference only after all prior work succeeds. Equal or lower generations are stale; invalid, unclonable, or non-plain settings leave the prior reference unchanged.

`current()` returns the frozen active reference. `publicState()` returns only `{ configured, generation }`, both before and after configuration. A proxied request captures `current()` exactly once before body listeners and retains that reference for its target, authentication, headers, TLS, timeout, capture context, and logging lifetime.

## WorkerProtocolMessage

Every IPC message has exactly `{ version: 1, type, requestId, ...typeFields }`. Parent messages are `configure`, `drain`, `shutdown`, and `status`; only `configure` adds `{ generation, settings }`, and it is the only message allowed to carry resolved credentials. Child messages are `ready`, `configured`, `drained`, `status`, and `fatal`. Lifecycle messages expose only an exact public worker state `{ phase, configured, generation, listening, listenHost, listenPort, inFlight }`; fatal messages expose a stable code and static public message without causes or input payloads.

Configure settings use the exact runtime graph required by the forwarding server and reject unknown or malformed fields before any bind. Upstream URLs require HTTPS except for explicit loopback HTTP; authentication names and schemes are HTTP tokens, the exact scheme-plus-key value must satisfy Node header-value rules, and extra headers cannot be sensitive or collide case-insensitively with the configured authentication header. A worker accepts only increasing positive safe-integer generations through `RuntimeSettingsSource` while ready or running and rejects configure after drain begins. Drain completion is idempotent: repeated request IDs receive drained acknowledgements without changing the drained state. Protocol sanitization removes configure settings, projects lifecycle state through the public allowlist, maps fatal output to safe static errors, and uses `worker-fatal` instead of an unvalidated input request ID.

## RuntimeState

The implemented private state document is `{ schemaVersion: 1, supervisorPid, startedAt, admin, worker }`. `admin` is the ready loopback address and `worker` is the manager's exact public projection `{ phase, pid, generation, state, restartCount, startedAt, error }`. Nested `state` is the child protocol's public lifecycle state, and `error` is either null or a stable `{ code, message }`; snapshots, credentials, raw causes, argv, environment, stdout, and stderr are excluded. State is observational, atomically written with mode `0600` only after Admin readiness, and reconstructable.

## LocalAuthState

The control token and every session/CSRF token are independent 32-byte base64url values. Only the control token is persisted, in a descriptor-validated regular `0600` file below a private `0700` parent. Browser session IDs and CSRF tokens remain in memory with an expiry timestamp; the cookie is HttpOnly and `SameSite=Strict`. Public API data never includes the control token or session ID.

## ActivityEvent

Activity events persist the exact allowlist `{ timestamp, category, action, providerId, result, errorCode, details }`. Details are recursively serialized with cycles and non-JSON values bounded. Error messages/causes/stacks are omitted, and compacted authorization, cookie, token, secret, API-key, credential-ref, request/response-body, cause, stack, headers, and backup-path field names are redacted. Atomic `0600` JSONL replacement retains the newest 10,000 events no older than 30 days; lock initialization and release claim canonical state and remove only identity-proven ownership. Uncertainty restores a canonical blocker and stops later mutations.

## Relationships

- One registry has zero or one active provider.
- Each provider has exactly one credential reference after it is saved; public provider projections omit that reference.
- A runtime snapshot references one provider and one resolved credential; each request retains its starting snapshot for the request lifetime.

## Lifecycle and Deletion

The provider service now implements the following lifecycle behavior:

- A profile must pass a Responses compatibility test before first activation.
- Deleting the active profile is rejected until another profile is activated or the proxy is stopped.
- Deleting a profile removes its native credential entry and writes an activity event.
- Activity retention defaults to 30 days or 10,000 events, whichever limit is reached first.
- Proxy start and restart resolve only the active tested provider credential, advance the confirmed generation after worker acknowledgement and health, and return only worker public state. Stop is credential-free and idempotent.

## Migration

On first version-2 start, migration transaction-locks injected legacy paths, rejects symbolic links, reads regular sources through lstat/open-no-follow/fstat identity validation, and writes collision-safe byte-exact `0600` backups. It converts the flat upstream to an inactive and untested provider named `Default`, moves the key to an opaque credential reference, validates schema version 2, and only then scrubs legacy secret fields. Failure restores source bytes in reverse order and removes registry state only when the current identity and bytes match this transaction. Foreign replacements are preserved, committed mutation errors are reconciled from disk, and lock uncertainty restores a canonical blocker. Existing valid schema version 2 is idempotently preserved.
