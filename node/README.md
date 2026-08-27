# Codex Remote Proxy

`@cluic/codex-remote-proxy` keeps Codex signed in with ChatGPT while routing model requests through a weighted pool of OpenAI-compatible providers.

> Release status: the npm `latest` dist-tag is authoritative. Ordinary product updates use patch releases; minor or major bumps require an explicit policy change.

## Requirements and Install

Node.js 22.13 or newer is required.

```bash
npm install -g @cluic/codex-remote-proxy
crp ui
```

Or run without a global install:

```bash
npx @cluic/codex-remote-proxy ui
```

`crp ui` is the normal setup and management entry point. It starts or discovers the loopback supervisor, opens the local management UI, and supports complete English and Simplified Chinese interfaces.

The current development source is a responsive React + TypeScript SPA under `ui-src/`, built with Vite. Build tools and source are not shipped: the package contains exactly `ui/index.html`, `ui/app.js`, and `ui/styles.css` for the existing same-origin Admin server.

## Product Behavior

Provider creation can start from maintained public presets or a custom OpenAI-compatible endpoint. The initial catalog includes OpenRouter with the required `https://openrouter.ai/api/v1` base URL and Bearer authentication defaults; credentials remain write-only.

`GET /api/v1/status` includes sanitized build and effective Capture state, while `GET /api/v1/provider-presets` exposes only maintained public defaults. Supervisor settings are the sole Capture source for managed Workers, so legacy standalone config cannot silently override the current setting. Forwarding rows distinguish observed, upstream-unreported, unrecognized-protocol, non-applicable, and legacy usage. OpenAI `response.completed` and OpenRouter `response.done` terminal SSE events are both recognized without changing forwarded bytes.

Overview uses one interactive trend explorer for requests and Tokens. It supports count/share plus total/input/output Token metrics, keyboard/hover bucket inspection, and gaps for missing usage instead of false zeroes. Reliability excludes client aborts; model rows are expandable and separate unknown/grouped traffic; the provider table displays every bounded row returned by the API.

The UI can create, test, prioritize, prefer, hot-update, and delete named providers; create reusable exact model-mapping groups; assign multiple exact requested models to each provider-order rule; configure provider model-discovery paths; and add, remove, enable, or disable individual model entries. Overview can preview an exact model through the live account gate, routing rule, provider order, rewrite, predicted outlet, and conditional fallback. It can also create, disable, edit, and delete client API keys with optional expiration and lifetime request limits; choose loopback or all-interface Worker listening; start, stop, and restart the proxy worker; inspect ChatGPT account/routing state and anonymous 24-hour/7-day Metrics; review metadata-only Forwarding Records and localized sanitized Activity; configure start at login and routing; and generate bounded in-memory diagnostics. A provider must pass an OpenAI Responses compatibility test before it enters the runtime pool. Explicit model-set priority is evaluated before weight ordering, while health cooldowns and provider model overrides remove ineligible candidates. Provider, model-control, mapping, routing-rule, preference, and weight changes atomically hot-apply a newer confirmed Worker snapshot. Deletion selects a tested fallback; only removal of the final tested running route is rejected. Failed live probes do not invalidate the current snapshot. First-provider compare-and-set selection never starts or reconfigures the Worker.

Client-key authentication is optional on `127.0.0.1` and mandatory on `0.0.0.0`. The authentication setting hot-applies, while a listen-address change requires a stopped Worker. Clients should use `x-crp-api-key`; generated `crp_` keys are also accepted as Bearer authorization, but that form is consumed before routing and therefore uses the custom-provider path. Complete values are creation-only and become SHA-256 digests in private SQLite storage. Successful authorizations atomically consume the configured lifetime limit. CRP maintains a separate private loopback-only token for Codex, strips both access headers before forwarding, and never consumes a client-key allowance for local Codex traffic. `0.0.0.0` exposes plain HTTP and therefore requires an independently trusted network/TLS boundary.

Only the managed Supervisor/System path can select all-interface listening. The legacy standalone JSON runner remains loopback-only because it has no client-key management plane.

