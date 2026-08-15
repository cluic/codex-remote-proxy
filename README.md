![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy

Codex Remote Proxy (CRP) keeps Codex signed in with ChatGPT while routing model traffic to a selected OpenAI-compatible provider. Codex continues to use the built-in `OpenAI` provider identity, so switching upstreams does not move existing OpenAI-tagged threads.

[简体中文](./README.zh-CN.md)

> Release status: npm `0.4.0` is the current release and includes the Supervisor and `crp ui`. Changes after `0.4.0` remain unreleased until their deterministic, platform, and human-review gates pass. Ordinary updates use patch releases.

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

`crp ui` starts or discovers the local supervisor and opens the management UI. The interface starts in English on every browser and supports Simplified Chinese through the language selector. Only an explicitly selected locale is stored in browser storage, so a Chinese selection is retained on later launches.

The current development UI is implemented in `node/ui-src/` with React, TypeScript, and Vite. Those tools are build-time only: the package and Admin server still ship exactly `ui/index.html`, `ui/app.js`, and `ui/styles.css`, with no frontend runtime server, remote font, CDN, telemetry, source map, or dynamic chunk.

## What You Can Manage

The local UI supports the complete daily workflow:

- create named provider profiles;
- enter a credential through a write-only field;
- test OpenAI Responses API compatibility;
- switch eligible providers directly from provider cards;
- replace a credential on an inactive provider or delete an inactive provider;
- start, stop, restart, and inspect the proxy worker;
- inspect anonymous 24-hour or 7-day request, result, observed-Token, model, Provider, and bounded-latency Metrics on Overview;
- review sanitized control-plane Activity and read-only System facts;
- generate an in-memory diagnostic summary containing only creation state, generation time, and sanitized event count.

`Forwarding Records` is visible as a disabled `Coming soon` navigation item. This MVP has no forwarding-record route, request/response viewer, Capture control, or mock traffic data. Overview Metrics is anonymous aggregate state and remains independent from optional Capture. Its 24-hour and 7-day series use fixed UTC hourly buckets. A request counts as successful only after a successful Responses terminal event or completed JSON response; if metric updates were dropped, the UI marks success rates unavailable instead of presenting a precise percentage. Provider and model distributions always retain an explicit grouped remainder.

Provider activation affects new requests. Requests already in flight keep the provider snapshot, including its model policy, with which they started. In `passthrough` mode CRP preserves the client model; in `override` mode it replaces only the top-level JSON `model` value with the Provider's configured model. The explicit activation route is also the production switch operation: it applies a new snapshot to a running Worker and starts a stopped Worker. Initial selection is deliberately different: after a successful compatibility test, Setup, CLI, and the ordinary Providers page all use a first-wins compare-and-set when no Provider is active, while the Worker remains stopped.

Proxy pass-through streams request and response bytes with backpressure and does not auto-decompress request bodies. Model override performs a bounded 8 MiB JSON transformation, preserves gzip, deflate, Brotli, and native zstd encoding when possible, and removes stale body-integrity/signature headers after a rewrite. On Node versions without native zstd compression, a verified single-frame zstd override is forwarded as identity after rewriting; zstd frames that cannot be safely inspected remain byte-exact pass-through for non-override traffic. Client cancellation stops the corresponding upstream work.

Optional Capture stores at most 1 MiB for each request and response body while retaining the total observed byte count. When configured protected values exist, truncated bodies, declared or detected compressed bodies, and bodies containing literal or recoverably encoded protected values are stored as `empty-truncated`; fully screened text/binary records still use explicit UTF-8/base64 encoding. Configured API keys and extra-header values are removed from captured headers, bodies, URL/ID metadata, and debug logs. Buffered Metrics body inspection is independently bounded to 8 MiB, SSE inspection is incremental with bounded events, and neither path enables Capture.

## Stable Codex Configuration

CRP bootstraps Codex once and preserves these invariants:

```toml
model_provider = "OpenAI"
```

```text
http://127.0.0.1:15100
```

Provider switching happens inside CRP. Do not create a different Codex `model_provider` for each upstream and do not change the fixed proxy address during routine switching.

On a clean home, explicit `crp start` creates the missing `.codex` directory and `config.toml` privately and atomically, without creating a backup for a file that did not exist. On supported POSIX systems the new directory is `0700` and the new file is `0600`. Repeating the bootstrap is a byte-identical no-op. An existing config still receives an adjacent private backup only when its content must change, and its unrelated settings, line endings, and mode are preserved.

Before changing an existing Codex-level provider binding, exit Codex completely. Bootstrap reads the root `model_provider` and its supported `base_url` binding from one locked config snapshot. Invalid UTF-8 or a malformed/ambiguous selected-provider binding fails before backup, journal, or config writes; this focused scanner is not a whole-document TOML validator. A different or missing effective URL triggers history discovery. Only a nonempty write set receives private rollout snapshots, exclusive SQLite logical backups, and a forward-recovery journal under `.codex/.crp-history-repair`; an already aligned set uses a config-only commit. CRP then publishes the fixed config and changes only provider metadata in active/archived rollout `session_meta` records and supported `threads.model_provider` columns. A pending repair or config lock makes Codex not ready and blocks activation, Worker start/restart, and automatic crash recovery; the next bootstrap resumes it. Encrypted history content is never rewritten, and the CLI emits a static warning because some encrypted messages may remain unavailable.

Routine CRP provider add/test/activate/hot-switch operations never invoke this repair. Per the URL-only trigger, a provider-name change with the same effective URL does not rewrite history metadata; operators migrating such a custom layout must review it separately. Managed config/history backups can contain private local state and must be protected like the original Codex directory.

## Credential Safety

The public Supervisor requires the native operating-system credential store through service `org.cluic.codex-remote-proxy`:

- macOS Keychain;
- Windows Credential Manager;
- a compatible Secret Service on Linux.

If native storage cannot be constructed or later fails, public startup and credential operations fail closed. The current UI, CLI, and Admin API have no file-storage consent or selection control. A lower-level private file adapter remains available only through trusted dependency injection; exposing a startup consent path is future L3 work and no native operation is replayed into that adapter.

The UI never reads a saved key back. Secret fields are blank on edit, and complete keys are excluded from API reads, activity, diagnostics, state files, and logs.

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
crp provider list [--json]
crp provider add --name <NAME> --base-url <URL> --api-key <KEY> [--model <MODEL>] [--json]
crp provider models (--id <ID> | --name <NAME>) [--json]
crp provider test (--id <ID> | --name <NAME>) --model <MODEL> [--json]
crp provider activate (--id <ID> | --name <NAME>) [--json]
crp provider delete (--id <ID> | --name <NAME>) [--json]
```

The two recommended entry points are `crp ui` for guided setup and daily management, and `crp start` for headless CLI startup. `ui` starts or discovers the Supervisor and opens the management page; `start` starts or discovers the Supervisor, bootstraps the fixed Codex configuration, and starts the proxy Worker.

Every human CLI path supports English and Simplified Chinese. English is the default regardless of `CRP_LOCALE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, or the terminal language. One global `--locale en|zh-CN` may appear anywhere in the command line; use `--locale zh-CN` to request Chinese for that invocation. The choice is process-local and never persisted. Locale changes human output only. With `--json`, a failure writes nothing to stdout and exactly one language-independent error document to stderr.

## License

This project is licensed under the [MIT License](./LICENSE).

Without `--json`, `provider list` renders a count plus each provider's active marker, name, ID, base URL without query/hash, test state, model mode/override, and credential-configured state. `status` renders Supervisor PID/start time, Worker phase/PID/generation/listening/in-flight state, active provider, Codex state, fixed `OpenAI` identity, and the `15100` proxy URL instead of a generic sentence. Dynamic terminal text is length-bounded and escapes control, escape, and bidirectional-control characters; credential references, extra headers, and complete keys are never rendered.

Root help presents aligned command descriptions plus consistent usage, options, and examples. Exact `-h`/`--help` is available for every supported first-level command, the `provider` group, and each provider action; help is resolved locally without starting or discovering the Supervisor. Help flags are parsed only at their exact argv positions, so trailing or misplaced input remains a validation error instead of being silently ignored.

`crp stop` stops only the proxy Worker on `127.0.0.1:15100`; the Supervisor and management API on `127.0.0.1:15101` remain available. Use `crp shutdown` to stop the Worker and exit the Supervisor completely. A running Supervisor after `stop` is therefore expected, and detailed `status` output distinguishes the two processes.

Human success copy preserves those distinctions: `shutdown` confirms both Supervisor and Worker shutdown. `crp start` reports failures at one stable stage: `supervisor_start`, `codex_bootstrap`, or `proxy_start`; `restart` also performs mandatory bootstrap first when Codex is not ready. Explicit activation/start/restart and unexpected-exit recovery share the same FIFO Codex readiness gate. A failed or pending bootstrap prevents lifecycle mutation. A successful config publication is not rolled back after later uncertainty: journaled history work remains pending, while config-only uncertainty is reported separately without claiming a pending repair.

Detached Supervisor startup uses a one-shot, strictly allowlisted IPC error. An approved migration-input failure is returned before the readiness timeout; malformed, unknown, or unapproved child messages become the generic `SUPERVISOR_START_FAILED` contract.

The former compatibility aliases `crp init`, `crp install`, and `crp setup` have been removed. They fail locally with `CLI_COMMAND_REMOVED`, perform no Supervisor discovery or mutation, and point to `crp ui` or `crp start` as the replacement. `check`, `capture on|off|status`, `guide`, and the deprecated local-shim command `install-cli` remain available; the CLI still has no provider-update, Activity, Settings, or diagnostics operation.

`crp provider add` requires a write-only `--api-key` argument and supports advanced authentication and routing options. Optional `--model` is test input only; routing override remains `--model-mode override --model-override <MODEL>`. When `--model` is present, CRP saves the provider first and then runs the Responses compatibility test. The create and test steps are deliberately not one transaction: a failed compatibility result or an operational test error does not delete the saved provider, so the user can inspect and retry it. Command-line secrets may be visible in shell history or process inspection, so this path is intended only for controlled automation.

`provider test`, `activate`, `delete`, and `models` require exactly one selector: `--id` or `--name`. Names resolve by exact case-insensitive match against the unique public provider list. `provider models` performs an authenticated, no-redirect refresh from `<base-url>/models`; the Admin API also exposes a cached read separately. Discovery is bounded and rejects any model ID containing the complete credential before it can reach cache or output. It is independent from Responses compatibility testing, so a missing or incompatible model endpoint does not change provider test or activation state and a failed refresh does not erase the last good catalog.

CLI-triggered compatibility tests, including `provider add --model`, request initial selection only when no Provider is active. The ordinary Web Providers page now makes the same request. The first successful candidate wins an atomic compare-and-set while the Worker is stopped. Selection writes `activeProviderId` but never starts or reconfigures the Worker, never calls the readiness-gated explicit activation route, and is confirmed from refreshed server state; run `crp start` explicitly. Admin callers that omit `activateIfNone` retain non-selecting test behavior. The conditional Web Setup also opts in and runs `save provider -> test and compare-and-set select -> prepare Codex/history repair -> start Worker`.

## Upgrading From 0.2.2

The `0.3` series migrates the pre-supervisor flat configuration to provider-registry schema 2 on first supervisor startup.

1. Stop the old managed proxy.
2. Make a private backup of `~/.codex-remote-proxy/` and `~/.codex/config.toml`. Treat every backup as secret-bearing.
3. Run `crp ui`.
4. Review the migrated provider named `Default`, run its compatibility test, and activate it only after the test passes.

Migration reads the legacy `config.json` and runtime `node/proxy-config.json` when present. It creates collision-safe, byte-exact private backups, stores the credential through the required native backend, creates an inactive and untested schema-2 provider, validates the committed registry, and only then scrubs secret fields from the legacy files. Backups are retained.

If the legacy sources contain different credentials, migration returns `MIGRATION_INPUT_INVALID` before creating backups, accessing credential storage, writing the registry, or changing either source. CRP never chooses one credential automatically; resolve the conflict only through an operator-reviewed real-home migration.

If a transaction fails before commit, CRP attempts to restore the original bytes and remove only registry and credential state that the transaction can prove it owns. It never deletes a foreign replacement. A `MIGRATION_COMMITTED_DEGRADED`, `MIGRATION_COMMITTED_LOCK_DEGRADED`, or `MIGRATION_ROLLBACK_DEGRADED` result means the final state is uncertain or needs repair: stop CRP, do not repeatedly retry, preserve the backups, and review the sanitized Activity error code before changing files. Automatic restoration from a backup is intentionally not attempted in a degraded state.

Rollback to `0.2.2` is not a schema downgrade. Stop CRP first and restore the complete private pre-upgrade backup as one unit; do not copy a secret back into only one legacy file or mix schema-2 registry state with flat configuration. Real-home migration and rollback remain L3 operations and require platform-specific review.

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

Final M2E/V8 local verification passes exact `npm test` 463/463 (`412` unit-core + `8` isolated capture + `42` ordinary integration + `1` serial core-chain), Metrics storage focus 6/6, lint across 33 source files, UI typecheck/build/exact three-file verification, package-content 3/3 against the exact 33-file allowlist, Chromium 33/33 including the English/Chinese 1440/1024/390 responsive matrix, full and runtime audits with zero vulnerabilities, and same-state visual comparison recorded in `design-qa.md`. No deterministic gate is allowed to claim real Codex history, credentials, or an external provider; the earlier local macOS D2 native-Keychain/real-upstream result remains historical evidence for its reviewed tree.

Supervisor discovery uses a bounded 2-second liveness probe while normal Admin operations use a separate 30-second timeout, so a successful provider test is not misreported as `SUPERVISOR_UNAVAILABLE`. Proxy targets are joined structurally, so base URLs with or without a trailing slash produce one path separator.

Release preparation and remaining external gates are documented in [node/RELEASING.md](./node/RELEASING.md).
