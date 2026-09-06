![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy

Codex Remote Proxy (CRP) keeps Codex signed in with ChatGPT while routing model traffic through a weighted pool of OpenAI-compatible providers. Codex continues to use the built-in `OpenAI` provider identity, so changing upstream priority does not move existing OpenAI-tagged threads.

[简体中文](./README.zh-CN.md)

> Release status: the npm `latest` dist-tag is authoritative. Ordinary product updates use patch releases; minor or major bumps require an explicit release-policy change.

## Install

Node.js 22.13 or newer is required.

```bash
npm install -g @cluic/codex-remote-proxy
```

The ordinary-user entry point is:

```bash
crp ui
```

Without a global install:

```bash
npx @cluic/codex-remote-proxy ui
```

`crp ui` starts or discovers the local supervisor and opens the management UI. A saved explicit language choice wins; otherwise the interface uses the first supported Chinese or English browser/system preference and falls back to English. Inferred language is not persisted.

The management UI is implemented in `node/ui-src/` with Next.js App Router, React, TypeScript, Tailwind CSS, shadcn source components backed by Base UI, and Lucide icons. The default Webpack build produces a reviewed static export and asset manifest under `node/ui/`; the package needs no frontend runtime server and the Admin server serves every route and chunk from the same loopback origin. The UI uses no remote font, CDN, telemetry, or source map. Clean Ubuntu Node 22 is the canonical build environment: release gates compare its generated output with the checkout before any candidate build replaces `node/ui/`. Linux, macOS, and Windows validate the committed source digest, manifest, CSP, resources, package allowlist, and their platform-specific tests.

## What You Can Manage

The local UI supports the complete daily workflow:

- create named provider profiles;
- start from maintained built-in presets, currently including OpenRouter at `https://openrouter.ai/api/v1`, or choose a custom OpenAI-compatible endpoint;
- enter a credential through a write-only field;
- test OpenAI Responses API compatibility;
- assign each provider a priority weight and choose the preferred provider used to break equal-weight ties;
- create reusable exact model-mapping groups and assign one to each provider, with no selection meaning passthrough;
- create routing-rule groups whose rules assign one or more exact requested models to an ordered provider preference;
- configure each provider's model-discovery path, add missing model names, remove manual entries, and enable or disable individual models;
- cool providers after retryable `429`, selected `5xx`, timeouts, resets, or clear network failures, and replay a bounded Responses request only when the upstream connection was never established;
- hot-edit provider metadata or credentials and delete a provider while running when another tested route remains;
- create, disable, edit, and delete client API keys with optional expiration and lifetime request limits;
- keep loopback access key-free or require client keys through a hot-applied setting, and bind the stopped Worker to `127.0.0.1` or `0.0.0.0`;
- start, stop, restart, and inspect the proxy worker;
- inspect ChatGPT account/routing state plus anonymous 24-hour or 7-day request, result, model, Provider, and bounded-latency Metrics alongside a 12-week daily observed-Token heatmap;
- select an exact model on Overview and trace its live account gate, matched routing rule, provider order, model rewrite, predicted outlet, and conditional fallback;
- scan compact Forwarding Records with model, outcome, Provider, duration and observed Tokens; open request details without losing the list position, and control metadata/detail Capture independently;
- review localized, sanitized Activity labels for provider, routing, Capture, migration, and model-mapping operations;
- configure user-level start at login, routing, Codex integration, runtime facts, and diagnostics from the compact System page;
- generate an in-memory diagnostic summary containing only creation state, generation time, and sanitized event count.

Overview shows the local Codex ChatGPT authentication mode, plan, and every normalized quota window actually returned by Codex; System keeps only a compact account/routing status. Recognized five-hour and seven-day windows receive friendly labels, but a missing window is never fabricated or reserved in the layout. CRP refreshes the account snapshot every five minutes and on demand through the private Codex app-server protocol. Detached startup prepends the current Node executable directory when resolving `codex`, so login-started Supervisors do not depend on an interactive-shell `PATH`. Invalid `model_catalog_json`, invalid Codex configuration, and a missing Codex command receive distinct safe error codes and actionable UI guidance; custom-provider routing remains operational.

Routing defaults to `custom_only`. The Overview and System toggles can hot-apply `account_first` without restarting a running Worker. The decision classifies operation, request format, and model together: `POST /responses` accepts non-Image-API models, `GET /models` and `GET /v1/models` use the ChatGPT account catalog when the account gate is eligible, while `POST /images/generations` and `POST /images/edits` accept only direct `gpt-image-*` models. Canonical and `/v1` request paths map to the corresponding path under the ChatGPT Codex account base; model catalogs map to `/backend-api/codex/models` and preserve their query string. An account catalog `429` starts account cooldown and safely retries that GET through the custom Provider pool before any downstream response is delivered. CRP accepts the Codex client's `application/json` edit payload and the public Image API's standard `multipart/form-data` shape. JSON preflight reads only the top-level `model`; image URLs, Base64 data, query, headers, Content-Length, and request/response bytes remain unchanged. Multipart preflight strictly parses one non-file `model` field without decoding binary parts. An unsupported edits Content-Type returns 415 with `unsupported_request_format`; a missing JSON/multipart model returns 400 with `model_not_detected`; malformed multipart returns 400 with `invalid_multipart`. None of these errors silently enters the custom pool. This preserves the official OpenAI distinction between choosing a GPT Image model through the [Image API](https://developers.openai.com/api/docs/guides/image-generation) and using a mainline Responses model with the image-generation tool. Account preflight remains capped at 8 MiB. A larger request enters an unrestricted custom route before account delivery with `account_body_too_large`; if exact-model Provider selection or a mapping/override would be required, CRP returns 413 without delivering bytes to any upstream. Image Edits are never replayed after account delivery: their 429 response is returned and starts account cooldown, so only a later request can enter custom. Account network failures, timeouts, and uncertain delivery are never replayed. Custom-provider model priority, mapping, availability, weight, and cooldown behavior remain unchanged.

The Overview route preview uses that same model-request decision chain instead of reconstructing routing in the browser. It accepts the exact model, inference operation, and `requestFormat=json|multipart|unsupported`; omission preserves the compatible `responses` plus `json` defaults. Catalog GET routing is runtime-only because it has no request model and is not exposed as a Route Preview operation. Image Edits exposes a format selector so JSON and multipart previews match live routing, while unsupported formats show the same zero-delivery 415 outcome. The authenticated read-only contract is `GET /api/v1/routing-preview?model=<exact-model>&operation=<operation>&requestFormat=<format>` and returns bounded routing metadata only.

System can enable start at login without administrator privileges. CRP writes one marked, user-owned macOS LaunchAgent, Linux systemd user unit, or Windows Startup command that runs the installed CLI with the same `CRP_HOME`. The setting takes effect on the next sign-in; if the Node or package installation path later changes, System reports the managed item as stale so it can be repaired or disabled explicitly. Disabling rewrites only the identity-checked managed inode to an inert configuration; it does not race-prone delete the reserved path or Linux wants link. A foreign regular file, link, or unsafe artifact at the reserved path is reported as a conflict and is never overwritten, deleted, or used as permission to change the shared startup directory mode.

Client API-key authentication is optional while the Worker listens on `127.0.0.1` and mandatory while it listens on `0.0.0.0`; the public-listen setting cannot disable it. Authentication changes hot-apply to a running Worker, while changing the listen address requires the Worker to be stopped. Send a key in the dedicated `x-crp-api-key` header. `Authorization: Bearer crp_...` is also accepted for generated CRP keys, but that form is consumed as CRP authentication and therefore uses the custom-provider route. The dedicated header is recommended because it remains independent from ChatGPT and upstream authorization. Each successful authorization atomically consumes one request from that key's lifetime limit, if configured. Disabled, expired, exhausted, unknown, and deleted keys fail before routing.

All-interface listening is available only through the managed Supervisor/System path. The legacy standalone JSON runner remains restricted to `127.0.0.1` because it has no client-key management plane.

Complete client key values are accepted only during creation, stored as SHA-256 digests in the private `access-keys.sqlite3` database, and never returned by the Admin API. The UI shows only a bounded hint and lifecycle metadata. CRP automatically gives local Codex a separate private loopback-only token that does not consume client-key limits, strips both access headers before forwarding, and keeps the Codex proxy URL fixed at `127.0.0.1:15100`. Binding to `0.0.0.0` exposes an unencrypted HTTP service on every interface; use only a trusted network boundary or a separately managed TLS reverse proxy and firewall.

`Forwarding Records` is a privacy-bounded request ledger backed by the local Capture database. Supervisor settings are its single runtime source; the legacy standalone config cannot override them. The metadata-only desktop list prioritizes time, model/request, outcome, Provider, duration, and observed Tokens; narrow screens use record cards. Full URLs, IDs, routing reasons, and captured payloads belong in the selected record's dialog. HTTP status and final request outcome are distinct: a stream can fail after an HTTP 200. Missing failure evidence is identified without guessing a cause. Exact model mappings remain visible as `requested → forwarded`; legacy metadata remains nullable. `/models` catalog requests remain hidden by default.

The authenticated list endpoint accepts optional `since`/`until` bounds as canonical UTC ISO timestamps (`YYYY-MM-DDTHH:mm:ss.sssZ`), an exact requested-or-forwarded `model`, an exact persisted `providerId`, and an exact `sessionId`. Time filtering uses `started_at >= since` and `started_at < until`; both bounds require `since < until`. Exact text filters are trimmed, nonempty, control-free, and at most 256 Unicode code points. Existing bounded search, outcome and keyset pagination remain supported. Facet totals apply visibility, time, model, Provider, session and search filters, but ignore the selected outcome and pagination; legacy rows lacking an exact filter field do not match. Refresh keeps the last successful list visible while the new query is in flight.

Capture initialization adds a covering index containing only list metadata, so list and facet queries avoid reading captured-body overflow pages. On an existing nonempty database, this one-time build runs in an isolated background thread and does not delay gateway readiness. While the UI reports index preparation, forwarding continues but new requests are not recorded; existing history is preserved, and recording resumes automatically after preparation succeeds. The page observes completion without requiring a restart. Disabling Capture, changing the pending database path, and shutdown cancel maintenance; a replacement waits for confirmed termination. Empty databases can initialize the index immediately. Read-only queries never create it and retain exact legacy fallback behavior. Counts and rows use the same committed read snapshot, and subsequent refreshes reflect writes or deletions without a stale summary cache. Opening Forwarding Records no longer loads unrelated Metrics or the Token heatmap; those load on their applicable routes without blocking workspace initialization.

Metadata Capture and detailed payload Capture are separate controls. Detailed Capture defaults off, is available only while metadata Capture is enabled, and is cleared when metadata Capture is disabled so re-enabling metadata cannot silently resume body collection. Selecting a row performs an authenticated, uncached `GET /api/v1/forwarding-records/:id`; it never preloads payloads with the list. Records captured in detailed mode can return bounded, privacy-screened request/response headers and bodies with explicit encoding, observed byte count, and truncation state. Sensitive headers remain redacted, protected-value screening still fails closed, unavailable/legacy details are explicit, and stale payloads are cleared before a new detail request settles.

Overview Metrics remains an independent anonymous aggregate. The current-window cards, model rows, and Provider table continue to use 24 or 168 UTC hourly buckets. A separate compact daily rollup retains 84 UTC days for the GitHub-style Token heatmap; pointer, click, and keyboard selection expose exact input/output totals and request coverage for each day. Days with requests but no reported usage are marked as unobserved, and partially observed days are distinguished from both true zero-traffic days and complete coverage. The hourly and daily endpoints fail independently, while degraded daily persistence is disclosed without hiding the latest in-memory totals. Service reliability excludes client-aborted requests from its denominator. Model rows are expandable and separate unknown/grouped requests; the provider table shows every bounded provider returned by the API rather than silently keeping only the first few.

Changing provider preference, weight, provider configuration, model availability, model mappings, or the active routing-rule group affects new requests. Requests already in flight keep the complete snapshot with which they started. In `passthrough` mode CRP preserves the client model; in `override` mode it replaces only the top-level JSON `model` value with that candidate's configured model. Running changes persist a candidate registry document, apply and health-confirm a strictly newer Worker snapshot, and restore the prior registry and a newer rollback snapshot if confirmation fails. Deleting the preferred provider automatically selects the highest-weight tested fallback; deleting the final tested route is rejected while running but is allowed after the Worker stops. A failed live compatibility probe is reported without invalidating the current snapshot. Initial selection remains a first-wins compare-and-set while the Worker is stopped.

Model-mapping groups use exact, case-sensitive source names. A provider can select one reusable group or leave the field empty for passthrough; mapping and the legacy single-model override are mutually exclusive. Mapping is resolved per custom-provider candidate, so a failover candidate applies its own group to the original client model instead of inheriting the failed provider's result. Unmatched models pass through unchanged, and the ChatGPT account route is not rewritten. Assigned groups can be edited through the same confirmed hot-apply path; groups still assigned to any provider cannot be deleted.

Proxy pass-through streams request and response bytes with backpressure and does not auto-decompress request bodies. Model override and exact mapping perform the same bounded 8 MiB JSON transformation, preserve gzip, deflate, Brotli, and native zstd encoding when possible, and remove stale body-integrity/signature headers after a rewrite. On Node versions without native zstd compression, a verified single-frame zstd rewrite is forwarded as identity; zstd frames that cannot be safely inspected remain byte-exact passthrough when no rewrite applies. Client cancellation stops the corresponding upstream work.

When detailed Capture is enabled, it stores at most 1 MiB for each request and response body while retaining the total observed byte count. With detail Capture off, headers/body content remain empty and only metadata plus byte totals are stored. When configured protected values exist, truncated bodies, declared or detected compressed bodies, and bodies containing literal or recoverably encoded protected values are stored as `empty-truncated`; fully screened text/binary records use explicit UTF-8/base64 encoding. Configured API keys and extra-header values are removed from Capture headers, bodies, URL/ID metadata, detail responses, and debug logs. Buffered Metrics body inspection is independently bounded to 8 MiB, SSE inspection is incremental with bounded events, and neither path enables Capture.

## Stable Codex Configuration

CRP bootstraps Codex once and preserves these invariants:

```toml
model_provider = "OpenAI"
```

```text
http://127.0.0.1:15100
```

Provider switching happens inside CRP. Do not create a different Codex `model_provider` for each upstream and do not change the fixed proxy address during routine switching.

When client-key authentication is enabled, CRP maintains a private `x-crp-local-token` static header in the fixed Codex provider configuration. This header is accepted only from a loopback peer and is removed before any upstream request; it is separate from `requires_openai_auth`, so the ChatGPT identity remains available for account-first routing.

On a clean home, explicit `crp start` creates the missing `.codex` directory and `config.toml` privately and atomically, without creating a backup for a file that did not exist. On supported POSIX systems the new directory is `0700` and the new file is `0600`. Repeating the bootstrap is a byte-identical no-op. An existing config still receives an adjacent private backup only when its content must change, and its unrelated settings, line endings, and mode are preserved.

Before changing an existing Codex-level provider binding, exit Codex completely. Bootstrap reads the root `model_provider` and its supported `base_url` binding from one locked config snapshot. Invalid UTF-8 or a malformed/ambiguous selected-provider binding fails before backup, journal, or config writes; this focused scanner is not a whole-document TOML validator. A different or missing effective URL triggers history discovery. Only a nonempty write set receives private rollout snapshots, exclusive SQLite logical backups, and a forward-recovery journal under `.codex/.crp-history-repair`; an already aligned set uses a config-only commit. CRP then publishes the fixed config and changes only provider metadata in active/archived rollout `session_meta` records and supported `threads.model_provider` columns. A pending repair or config lock makes Codex not ready and blocks activation, Worker start/restart, and automatic crash recovery; the next bootstrap resumes it. Encrypted history content is never rewritten, and the CLI emits a static warning because some encrypted messages may remain unavailable.

Routine CRP provider add/test/activate/hot-switch operations never invoke this repair. Per the URL-only trigger, a provider-name change with the same effective URL does not rewrite history metadata; operators migrating such a custom layout must review it separately. Managed config/history backups can contain private local state and must be protected like the original Codex directory.

## Credential Safety

The public Supervisor requires the native operating-system credential store through service `org.cluic.codex-remote-proxy`:

- macOS Keychain;
- Windows Credential Manager;
- a compatible Secret Service on Linux.

If native storage cannot be constructed or later fails, public startup and credential operations fail closed. The current UI, CLI, and Admin API have no file-storage consent or selection control. A lower-level private file adapter remains available only through trusted dependency injection; exposing a startup consent path is future L3 work and no native operation is replayed into that adapter.

The UI never reads a saved provider credential or client API key back. Secret fields are blank on edit, complete client keys are replaced by one-way digests, and complete client keys are excluded from API reads, activity, diagnostics, Capture, and logs. ChatGPT access tokens, email addresses, and account identifiers are likewise excluded from public status/settings responses, Activity, Metrics, Capture, and logs. Account authorization headers are removed from every custom-provider request, and custom credentials or extra headers are never sent to ChatGPT.

## Local Browser Security

The Admin server binds only to `127.0.0.1:15101`, rejects unexpected `Host` and `Origin` values, disables CORS, and requires CSRF protection for browser mutations.

`crp ui` puts the private local control token in the URL fragment. The fragment is not part of HTTP requests; the UI exchanges it for an in-memory CSRF token and an HttpOnly, `SameSite=Strict` session cookie, then removes the fragment and clears its local token reference. Tokens, credentials, provider drafts, responses, and errors are not persisted in browser storage.

Reloading a tab with a still-valid session but no launch fragment first opens a GET-only workspace. The user may explicitly restore management while that authenticated cookie session remains valid; CRP requires an exact same-origin request plus a non-simple recovery header, rotates the session ID and CSRF token, and does not extend the original expiry. Reopen with `crp ui` after expiry. A failed launch exchange or later business-session/CSRF failure is terminal for that tab.

## CLI

The UI is recommended whenever a credential must be entered. These supervisor commands are also available:

```text
crp ui [--no-open] [--json]
crp start [--json]
crp status [--json]
crp stop [--json]
crp restart [--json]
crp shutdown [--json]
crp language [en|zh-CN] [--json]
crp -v | crp --version
crp version [--json]
crp update [--check] [--json]
crp provider presets [--json]
crp provider list [--json]
crp provider add (--preset <ID> | --name <NAME> --base-url <URL>) --api-key <KEY> [--model <MODEL>] [--json]
crp provider models (--id <ID> | --name <NAME>) [--json]
crp provider test (--id <ID> | --name <NAME>) --model <MODEL> [--json]
crp provider activate (--id <ID> | --name <NAME>) [--json]
crp provider delete (--id <ID> | --name <NAME>) [--json]
```

The two recommended entry points are `crp ui` for guided setup and daily management, and `crp start` for headless CLI startup. `ui` starts or discovers the Supervisor and opens the management page; `start` starts or discovers the Supervisor, bootstraps the fixed Codex configuration, and starts the proxy Worker.

Every human CLI path supports English and Simplified Chinese, and fresh installations default to English without inferring `LANG`, `LC_ALL`, or `LC_MESSAGES`. Run `crp language zh` (or `crp language zh-CN`) to persist Simplified Chinese for future commands, and `crp language en` to switch back. `CRP_LOCALE` can override the saved preference for one process environment, while one global `--locale en|zh-CN` may appear anywhere and always wins for that invocation. Locale changes human output only. With `--json`, a failure writes nothing to stdout and exactly one language-independent error document to stderr.

## License

This project is licensed under the [MIT License](./LICENSE).

Without `--json`, `provider list` renders a count plus each provider's active marker, name, ID, base URL without query/hash, test state, model mode/override or mapping-group ID, and credential-configured state. `status` renders Supervisor PID/start time, Worker phase/PID/generation/listening/in-flight state, active provider, Codex state, fixed `OpenAI` identity, and the `15100` proxy URL instead of a generic sentence. Dynamic terminal text is length-bounded and escapes control, escape, and bidirectional-control characters; credential references, extra headers, and complete keys are never rendered.

Root help presents aligned command descriptions plus consistent usage, options, and examples. Exact `-h`/`--help` is available for every supported first-level command, the `provider` group, and each provider action; help is resolved locally without starting or discovering the Supervisor. Help flags are parsed only at their exact argv positions, so trailing or misplaced input remains a validation error instead of being silently ignored.

`crp stop` stops only the proxy Worker on configured port `15100`; the Supervisor and management API on `127.0.0.1:15101` remain available. Use `crp shutdown` to stop the Worker and exit the Supervisor completely. A running Supervisor after `stop` is therefore expected, and detailed `status` output distinguishes the two processes.

Human success copy preserves those distinctions: `shutdown` confirms both Supervisor and Worker shutdown. `crp start` reports failures at one stable stage: `supervisor_start`, `codex_bootstrap`, or `proxy_start`; `restart` also performs mandatory bootstrap first when Codex is not ready. Explicit activation/start/restart and unexpected-exit recovery share the same FIFO Codex readiness gate. A failed or pending bootstrap prevents lifecycle mutation. A successful config publication is not rolled back after later uncertainty: journaled history work remains pending, while config-only uncertainty is reported separately without claiming a pending repair.

Detached Supervisor startup uses a one-shot, strictly allowlisted IPC error. An approved migration-input failure is returned before the readiness timeout; malformed, unknown, or unapproved child messages become the generic `SUPERVISOR_START_FAILED` contract.

The former compatibility aliases `crp init`, `crp install`, and `crp setup` have been removed. They fail locally with `CLI_COMMAND_REMOVED`, perform no Supervisor discovery or mutation, and point to `crp ui` or `crp start` as the replacement. `check`, `capture on|off|status`, `guide`, and the deprecated local-shim command `install-cli` remain available; the CLI still has no provider-update, Activity, Settings, or diagnostics operation.

`crp provider presets` lists maintained public defaults. `crp provider add --preset openrouter --api-key <KEY>` uses the correct OpenRouter `/api/v1` base URL and Bearer authentication while keeping the credential write-only. Custom add remains available and supports advanced authentication and routing options. Optional `--model` is test input only. Command-line secrets may be visible in shell history or process inspection, so this path is intended only for controlled automation.

`-v` and `--version` print the installed version without discovering or starting CRP. `crp version` compares the installed package with the running Supervisor build. `crp update --check` only queries npm; `crp update` is intentionally limited to a verified global npm installation, installs successfully before stopping anything, binds shutdown to the exact Supervisor observed before installation, then restores whether the Supervisor and Worker were running. If the new runtime cannot be activated, CRP reinstalls the previous version and restores the previous runtime state before returning `UPDATE_ROLLED_BACK`; a failed rollback returns `UPDATE_RECOVERY_FAILED` with an explicit manual recovery command. Source checkouts and `npx` cache copies receive an actionable global-install instruction instead of being mutated.

`provider test`, `activate`, `delete`, and `models` require exactly one selector: `--id` or `--name`. Names resolve by exact case-insensitive match against the unique public provider list. `provider models` performs an authenticated, no-redirect refresh from the provider's configured discovery path, which defaults to appending `/models` to the base URL; the Admin API and Web UI can change that path and expose cached discovery separately. Discovery is bounded and rejects any model ID containing the complete credential before it can reach cache or output. It is independent from Responses compatibility testing, so a missing or incompatible model endpoint does not change provider test or activation state and a failed refresh does not erase the last good catalog.

CLI-triggered compatibility tests, including `provider add --model`, request initial selection only when no Provider is active. The ordinary Web Providers page now makes the same request. The first successful candidate wins an atomic compare-and-set while the Worker is stopped. Selection writes `activeProviderId` but never starts or reconfigures the Worker, never calls the readiness-gated explicit activation route, and is confirmed from refreshed server state; run `crp start` explicitly. Admin callers that omit `activateIfNone` retain non-selecting test behavior. The conditional Web Setup also opts in and runs `save provider -> test and compare-and-set select -> prepare Codex/history repair -> start Worker`.

## Upgrading From 0.2.2

Current releases migrate the pre-supervisor flat configuration to provider-registry schema 9 on first supervisor startup. Existing valid schema-2 through schema-8 registries are backed up and upgraded atomically. Schema-2/schema-3 providers receive the neutral default weight `100`; later weights and schema-5 model mappings are preserved. Schema-6 single-model routing rules become one-element model sets, automatic/custom model availability becomes the equivalent default-enabled/default-disabled policy, and existing custom allowlists become enabled custom entries. Schema-7 installations receive loopback listening with client-key authentication disabled, preserving their prior access boundary. Schema-8 and older installations preserve their metadata Capture setting and receive the new detailed-Capture setting in its safe disabled state. Schema inspection and replacement hold both the migration lock and the normal ProviderRegistry writer lock, and backup/publication directory entries are fsynced before success is reported.

1. Stop the old managed proxy.
2. Make a private backup of `~/.codex-remote-proxy/` and `~/.codex/config.toml`. Treat every backup as secret-bearing.
3. Run `crp ui`.
4. Review the recovered Provider candidate or candidates, run compatibility tests, and select one only after it passes.

Migration reads the legacy `config.json` and runtime `node/proxy-config.json` independently. A single complete source becomes one inactive, untested `Default` Provider. Canonically identical sources are deduplicated; if two complete sources disagree about their URL, credential, or explicit authentication facts, CRP imports both as inactive `Recovered runtime` and `Recovered saved` Providers instead of choosing a secret for the user. Each imported credential receives its own native-backend reference. Every parseable legacy source is privately backed up before credential or registry writes, the schema-9 registry is verified before source secrets are scrubbed, and malformed legacy JSON remains byte-exact and untouched.

If neither source independently contains one complete, valid Provider, migration leaves all legacy bytes unchanged and starts the ordinary Web Setup with an empty in-memory schema-9 registry. The user can then add a Provider through the UI without editing or deleting secret-bearing files. Unsafe registry paths, identity races, and permission failures still fail closed rather than discarding previously migrated Provider data.

If an existing regular `providers.json` can be read safely but its JSON, schema, or document is invalid, CRP now recovers without deleting it: it first creates a private byte-exact backup, hard-links the original into the fixed no-replace marker `providers.json.recovery-invalid`, secures and fsyncs that marker, then releases only the canonical link whose inode still matches. The Supervisor continues with an empty in-memory registry and opens Setup. Symlinks, directories, permission failures, identity races, and foreign recovery markers remain fatal. A durable `prepared → linked → canonical-released` journal binds the source inode, PID, and both transaction locks so a later startup can finish an interrupted quarantine without deleting foreign locks or files.

If a transaction fails before commit, CRP restores only sources modified in that attempt and compensates transaction-owned credentials in reverse order. It never deletes a foreign replacement. A rollback-degraded attempt retains the canonical migration and registry locks as discoverable blockers. Post-commit Activity failures report committed degradation instead of claiming the primary migration was rolled back. Any `MIGRATION_COMMITTED_DEGRADED`, `MIGRATION_COMMITTED_LOCK_DEGRADED`, or `MIGRATION_ROLLBACK_DEGRADED` result requires CRP to remain stopped while the private backups and sanitized Activity code are reviewed.

Rollback to `0.2.2` is not a schema downgrade. Stop CRP first and restore the complete private pre-upgrade backup as one unit; do not copy a secret back into only one legacy file or mix schema-9 registry state with flat configuration. Real-home migration and rollback remain L3 operations and require platform-specific review.

## Development

There are two intentionally different ways to exercise the development CLI:

```bash
# Production-path smoke: reads and may update the real ~/.codex and
# ~/.codex-remote-proxy when a mutating command is used.
cd node
npm run dev:cli -- check --json

# Ordinary deterministic tests remain isolated and must not touch the real HOME.
npm test
```

Calling `runCli(..., { paths: getPaths(tempHome) })`, including through a local
`crpdev` shell wrapper, deliberately operates the Supervisor, Provider registry,
and Codex bootstrap against that temporary home. It is suitable for safe UI and
CLI feature testing, but it is not evidence that the real `~/.codex` was
modified. Use the direct `npm run dev:cli -- <command>` entry only when a
real-home operation has been explicitly authorized. Stop Codex before any
existing-config transition or history repair.

```bash
cd node
npm ci
npm run lint
npm run typecheck:ui
npm run build:ui
npm run verify:ui-build
npm test
node scripts/run-test-group.mjs core-chain
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
npm pack --dry-run --json --ignore-scripts
```

Tests use temporary homes, synthetic credentials, injected adapters, and loopback mock upstreams. Do not run supervisor startup or migration tests against a real home directory.

The serial `core-chain` gate exercises the real CLI, Admin server, registry/provider service, WorkerManager, forked proxy worker, fixed ports, provider switching with an in-flight request, restart, shutdown, and secret scans. It deliberately substitutes an in-memory credential adapter and loopback upstreams, so it does not prove native credential access or a real external provider.

Release evidence must include lint, UI typecheck/build/exact manifest verification, the deterministic Node suite, Chromium English/Chinese responsive coverage, the exact package-content allowlist, runtime audit, and the visual comparison recorded in `design-qa.md`. Deterministic fixtures do not claim real Codex history, native credentials, login-start execution, or an external provider; those remain platform/human gates for the reviewed release tree.

Supervisor discovery uses a bounded 2-second liveness probe while normal Admin operations use a separate 30-second timeout, so a successful provider test is not misreported as `SUPERVISOR_UNAVAILABLE`. Proxy targets are joined structurally, so base URLs with or without a trailing slash produce one path separator.

Release preparation and remaining external gates are documented in [node/RELEASING.md](./node/RELEASING.md).