Overview projects the Codex account authentication mode, plan, and only the normalized quota windows returned by the private app-server protocol; System keeps a compact account/routing status. Known five-hour and seven-day durations receive friendly labels; absent windows consume no UI space. Neither surface projects a ChatGPT token, email, or account ID. Detached account monitoring prepends the current Node directory when resolving `codex`, and safely distinguishes an invalid model catalog, invalid Codex configuration, and an unavailable command. Routing defaults to `custom_only`; `account_first` hot-applies from either surface and is limited to the two Responses POST paths. A signed-in account with available quota is tried first, then explicit account rate limiting falls through to the custom pool. Replay buffering is capped at 8 MiB. Account headers are stripped from every custom request, and custom credentials/extra headers never cross into the account request.

The authenticated Admin contract exposes the sanitized account projection through `GET /api/v1/status`, refreshes it through `POST /api/v1/account/refresh`, previews bounded routing metadata through `GET /api/v1/routing-preview?model=<exact-model>`, lists bounded forwarding metadata through `GET /api/v1/forwarding-records`, updates weights through `PATCH /api/v1/providers/:id/weight`, and accepts exactly one of `routingMode`, `captureEnabled`, `autoStartEnabled`, `apiKeyAuthEnabled`, or `proxyHost` at `PATCH /api/v1/settings`. A running preview comes from the Worker's live scheduler and cooldown state; a stopped preview is labeled as configuration-only. Client keys use `GET/POST /api/v1/access-keys` and `GET/PATCH/DELETE /api/v1/access-keys/:id`; creation accepts the complete secret once, while every response returns metadata only. Model mapping groups use `GET/POST /api/v1/model-mappings` and `GET/PATCH/DELETE /api/v1/model-mappings/:id`; provider model control uses `PATCH /api/v1/providers/:id/models` with `modelsPath`, `defaultEnabled`, `customModels`, and exact `overrides`; routing-rule groups use `GET/POST /api/v1/routing-rule-groups`, member `GET/PATCH/DELETE`, and `PATCH /api/v1/routing-rule-groups/active`. Each routing rule contains `models[]` plus an ordered `providerIds[]`. Every mutation retains the existing same-origin session and CSRF requirements.

`Forwarding Records` is a complete metadata-only route over the local Capture database with success/rejected/error/aborted filters, bounded search, keyset pagination, summary counts, details, and a Capture toggle. Capture schema 5 adds nullable `requested_model` and `forwarded_model` columns; new rows persist both values alongside final route/provider attribution and observed input/output Tokens. Exact mappings and Provider overrides therefore remain explainable without exposing request bodies, model search covers both columns, and legacy rows remain nullable. A close after observed semantic completion is successful, while a true pre-completion client close is aborted rather than a provider error. Legacy rows use best-effort URL inference. The query selects no request/response bodies or authorization headers. Overview Metrics remains an independent anonymous aggregation using fixed UTC hourly buckets, semantic Responses completion, unavailable-rate disclosure after dropped observations, and explicit grouped Provider/model remainders.

Start at login uses one marked user-level macOS LaunchAgent, Linux systemd user unit, or Windows Startup command and requires no administrator access. It runs the installed CLI with the same `CRP_HOME` at the next sign-in. Installation-path drift is reported as stale, while a foreign file or link at the reserved path is a conflict that is never overwritten or removed. Disable rewrites only an identity-checked managed inode to inert content and keeps shared startup-directory modes unchanged.

Codex remains configured as:

```toml
model_provider = "OpenAI"
```

Its proxy address remains fixed at `http://127.0.0.1:15100`. CRP switches upstreams internally for new requests while in-flight requests retain their starting snapshot, including provider order, model availability, and model policy. Passthrough preserves the client's model; override replaces only the top-level JSON `model` value. A reusable mapping group performs exact case-sensitive source-to-target replacement for that custom-provider candidate, leaves unmatched models unchanged, and is mutually exclusive with override. Failover always reapplies the next candidate's policy to the original request model; the ChatGPT account route is never mapped. Assigned mapping groups are not deletable, but edits are hot-applied.

CRP also maintains a private `http_headers."x-crp-local-token"` entry in that fixed Codex provider binding. It remains separate from `requires_openai_auth`, is accepted only from a loopback peer, and is removed before upstream forwarding.

