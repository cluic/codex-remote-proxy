# Codex Remote Proxy

`@cluic/codex-remote-proxy` keeps Codex signed in with ChatGPT while routing model requests through a selected OpenAI-compatible provider.

> Release status: npm `0.3.0` is current and includes the Supervisor and `crp ui`. Changes after `0.3.0` remain unreleased until their deterministic, platform, and human-review gates pass.

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

The UI can create, test, switch, update, and delete named providers; start, stop, and restart the proxy worker; inspect anonymous 24-hour/7-day aggregate Metrics; review sanitized Activity; inspect read-only System facts; and generate in-memory diagnostic summary metadata. A provider must pass an OpenAI Responses compatibility test before explicit activation. Provider cards expose the legal switch action directly. Explicit activation applies a snapshot to a running Worker and starts a stopped Worker; first-provider compare-and-set selection from Setup, CLI, or the ordinary Providers page never starts or reconfigures it. The active provider cannot be updated or deleted, even while the worker is stopped; switch to another provider first.

`Forwarding Records` is a disabled coming-soon navigation item only. It has no route, traffic request, Capture control, payload viewer, or mock records. Overview Metrics is anonymous aggregation independent from optional Capture. It uses fixed UTC hourly buckets, classifies Responses success from semantic terminal state, marks rates unavailable after dropped metric updates, and retains explicit grouped remainders for Provider and model distributions.

Codex remains configured as:

```toml
model_provider = "OpenAI"
```

Its proxy address remains fixed at `http://127.0.0.1:15100`. CRP switches upstreams internally for new requests while in-flight requests retain their starting snapshot, including the Provider model policy. Passthrough preserves the client's model; override replaces only the top-level JSON `model` value.

Pass-through traffic streams with backpressure and preserves request encodings byte-for-byte. Model override is an 8 MiB bounded JSON transformation that preserves gzip, deflate, Brotli, and native zstd encoding when available, strips stale integrity/signature headers after a rewrite, and falls back to identity for a verified single-frame zstd request when Node has no native zstd compressor. Downstream cancellation destroys the corresponding upstream work.

Optional Capture stores at most 1 MiB per request and response body and retains total observed byte counts. With configured protected values, truncated bodies, declared or detected compressed bodies, and bodies containing literal or recoverably encoded protected values are stored as `empty-truncated`; fully screened text/binary records retain explicit UTF-8/base64 encoding. Configured API keys and extra-header values are redacted from Capture headers, bodies, URL/ID metadata, and debug logs. Independent buffered Metrics inspection is bounded to 8 MiB, SSE inspection is incremental with bounded events, and Responses success requires semantic completion rather than HTTP 2xx alone.

On a clean home, explicit `crp start` privately and atomically creates a missing `.codex` directory and `config.toml`, with no backup for a source that did not exist. New POSIX directory/file modes are `0700`/`0600`; a repeated bootstrap is byte-identical. Existing-file locking, identity/race checks, adjacent backup, mode preservation, and idempotency remain in force.

Exit Codex before a real existing-config transition. Bootstrap compares the root `model_provider` binding's effective `base_url` with the fixed proxy URL using a selected-binding scanner, not a whole-document TOML validator. A different or missing binding triggers discovery; only a nonempty history write set receives private active/archive rollout snapshots, exclusive SQLite logical backups, and a forward journal under `.codex/.crp-history-repair`. Pending repair or a config lock blocks explicit activation/start/restart and automatic crash recovery through one FIFO Codex gate. CRP-internal provider switching never triggers repair. Only provider metadata is rewritten, encrypted content is left intact, and same-URL provider-name changes remain outside the URL-only trigger.

## Credentials

The public Supervisor requires the operating-system native store under service `org.cluic.codex-remote-proxy`. Native construction or operation failure fails closed. The UI, CLI, and Admin API expose no file-backend control. The lower-level private file adapter is limited to trusted dependency injection; a public startup-consent path remains future L3 work, and native operations never replay into the file namespace.

