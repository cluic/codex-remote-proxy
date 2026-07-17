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
- `POST /session/resume` accepts only an existing valid browser cookie, exact `Origin`, and `X-CRP-Session-Resume: 1`; it rejects bearer auth, query/body input, rotates session and CSRF values, and preserves the original absolute expiry.
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
| POST | `/session/resume` | Explicitly restore management from a still-valid cookie session without extending expiry |
| GET | `/status` | Supervisor, worker, Codex bootstrap, and active-provider status |
| GET | `/providers` | List positive public provider summaries without credential values or references |
| POST | `/providers` | Create a profile and write its credential |
| GET | `/providers/:id` | Read one masked profile |
| PATCH | `/providers/:id` | Update metadata and optionally replace its credential |
| DELETE | `/providers/:id` | Delete an inactive profile and credential |
| POST | `/providers/:id/test` | Run connection and Responses compatibility tests |
| GET | `/providers/:id/models` | Read the bounded cached model catalog without upstream traffic |
| POST | `/providers/:id/models` | Refresh the bounded model catalog from the provider |
| POST | `/providers/:id/activate` | After strict Codex readiness, atomically switch a tested profile and start the Worker when stopped |
| POST | `/proxy/start` | Start worker after serialized Codex-readiness validation |
| POST | `/proxy/stop` | Gracefully stop worker |
| POST | `/proxy/restart` | Validate Codex readiness, drain, restart, and health-check worker |
| GET | `/activity` | Page through sanitized lifecycle activity |
| GET | `/metrics/overview` | Read bounded anonymous operational aggregates for the local Overview |
| GET | `/settings` | Read non-secret local settings |
| PATCH | `/settings` | Return `409 SETTINGS_READ_ONLY` while V1 fixed settings have no supported mutation |
| POST | `/codex/bootstrap` | Create/update the fixed Codex entry and forward-repair historical provider metadata when required |
| POST | `/diagnostics/export` | Return in-memory diagnostic summary metadata; no bundle, file, or download is created |

## Request Contracts

- `POST /providers`: `{ "provider": { ...public input fields }, "credential": "write-only" }`; unknown fields, including any fallback selector, are rejected.
- `PATCH /providers/:id`: `{ "patch": { ...editable fields }, "replacementCredential"?: "write-only" }`.
- `POST /providers/:id/test`: `{ "model": "non-empty-model", "activateIfNone"?: true|false }`; omitted `activateIfNone` is `false`.
- `GET /providers/:id/models`: no request body. It returns the current cache projection and performs no provider request.
- `POST /providers/:id/models`: an empty body. It performs an authenticated `GET <provider-base>/models` refresh with redirects disabled, persists a successful bounded catalog, and returns its public projection.
- `PATCH /settings`: a schema-valid boolean `captureEnabled` shape always returns `409 SETTINGS_READ_ONLY` without mutation; malformed shapes fail validation.
- Session exchange, delete, activate, proxy lifecycle, Codex bootstrap, and diagnostics export require an empty body.
- Root objects reject unknown fields. Malformed JSON returns `400 API_BODY_INVALID`, unsupported media types return `415 API_CONTENT_TYPE_UNSUPPORTED`, and oversized input returns `413 API_BODY_TOO_LARGE`.

`GET /activity` accepts one bounded `limit` from 1 through 100 and one `offset` from 0 through 9999. It returns `{ events, page: { limit, offset, nextOffset } }` with newest events first.

`GET /metrics/overview` accepts exactly one optional `window` value, `24h` or `7d`, and defaults to `24h`. It is a read endpoint available to both Manage and valid cookie-only read-only sessions. It performs no upstream request, does not depend on Capture, and requires no CSRF token. Repeated or unknown query fields are rejected.

The response is `{ metrics }`. `metrics` contains `window`, `bucketMinutes: 60`, `storageState: "ready|degraded|unavailable"`, `summary`, bounded `series`, bounded `providers`, bounded `models`, and `dataQuality`. Summary result keys use only `success`, `upstreamRejected`, `upstreamError`, `timeout`, `networkError`, and `clientAbort`. Token totals are accumulated only when both upstream input and output usage are valid integers; `observedRequests` supplies coverage and unknown usage is never projected as zero coverage. Duration and response-start values are fixed histogram upper bounds, not exact timings; response start is observed at the first non-empty upstream response-body chunk rather than response headers.

The response contains no request ID, URL, method, status text, header, body, session/thread ID, credential, raw error, or exact request timestamp. At most 168 hourly series buckets, 16 Providers, and 16 models are returned; overflow remains represented through aggregate counters. Metrics persistence failure degrades this endpoint but never fails or delays a proxied request or Worker lifecycle operation.

Provider compatibility failures are successful HTTP exchanges: `POST /providers/:id/test` returns HTTP `200` with `{ "result": { "ok": false, "code": "PROVIDER_TEST_AUTH", "initialActivation": null } }` for upstream 401/403 authentication rejection. `PROVIDER_TEST_AUTH` is not an Admin error envelope. Every test response now includes `initialActivation`, either null or `{ "automatic": true, "activeProviderId": "provider-id", "workerStarted": false }`.