Pass-through traffic streams with backpressure and preserves request encodings byte-for-byte. Model override is an 8 MiB bounded JSON transformation that preserves gzip, deflate, Brotli, and native zstd encoding when available, strips stale integrity/signature headers after a rewrite, and falls back to identity for a verified single-frame zstd request when Node has no native zstd compressor. Downstream cancellation destroys the corresponding upstream work.

Optional Capture stores at most 1 MiB per request and response body and retains total observed byte counts. With configured protected values, truncated bodies, declared or detected compressed bodies, and bodies containing literal or recoverably encoded protected values are stored as `empty-truncated`; fully screened text/binary records retain explicit UTF-8/base64 encoding. Configured API keys and extra-header values are redacted from Capture headers, bodies, URL/ID metadata, and debug logs. Independent buffered Metrics inspection is bounded to 8 MiB. Headerless and declared SSE are inspected incrementally with bounded events, Responses success requires semantic completion rather than HTTP 2xx alone, and observed usage is persisted without retaining response content.

On a clean home, explicit `crp start` privately and atomically creates a missing `.codex` directory and `config.toml`, with no backup for a source that did not exist. New POSIX directory/file modes are `0700`/`0600`; a repeated bootstrap is byte-identical. Existing-file locking, identity/race checks, adjacent backup, mode preservation, and idempotency remain in force.

Exit Codex before a real existing-config transition. Bootstrap compares the root `model_provider` binding's effective `base_url` with the fixed proxy URL using a selected-binding scanner, not a whole-document TOML validator. A different or missing binding triggers discovery; only a nonempty history write set receives private active/archive rollout snapshots, exclusive SQLite logical backups, and a forward journal under `.codex/.crp-history-repair`. Pending repair or a config lock blocks explicit activation/start/restart and automatic crash recovery through one FIFO Codex gate. CRP-internal provider switching never triggers repair. Only provider metadata is rewritten, encrypted content is left intact, and same-URL provider-name changes remain outside the URL-only trigger.

## Credentials

The public Supervisor requires the operating-system native store under service `org.cluic.codex-remote-proxy`. Native construction or operation failure fails closed. The UI, CLI, and Admin API expose no file-backend control. The lower-level private file adapter is limited to trusted dependency injection; a public startup-consent path remains future L3 work, and native operations never replay into the file namespace.

Complete provider credentials and client keys are write-only. Client keys are replaced by one-way digests; only bounded hints and lifecycle metadata are projected. They are excluded from public provider/access projections, settings, activity, diagnostics, Capture, logs, and errors. Prefer the UI for secret entry. `crp provider add` accepts a required `--api-key` for controlled automation, but command-line values may be exposed through shell history or process inspection.

## Browser Session Boundary

The Admin server binds exactly to `127.0.0.1:15101`, checks `Host` and `Origin`, disables CORS, and requires CSRF for browser mutations. `crp ui` launches with a control token in the URL fragment; the app exchanges it once for an HttpOnly `SameSite=Strict` session cookie plus an in-memory CSRF token, then removes and clears the fragment token.

A saved explicit Web UI locale wins; otherwise the first supported Chinese or English browser/system preference is used, with English as the fallback. Inferred locale is not persisted. Session/control/CSRF tokens, credentials, drafts, responses, and errors remain memory-only. Reload with a valid cookie but no launch fragment starts GET-only; an explicit same-origin recovery may rotate that still-valid browser session and restore mutations without extending its expiry. Reopen with `crp ui` after expiry. Launch exchange and later business-session/CSRF failures remain terminal for the tab.