Complete credentials are write-only. They are excluded from public provider projections, state, settings, activity, diagnostics, and errors. Prefer the UI for secret entry. `crp provider add` accepts a required `--api-key` for controlled automation, but command-line values may be exposed through shell history or process inspection.

## Browser Session Boundary

The Admin server binds exactly to `127.0.0.1:15101`, checks `Host` and `Origin`, disables CORS, and requires CSRF for browser mutations. `crp ui` launches with a control token in the URL fragment; the app exchanges it once for an HttpOnly `SameSite=Strict` session cookie plus an in-memory CSRF token, then removes and clears the fragment token.

The Web UI defaults to English on first launch regardless of browser language. Only an explicit `crp.locale` selection may enter browser storage, and a selected `zh-CN` locale is retained on later launches. Session/control/CSRF tokens, credentials, drafts, responses, and errors remain memory-only. Reload with a valid cookie but no launch fragment starts GET-only; an explicit same-origin recovery may rotate that still-valid browser session and restore mutations without extending its expiry. Reopen with `crp ui` after expiry. Launch exchange and later business-session/CSRF failures remain terminal for the tab.

## Commands

```text
crp ui [--no-open] [--json]
crp start [--json]
crp status [--json]
crp stop [--json]
crp restart [--json]
crp shutdown [--json]
crp provider list [--json]
crp provider add --name <NAME> --base-url <URL> --api-key <KEY> [--model <MODEL>] [--json]
crp provider models (--id <ID> | --name <NAME>) [--json]
crp provider test (--id <ID> | --name <NAME>) --model <MODEL> [--json]
crp provider activate (--id <ID> | --name <NAME>) [--json]
crp provider delete (--id <ID> | --name <NAME>) [--json]
crp guide [--json]
```

Use `crp ui` for guided setup and daily management, or `crp start` for headless CLI startup. These are the two supported setup/start entry points.

Human CLI output supports `en` and `zh-CN`. English is the default regardless of process or terminal locale variables. A single global `--locale en|zh-CN` may appear anywhere; Chinese requires explicit `--locale zh-CN` and is never persisted. JSON keys, codes, enums, messages, and actions remain stable English contracts. JSON failures leave stdout empty and write exactly one parseable envelope to stderr.

## License

This package is licensed under the [MIT License](./LICENSE).

Human `provider list` output renders count, active marker, name/ID, query/hash-free base URL, test state, model mode/override, and credential-configured state. Human `status` output renders Supervisor PID/start time; Worker phase/PID/generation/listening/in-flight state; active provider; and Codex, fixed `OpenAI`, and `15100` proxy state. Dynamic terminal text is bounded and escapes control, escape, and bidirectional-control characters; private fields are not rendered.

Root help uses aligned command descriptions and consistent usage/options/examples sections. Exact `-h`/`--help` covers every supported first-level command, the provider group, and provider actions without Supervisor discovery. Flags are recognized only at exact argv positions; trailing or misplaced input remains a validation error.

`stop` stops only the proxy Worker and leaves the Supervisor/Admin API available; `shutdown` stops the Worker and exits the Supervisor. The supported fixed ports remain `15100` for the Worker and `15101` for the Supervisor.

Human success output confirms both processes for `shutdown`. `start` identifies failures as `supervisor_start`, `codex_bootstrap`, or `proxy_start`. Bootstrap failure short-circuits lifecycle mutation; explicit activation/start/restart and unexpected-exit recovery share one FIFO Codex readiness gate. A completed bootstrap remains durable if the proxy phase fails.

Detached Supervisor startup uses a one-shot, strictly allowlisted IPC error. An approved migration-input failure wins over the readiness timeout; malformed, unknown, or unapproved child messages become the generic `SUPERVISOR_START_FAILED` contract.

The former `init`, `install`, and `setup` compatibility aliases are removed. Each returns `CLI_COMMAND_REMOVED` locally without Supervisor discovery or mutation and points to `crp ui` or `crp start`. `check`, `capture on|off|status`, `guide`, and the deprecated `install-cli` shim command remain; there are no provider-update, Activity, Settings, or diagnostics CLI commands.

