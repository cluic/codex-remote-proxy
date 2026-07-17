# Data Model

Tasks 3 through 11 implemented strict schema-version-2 provider metadata persistence, a required public native credential adapter plus a lower-level injected private file adapter, immutable runtime snapshots, strict worker IPC, bounded activity, transactional migration, provider-service orchestration, and positive projections consumed by the packaged bilingual UI. M2C/V6 adds a separate schema-version-1 provider-model cache without changing `ProviderProfile` or registry schema 2. M2D/V7 adds private Codex history-repair journal/backup state without changing either provider schema.

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

The registry also provides compare-and-set helpers for CLI-requested initial selection. `setActiveIfNull(id)` changes `activeProviderId` only when it is null, so concurrent successful tests have exactly one winner. `clearActiveIf(id)` is used only for ownership-proven compensation. Neither operation starts or configures the Worker.

## ProviderModelCacheDocument

Model catalogs are persisted independently at `~/.codex-remote-proxy/provider-model-cache.json` so adding this feature does not migrate or widen registry schema 2:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "providerId": "provider-id",
      "sourceFingerprint": "sha256:64-lowercase-hex-characters",
      "fetchedAt": "2026-07-16T00:00:00.000Z",
      "models": ["model-id"]
    }
  ]
}
```

The document and every entry use exact fields. The file is capped at 16 MiB and contains at most 512 entries. A new candidate over either limit is rejected as input-invalid before persistence; a preexisting file over the byte cap is strict-invalid for mutation and projects `missing` on the fail-closed read path. Provider IDs are unique and bounded to 128 code points. Each entry contains at most 2,000 unique, trimmed model IDs; each ID is non-empty, free of C0/C1 controls, at most 256 code points, and must not contain the complete provider credential used for discovery. Credential-echo validation occurs before persistence so an upstream cannot smuggle a key into cache, API, or CLI output. `sourceFingerprint` hashes only normalized request-routing metadata (`baseUrl`, authentication header/scheme, and sorted extra headers), never the credential. A source-setting change makes the old entry read as `missing`; credential replacement and provider deletion remove the corresponding entry.

The public projection is `{ providerId, state, fetchedAt, expiresAt, models }`. A matching entry is `fresh` for 24 hours, `stale` until 30 days after fetch, then projects as `missing`; `missing` has null timestamps and an empty list. Reads do not contact the provider. A successful explicit refresh replaces one entry, while a failed refresh leaves the last good document unchanged.

Cache mutations use an exclusive `0600` sidecar lock, strict reload-before-mutate validation, an exclusive same-directory `0600` temporary file, file `fsync`, `chmod 0600`, and atomic rename. Durable rename followed by lock-cleanup failure is reported as committed/degraded and preserves the cache-lock repair action; a later Activity failure is also reported as `PROVIDER_MODELS_COMMITTED_DEGRADED` without undoing the saved cache. Activity recording is best-effort once a primary committed error exists, so it cannot replace the authoritative error. An instance with an uncertain residual lock blocks later mutation until explicit repair and restart. Cache data contains model identifiers and a non-secret source fingerprint only; credentials, credential references, response metadata, and arbitrary upstream fields are not persisted.

## Codex History Repair State

Private `.codex/.crp-history-repair/pending.json` is exact schema version 1 and contains only its manager identifier, operation ID, source/target config SHA-256 hashes, target provider `OpenAI`, and creation time. During durable deletion it may exist instead at the fixed `pending.json.clearing` path; both paths together are a conflict, and either path alone blocks readiness. If post-delete directory durability fails, CRP reconstructs the canonical marker; if no marker can be restored, it retains the config lock. The journal contains no URL, path, session/thread ID, message, model response, SQL value, or credential.

Each managed operation has an exact private backup directory. Rollout backups are byte-identical regular files published exclusively through same-directory atomic replacement; existing backups are trusted only after exact no-follow byte validation. Replacement rollout metadata is applied and fsynced before rename, and successful final verification fsyncs every affected rollout parent directory. SQLite snapshots use the Online Backup API into a CRP-owned precreated inode, publish the completed snapshot through an exclusive hard link, and bind updates to the inspected row set. Mutable canonical SQLite files must have exactly one hard link. Repeated attempts may add immutable snapshots before touching newly discovered state, but no attempt may mutate a resource it did not durably back up.

The separate config sidecar lock records exact owner PID/start/instance identity, phase `acquired|prepared|completed`, and optional operation/hash binding. Only a matching dead-owner state can be recovered automatically. Its presence makes public readiness false. Target config bytes are hash-checked after publication, before history writes, after final verification, and before pending clear. Repair mutates only active/archive `session_meta.payload.model_provider` and supported SQLite `threads.model_provider`. It does not change messages, encrypted content, session indexes, cwd, titles, models, `has_user_event`, global workspace state, provider registry/cache, or credentials.

## Lower-Level CredentialDocument

The private file adapter persists exactly this schema and exposes only `set`, `get`, `has`, and `delete` operations by opaque reference. It is not selectable through current UI, CLI, Admin API, or ordinary Supervisor startup; only trusted dependency injection can reach it:

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

The native adapter lazily loads the addon during construction and stores the same opaque reference under service `org.cluic.codex-remote-proxy`. Public Supervisor startup requires native construction and fails closed when it is unavailable. The lower-level factory can select the file adapter only through trusted injected options; no public consent input exists today. Once native is selected, backend-unavailable reads and mutations fail without file replay. Any future startup consent is L3 work, and Task 4 performs no automatic credential migration.

## RuntimeSettingsSnapshot

A runtime snapshot contains exactly one positive safe-integer `generation` and one plain-data `settings` graph. Applying a snapshot validates its generation, clones its settings, deeply freezes the clone, and replaces the active reference only after all prior work succeeds. Equal or lower generations are stale; invalid, unclonable, or non-plain settings leave the prior reference unchanged.

The private Supervisor snapshot additionally carries the selected `providerId` outside Worker settings. It is never sent with credentials to the Worker. WorkerManager retains a bounded generation-to-Provider mapping so a request that began on generation A remains attributed to Provider A after generation B is activated.

`current()` returns the frozen active reference. `publicState()` returns only `{ configured, generation }`, both before and after configuration. A proxied request captures `current()` exactly once before body listeners and retains that reference for its target, authentication, headers, TLS, timeout, capture context, and logging lifetime.

## MetricsAggregateDocument

`~/.codex-remote-proxy/metrics.json` is an independent strict schema-version-1 anonymous aggregate document. It contains at most 168 UTC hourly buckets covering seven days. Each bucket stores only fixed result counts, Token totals and observed-request count, fixed latency histograms, bounded Provider aggregates, bounded model-ID request counts, and overflow/data-quality counters.

Worker observations are not persisted individually. They contain only generation, one fixed result enum, a bounded model ID or null, a valid input/output Token pair or null, and fixed histogram-bin indexes. Before a model ID can cross IPC, it is trimmed, control-free, bounded to 256 code points, and rejected if it contains the complete active credential or configured extra-header value. No other request-derived string is allowed.

Supervisor owns aggregation and persistence. At most 32 Providers and 64 models are retained per hour; extra cardinality contributes only to overflow counters. Public projection is further bounded to 16 Providers, 16 models, and 168 series buckets. Exact durations are never stored; p50/p95 are represented by histogram upper bounds. The strict file is capped at 32 MiB so every valid maximum-cardinality seven-day document remains persistable, private on POSIX, atomically replaced after a debounce, and treated as reconstructable. Corrupt, unsafe, oversized, or unwritable state degrades Metrics without blocking Supervisor startup, proxy forwarding, provider switching, or shutdown.

## CaptureRuntimeConfigState

Capture runtime reconciliation is in-memory operational state, not a new registry or database schema. It retains the desired normalized `{ enabled, dbPath }`, the currently active database path, `restartRequired`, and one SHA-256 fingerprint of the runtime-config file bytes (or a stable read-error code). The fingerprint never represents SQLite or captured request/response content.

`start()` is idempotent. It establishes the content fingerprint synchronously, immediately reloads the runtime config to reconcile a rewrite that occurred during startup, and then polls content every 500 ms; changes are debounced for 100 ms before reload. If `dbPath` changes while a database is active, the desired path changes and `captureRestartRequired` becomes true while `captureRuntimeDbPath` continues to identify the active database until restart. `close()` clears the polling interval, pending debounce, and fingerprint before closing the database.

The existing public capture projection remains `{ captureConfigured, captureActive, captureDbPath, captureRuntimeDbPath, captureState, captureRestartRequired, failedWriteCount, lastWriteErrorAt, lastWriteErrorMessage, captureLastErrorAt, captureLastErrorMessage }`; no fingerprint or timer handle is public or persisted.

## WorkerProtocolMessage

Every IPC message has exactly `{ version: 1, type, requestId, ...typeFields }`. Parent messages are `configure`, `drain`, `shutdown`, and `status`; only `configure` adds `{ generation, settings }`, and it is the only message allowed to carry resolved credentials. Child messages are `ready`, `configured`, `drained`, `status`, `fatal`, and `metric`. Lifecycle messages expose only an exact public worker state `{ phase, configured, generation, listening, listenHost, listenPort, inFlight }`; fatal messages expose a stable code and static public message without causes or input payloads. Metric messages use the fixed `metric-observation` request ID and the exact anonymous observation described by `MetricsAggregateDocument`; protocol sanitization deliberately omits the observation payload.

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
- Each provider has zero or one independent cached model-catalog entry; the entry is usable only when its source fingerprint matches current request settings.
- A runtime snapshot references one provider and one resolved credential; each request retains its starting snapshot for the request lifetime.

## Lifecycle and Deletion

The provider service now implements the following lifecycle behavior:

- A profile must pass a Responses compatibility test before first activation.
- CLI compatibility tests may opt into initial selection when no provider is active. A successful test performs a first-wins compare-and-set only while the Worker is stopped and returns `{ automatic: true, activeProviderId, workerStarted: false }`; it does not start or reconfigure the Worker. Other callers default to no initial selection.
- Conditional Web Setup also opts into that same first-wins compare-and-set. Ordinary Provider-page tests do not select; an explicit Provider-card activation applies a snapshot to a running Worker or starts a stopped Worker.
- Updating or deleting the active profile is rejected until another profile is activated, even if the proxy worker is stopped.
- Deleting a profile removes its native credential entry and model-cache entry and writes an activity event.
- Model discovery is an independent authenticated `GET <base>/models` operation. It does not mark a Responses compatibility test, activate a provider, or mutate Worker state.
- Activity retention defaults to 30 days or 10,000 events, whichever limit is reached first.
- Proxy start and restart resolve only the active tested provider credential, advance the confirmed generation after worker acknowledgement and health, and return only worker public state. Stop is credential-free and idempotent.

## Migration

On the first supervisor start with pre-supervisor state, migration transaction-locks the legacy `config.json`, runtime `node/proxy-config.json`, and target registry paths; rejects symbolic links; reads regular sources through lstat/open-no-follow/fstat identity validation; and writes collision-safe byte-exact private backups. It converts the flat upstream to an inactive and untested provider named `Default`, moves the key to an opaque credential reference, validates schema version 2, and only then scrubs legacy secret fields. Backups remain available for an operator-controlled rollback.

If the validated legacy sources contain different credentials, migration stops as `MIGRATION_INPUT_INVALID` before backup creation, credential-store access, registry creation, or source mutation. Both sources remain byte-identical, and the sanitized Activity event carries the same stable code without either value.

Failure restores source bytes in reverse order and removes registry/credential state only when identity and bytes prove ownership by this transaction. Foreign replacements are preserved. Committed mutation errors are reconciled from disk, and lock uncertainty restores a canonical blocker. `MIGRATION_COMMITTED_DEGRADED`, `MIGRATION_COMMITTED_LOCK_DEGRADED`, and `MIGRATION_ROLLBACK_DEGRADED` require stop-and-repair handling rather than automatic retry. Existing valid schema version 2 is idempotently preserved; no automatic downgrade to the flat schema exists.