## Commands

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
crp guide [--json]
```

Use `crp ui` for guided setup and daily management, or `crp start` for headless CLI startup. These are the two supported setup/start entry points.

Human CLI output supports `en` and `zh-CN`, and defaults to English without consulting `LANG`, `LC_ALL`, or `LC_MESSAGES`. `crp language zh` (or `zh-CN`) persists Simplified Chinese for future commands, while `crp language en` restores English. `CRP_LOCALE` overrides the saved preference for one process environment; a single global `--locale en|zh-CN` may appear anywhere and always wins for that invocation. JSON keys, codes, enums, messages, and actions remain stable English contracts. JSON failures leave stdout empty and write exactly one parseable envelope to stderr.

`crp update` only mutates a canonical global npm installation. It installs and verifies the target package before an identity-bound Supervisor shutdown, restores the prior Supervisor/Worker state with the new CLI, and automatically reinstalls and restores the previous version if activation fails. `UPDATE_ROLLED_BACK` means the old runtime is healthy; `UPDATE_RECOVERY_FAILED` includes the bounded manual recovery command.

## License

This package is licensed under the [MIT License](./LICENSE).

Human `provider list` output renders count, active marker, name/ID, query/hash-free base URL, test state, model mode/override or mapping-group ID, and credential-configured state. Human `status` output renders Supervisor PID/start time; Worker phase/PID/generation/listening/in-flight state; active provider; and Codex, fixed `OpenAI`, and `15100` proxy state. Dynamic terminal text is bounded and escapes control, escape, and bidirectional-control characters; private fields are not rendered.

Root help uses aligned command descriptions and consistent usage/options/examples sections. Exact `-h`/`--help` covers every supported first-level command, the provider group, and provider actions without Supervisor discovery. Flags are recognized only at exact argv positions; trailing or misplaced input remains a validation error.

`stop` stops only the proxy Worker and leaves the Supervisor/Admin API available; `shutdown` stops the Worker and exits the Supervisor. The supported fixed ports remain `15100` for the Worker and `15101` for the Supervisor, while the Worker host can be loopback or all interfaces.

Human success output confirms both processes for `shutdown`. `start` identifies failures as `supervisor_start`, `codex_bootstrap`, or `proxy_start`. Bootstrap failure short-circuits lifecycle mutation; explicit activation/start/restart and unexpected-exit recovery share one FIFO Codex readiness gate. A completed bootstrap remains durable if the proxy phase fails.

Detached Supervisor startup uses a one-shot, strictly allowlisted IPC error. An approved migration-input failure wins over the readiness timeout; malformed, unknown, or unapproved child messages become the generic `SUPERVISOR_START_FAILED` contract.

The former `init`, `install`, and `setup` compatibility aliases are removed. Each returns `CLI_COMMAND_REMOVED` locally without Supervisor discovery or mutation and points to `crp ui` or `crp start`. `check`, `capture on|off|status`, `guide`, and the deprecated `install-cli` shim command remain; there are no provider-update, Activity, Settings, or diagnostics CLI commands.

`provider presets` is local and side-effect free; `provider add --preset openrouter` applies the maintained `/api/v1` endpoint and Bearer defaults. Optional `provider add --model <MODEL>` uses that value only for the follow-up Responses test; routing override remains `--model-mode override --model-override <MODEL>`. It saves the profile first, then tests, and creation remains committed when the compatibility result fails or the second-stage request cannot complete. `provider test`, `activate`, `delete`, and `models` require exactly one of `--id` or case-insensitive exact `--name`. `provider models` refreshes the authenticated, no-redirect catalog at the configured path (default base URL plus `/models`) and rejects a complete credential reflected in any model ID before cache or output; discovery failure preserves the last good cache and does not change provider test or activation state.

`-v` and `--version` print the installed version without discovery. `version` compares installed and running builds. `update --check` only queries npm; `update` requires a verified global npm installation, installs before shutdown, and restores the previous Supervisor/Worker running state. Source checkouts and `npx` cache copies are never mutated in place.

CLI tests and ordinary Web Providers-page tests request `activateIfNone` so the first successfully tested Provider is selected through a first-wins compare-and-set while the Worker is stopped. That initial selection never starts or reconfigures the Worker, never calls the readiness-gated explicit activation route, and is confirmed from refreshed server state; `crp start` remains explicit. Admin calls default `activateIfNone` to false. Conditional Web Setup also opts in and runs `save -> test and CAS select -> Codex bootstrap/history repair -> Worker start`.

## Migration From 0.2.2

Before first startup, stop the old proxy and privately back up the whole CRP home plus Codex configuration. Backups may contain credentials.

The first supervisor startup transactionally reads legacy `config.json` and `node/proxy-config.json` when present, writes collision-safe byte-exact private backups, stores the secret through the required native adapter, creates schema-8 `providers.json` in `custom_only` mode with loopback listening and client authentication disabled, one inactive, untested, weight-100 `Default` profile, the default `/models` discovery path, newly discovered models enabled, and empty mapping/routing groups, validates the registry, and only then scrubs legacy secret fields. The user must test and prefer `Default`; migration does not assume compatibility. Valid schema-2 through schema-7 registries are independently backed up and upgraded atomically. Schema-6 single-model routing rules become one-model sets, automatic/custom model availability retains its default-enabled/default-disabled behavior, and schema 7 preserves its prior loopback/no-key access boundary.

Different credentials in the legacy sources produce `MIGRATION_INPUT_INVALID` before backups, credential operations, registry writes, or source mutation. CRP does not choose one source automatically; resolving a real-home conflict remains an operator-reviewed L3 migration action.

On an ordinary pre-commit failure, CRP attempts reverse-order restoration and removes only transaction-owned registry/credential state. Foreign replacements and all backups are preserved. Schema inspection/replacement shares the normal ProviderRegistry writer gate and fsyncs backup/publication directory entries before completion. Committed or rollback-degraded migration codes require CRP to remain stopped while an operator reviews Activity and the private backups; repeated retry or partial manual copying can make an uncertain state worse.

Returning to `0.2.2` requires stopping CRP and restoring the complete pre-upgrade backup as a unit. Schema 8 is not automatically downgraded. Real-home migration, native stores, and rollback are L3 platform operations.

## Development and Release Gates

Run the source CLI directly when a specifically authorized smoke test must use
the real user paths:

```bash
npm run dev:cli -- check --json
```

The direct entry resolves `~/.codex` and `~/.codex-remote-proxy` from the real
home directory. A test wrapper that injects `getPaths(tempHome)` is intentionally
isolated and cannot prove a real-home transition. Do not run a mutating
real-home command while Codex is active; copied-corpus rehearsal and L3 review
remain required before migration or history-repair release evidence.

```bash
npm ci
npm run lint
npm run typecheck:ui
npm run build:ui
npm run verify:ui-build
npm test
node scripts/run-test-group.mjs core-chain
node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
node --test test/package-content.test.mjs test/native-keyring-smoke.test.mjs test/release-workflows.test.mjs
npm pack --dry-run --json --ignore-scripts
```

The current package-content test requires the exact reviewed 44-file allowlist, including provider presets/build metadata, the provider scheduler, client-key store/private-token support, Forwarding Records service, start-at-login service, and exactly three generated UI assets. It rejects UI development source, runtime state, credentials, tests, Changesets, logs, databases, and generated output outside the reviewed UI files. Deterministic tests use temporary homes, synthetic credentials, injected credential adapters, and loopback upstreams.

The serial `core-chain` group uses the production CLI/Admin/registry/provider/WorkerManager/forked-worker path and proves switching, in-flight snapshots, restart, shutdown, cleanup, and secret scans. Its injected memory credential adapter and loopback upstreams do not satisfy the separate real native-keyring/external-provider gate.

Release evidence must include lint, UI typecheck/build/exact-output verification, deterministic Node tests, Chromium English/Chinese responsive coverage, the exact 44-file package allowlist, runtime audit, and the comparison recorded in `../design-qa.md`. Deterministic fixtures do not prove real native-keyring, login-start execution, or external-upstream behavior; those remain platform/human gates.

Supervisor discovery applies a 2-second liveness probe and returns a client with a separate 30-second operation timeout. Proxy forwarding joins base and incoming URLs structurally, preserving base paths and query parameters while avoiding duplicate path separators. The retained `provider add --api-key <KEY>` behavior and broader child-environment minimization remain explicit future follow-up work and do not block local core completion.

Unreleased package behavior changes use repository-required patch Changesets. Do not run `npm run version-packages` or `npm run release` during feature preparation. See [RELEASING.md](./RELEASING.md) for local evidence and remaining remote/human gates.