Optional `provider add --model <MODEL>` uses that value only for the follow-up Responses test; routing override remains `--model-mode override --model-override <MODEL>`. It saves the profile first, then tests, and creation remains committed when the compatibility result fails or the second-stage request cannot complete. `provider test`, `activate`, `delete`, and `models` require exactly one of `--id` or case-insensitive exact `--name`. `provider models` refreshes the authenticated, no-redirect `<base-url>/models` catalog and rejects a complete credential reflected in any model ID before cache or output; discovery failure preserves the last good cache and does not change provider test or activation state.

CLI tests and ordinary Web Providers-page tests request `activateIfNone` so the first successfully tested Provider is selected through a first-wins compare-and-set while the Worker is stopped. That initial selection never starts or reconfigures the Worker, never calls the readiness-gated explicit activation route, and is confirmed from refreshed server state; `crp start` remains explicit. Admin calls default `activateIfNone` to false. Conditional Web Setup also opts in and runs `save -> test and CAS select -> Codex bootstrap/history repair -> Worker start`.

## Migration From 0.2.2

Before first startup, stop the old proxy and privately back up the whole CRP home plus Codex configuration. Backups may contain credentials.

The first supervisor startup transactionally reads legacy `config.json` and `node/proxy-config.json` when present, writes collision-safe byte-exact private backups, stores the secret through the required native adapter, creates schema-2 `providers.json` with one inactive and untested `Default` profile, validates the registry, and only then scrubs legacy secret fields. The user must test and activate `Default`; migration does not assume compatibility.

Different credentials in the legacy sources produce `MIGRATION_INPUT_INVALID` before backups, credential operations, registry writes, or source mutation. CRP does not choose one source automatically; resolving a real-home conflict remains an operator-reviewed L3 migration action.

On an ordinary pre-commit failure, CRP attempts reverse-order restoration and removes only transaction-owned registry/credential state. Foreign replacements and all backups are preserved. Committed or rollback-degraded migration codes require CRP to remain stopped while an operator reviews Activity and the private backups; repeated retry or partial manual copying can make an uncertain state worse.

Returning to `0.2.2` requires stopping CRP and restoring the complete pre-upgrade backup as a unit. Schema 2 is not automatically downgraded. Real-home migration, native stores, and rollback are L3 platform operations.

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

The current package-content test requires the exact reviewed 34-file allowlist, including the MIT License, provider-model cache, Codex history-repair, Metrics store, and exactly three generated UI assets. It rejects UI development source, runtime state, credentials, tests, Changesets, logs, databases, and generated output outside the reviewed UI files. Deterministic tests use temporary homes, synthetic credentials, injected credential adapters, and loopback upstreams.

The serial `core-chain` group uses the production CLI/Admin/registry/provider/WorkerManager/forked-worker path and proves switching, in-flight snapshots, restart, shutdown, cleanup, and secret scans. Its injected memory credential adapter and loopback upstreams do not satisfy the separate real native-keyring/external-provider gate.

Final M2E/V8 local verification passes exact `npm test` 463/463 (`412` unit-core + `8` isolated capture + `42` ordinary integration + `1` serial core-chain), Metrics focus 6/6, lint across 33 source files, UI typecheck/build/exact-output verification, package-content 3/3 against the exact 33-file allowlist, Chromium 33/33 with the English/Chinese 1440/1024/390 responsive matrix, zero full/runtime audit vulnerabilities, and the same-state comparison in `../design-qa.md`. Copied-corpus real-home history rehearsal plus cross-platform native/filesystem/ACL/release L3 gates remain open.

Supervisor discovery applies a 2-second liveness probe and returns a client with a separate 30-second operation timeout. Proxy forwarding joins base and incoming URLs structurally, preserving base paths and query parameters while avoiding duplicate path separators. The retained `provider add --api-key <KEY>` behavior and broader child-environment minimization remain explicit future follow-up work and do not block local core completion.

This unreleased behavior change uses the repository-required minor Changeset. Do not run `npm run version-packages` or `npm run release` during feature preparation. See [RELEASING.md](./RELEASING.md) for local evidence and remaining remote/human gates.