`activateIfNone` is an opt-in lifecycle request used by the CLI and conditional Web Setup. A successful test attempts a registry compare-and-set only when no provider is active and the Worker is stopped. Exactly the first candidate wins; the operation selects `activeProviderId` but never starts or reconfigures the Worker. A failed compatibility result does not select anything. The default remains `false`, including ordinary Provider-page compatibility tests. If selection was requested while no provider is active but the Worker is not stopped, the request fails before upstream traffic with `409 PROVIDER_INITIAL_ACTIVATION_UNSAFE`.

If the test state is durably saved but its Activity record fails, the route returns `PROVIDER_TEST_COMMITTED_DEGRADED` with `{ committed: true, degraded: true }`. The same top-level code wraps a committed provider-registry lock cleanup failure while preserving the registry error's safe repair action. The saved test result remains authoritative, but `activateIfNone` is not attempted; follow the returned action and inspect provider/status state before retrying.

Both model-catalog routes return:

```json
{
  "modelCatalog": {
    "providerId": "provider-id",
    "state": "missing|fresh|stale",
    "fetchedAt": "ISO timestamp or null",
    "expiresAt": "ISO timestamp or null",
    "models": ["bounded-model-id"]
  }
}
```

The refresh accepts at most 1 MiB of JSON and at most 2,000 unique model IDs, each at most 256 code points. The private cache is independently capped at 512 provider entries and 16 MiB. A candidate that would exceed either cache bound fails as `400 PROVIDER_MODEL_CACHE_INPUT_INVALID` before persistence. An existing cache file over 16 MiB fails strict refresh as `500 PROVIDER_MODEL_CACHE_INVALID`, while cache-only reads fail closed to the `missing` projection. The request forwards only the provider's configured authentication and safe extra headers, never follows redirects, and stores no credential. Every model ID is checked against the complete credential used for that request; any ID containing that exact credential is rejected as an invalid provider response before cache persistence or public projection. A failed refresh returns a stable `PROVIDER_MODELS_*` or `PROVIDER_MODEL_CACHE_*` error without clearing a prior good cache and without changing provider test, active-provider, or Worker state. A changed source fingerprint makes the prior entry read as `missing`.

If the cache replacement succeeds but its Activity success record fails, refresh returns `PROVIDER_MODELS_COMMITTED_DEGRADED` with `{ committed: true, degraded: true }`. The same top-level code wraps a committed model-cache lock cleanup failure while preserving the cache error's safe repair action. The new cached catalog remains committed and must not be misreported or retried as a network failure.

CLI Supervisor discovery uses a 2-second `/status` liveness probe, but the authenticated client returned after discovery uses a separate 30-second normal-operation timeout. The CLI gives only `POST /codex/bootstrap` a bounded 300-second override for large local history snapshots and repair. The probe deadline must not become the deadline for provider tests or bootstrap.

Human CLI formatting is an adapter above these responses. `provider list` positively selects count, active marker, name/ID, query/hash-free base URL, test, model, and credential-configured state. `status` selects Supervisor PID/start time; Worker phase/PID/generation/listening/in-flight state; active provider; and Codex identity/proxy state. Dynamic terminal text is bounded and control/bidirectional escaped. CLI `provider test`, `activate`, `delete`, and `models` accept `--id` or `--name`. A name is resolved case-insensitively through `GET /providers`, then revalidated through `GET /providers/:id` before the same ID-addressed operation is called. This is a CLI snapshot guard, not an atomic server-side name selector; the Admin route contract remains ID-based. CLI `provider models` calls the refresh route, while V8 Web uses cached GET reads on detail/setup entry and explicit POST refresh actions. A two-stage add whose test reports committed degradation returns `PROVIDER_ADD_TEST_COMMITTED_DEGRADED`, preserving a safe underlying action, request ID, and `{ committed: true, degraded: true }`; ordinary stage-two operational failure remains `PROVIDER_ADD_TEST_FAILED` with creation committed. Layered help performs no Admin request. `/proxy/stop` still stops only the Worker, while CLI `shutdown` terminates the owning Supervisor outside the Admin route table.

`POST /diagnostics/export` retains its compatibility path but returns only `{ "diagnostics": { "created": true, "generatedAt": "ISO timestamp", "eventCount": 0 } }`. The summary is generated in memory from sanitized Activity metadata and has no path, body content, bundle, persisted artifact, or download URL.

`GET /status` projects Codex as `{ configured, historyRepairPending, modelProvider, proxyUrl }`. A pending repair, config lock, unsafe path or identity, invalid UTF-8, or malformed/ambiguous selected-provider binding is never ready. Provider activation, Worker start/restart, and unexpected-exit recovery serialize with bootstrap through the same FIFO Codex gate and recheck readiness before lifecycle mutation or spawn. Explicit Admin operations fail `409 CODEX_NOT_READY` without calling the provider lifecycle; automatic recovery remains bounded in backoff and never exposes the private readiness failure.

`POST /codex/bootstrap` adds a bounded `historyRepair` object to `{ changed, backupCreated }`: booleans `required`, `completed`, `resumed`, `backupCreated`, and `encryptedContentDetected`, plus `rolloutFiles`, `rolloutRecords`, `sqliteFiles`, and `sqliteRows` integers from 0 through 1,000,000. It never returns a path, session/thread ID, body, SQL value, URL, backup name, or credential.

A missing private `.codex` parent/config is created atomically with no history scan or backup; on POSIX the new directory/file modes are `0700`/`0600`. Existing files retain strict no-follow identity checks, a dead-owner-recoverable managed lock, durable changed-file backup, mode preservation, and byte idempotency. Inspection and patching share one semantic TOML statement scanner for the root `model_provider` and its selected provider `base_url`, including supported quoted and dotted bindings; this is intentionally not a whole-document TOML validator. A byte-invalid or ambiguous selected binding fails before backup, journal, or config writes.

The repair decision compares normalized effective URLs, not provider names. A same-URL provider-name change performs no history repair; a different or missing existing effective URL triggers history discovery. Only a nonempty write set creates snapshots and durably publishes `pending.json` before config publication; an already aligned history set uses a config-only commit with no journal or history backup. Clearing uses the discoverable `pending.json.clearing` state, and source- or target-hash retries resume forward. Rollout replacements publish byte-exact backups atomically, apply mode/timestamps before rename, and fsync affected parent directories; SQLite uses exclusive fsynced Online Backup API snapshots and exact row predicates. The target config hash and config-lock ownership are rechecked before history mutation and before pending clear.

Stable failures add `CODEX_CONFIG_COMMITTED_DEGRADED`, `CODEX_HISTORY_REPAIR_INVALID`, `CODEX_HISTORY_REPAIR_CONFLICT`, `CODEX_HISTORY_REPAIR_FAILED`, and `CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED`. A config-only post-publication uncertainty exposes `{ committed: true, degraded: true, pending: false }`; a committed history-repair uncertainty exposes `{ committed: true, degraded: true, pending: true }` and preserves a discoverable pending marker or the config lock. All messages, actions, and request IDs remain static allowlists.

## Static UI Boundary

The Admin server serves the implemented packaged `index.html`, `styles.css`, and `app.js` only, with explicit MIME types, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`; `/favicon.ico` returns an empty `204` without adding a package asset. The responsive bilingual React + TypeScript source under `node/ui-src/` is compiled by Vite at development time and is not a runtime route or published source tree. The exact output has no dynamic chunks, source maps, remote assets, inline scripts/styles, telemetry, or frontend server. Extensionless client routes fall back to `index.html`; unknown asset extensions, unsafe decoded paths, and non-GET/HEAD UI methods are rejected.

The UI exchanges the `crp ui` launch fragment through `POST /session`, removes and clears that fragment token, and keeps the returned CSRF value in memory. A valid cookie without a launch fragment initially exposes GET endpoints only. An explicit user action may call `/session/resume`; success rotates the cookie session and in-memory CSRF without reading the control token or extending expiry, while expiry remains terminal and requires a fresh `crp ui` launch. Ordinary mutations always require the current CSRF token.

Conditional Setup derives progress from authoritative Provider, Codex, and Worker facts. Its first-provider path is `POST /providers` → `POST /providers/:id/test` with `activateIfNone: true` → `POST /codex/bootstrap` → `POST /proxy/start`. The successful test performs only the Worker-free compare-and-set selection; Setup does not call explicit activation. If a previously tested Provider is still unselected, Setup repeats the compatibility test with `activateIfNone: true` before Codex bootstrap.

The permanent Web navigation is Overview, Providers, disabled Forwarding Records, Activity, and System. Forwarding Records is an inert placeholder with no route or request. Overview reads `/metrics/overview` independently from Capture. Credentials remain blank write-only values: the UI clears state and the current DOM value before validation, request dispatch, or re-rendering.

## State Conflict Rules

- Activating an untested or failed provider returns `409 PROVIDER_NOT_READY`.
- Explicit activation applies the tested Provider snapshot to a running Worker or starts a stopped Worker. It is not a selection-only operation.
- Updating or deleting the active provider returns `409 PROVIDER_ACTIVE`, even when the worker is stopped; activate another provider first.
- Lifecycle commands already in progress return their current operation instead of starting a second one.

## Contract Change Rules

Update this document and contract tests in the same change. Breaking API changes require a new `/api/vN` prefix and a migration path for the bundled UI and CLI.

Historical note: the completed core-first and V5 slices changed no endpoint or response schema. M2C/V6 added `GET`/`POST /providers/:id/models`, optional test input `activateIfNone`, and the always-present `initialActivation` test-result field. M2D/V7 added bounded Codex history-repair result fields. M2E/V8 remains additive under `/api/v1`: it adds read-only `GET /metrics/overview` and uses the existing optional `activateIfNone` field from Setup. Registry schema 2, authentication rules, fixed addresses, and the API version remain unchanged.
