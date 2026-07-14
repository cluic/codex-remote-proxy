# Codex Remote Proxy

`@cluic/codex-remote-proxy` keeps Codex signed in with ChatGPT while routing model requests through a selected OpenAI-compatible provider.

> Release status: npm `0.2.2` is still the published pre-supervisor version and does not include `crp ui`. This document describes the pending next minor release, which must not be published until its external platform and L3 gates pass.

## Requirements and Install After Release

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

## Product Behavior

The UI can create, test, activate, switch, update, and delete named providers; start, stop, and restart the proxy worker; review sanitized activity; inspect read-only settings; and generate in-memory diagnostic summary metadata. A provider must pass an OpenAI Responses compatibility test before activation. The active provider cannot be updated or deleted, even while the worker is stopped; activate another provider first.

Codex remains configured as:

```toml
model_provider = "OpenAI"
```

Its proxy address remains fixed at `http://127.0.0.1:15100`. CRP switches upstreams internally for new requests while in-flight requests retain their starting snapshot.

On a clean home, explicit `crp start` privately and atomically creates a missing `.codex` directory and `config.toml`, with no backup for a source that did not exist. New POSIX directory/file modes are `0700`/`0600`; a repeated bootstrap is byte-identical. Existing-file locking, identity/race checks, adjacent backup, mode preservation, and idempotency remain in force.

## Credentials

The public Supervisor requires the operating-system native store under service `org.cluic.codex-remote-proxy`. Native construction or operation failure fails closed. The UI, CLI, and Admin API expose no file-backend control. The lower-level private file adapter is limited to trusted dependency injection; a public startup-consent path remains future L3 work, and native operations never replay into the file namespace.

Complete credentials are write-only. They are excluded from public provider projections, state, settings, activity, diagnostics, and errors. Prefer the UI for secret entry. `crp provider add` accepts a required `--api-key` for controlled automation, but command-line values may be exposed through shell history or process inspection.

## Browser Session Boundary

The Admin server binds exactly to `127.0.0.1:15101`, checks `Host` and `Origin`, disables CORS, and requires CSRF for browser mutations. `crp ui` launches with a control token in the URL fragment; the app exchanges it once for an HttpOnly `SameSite=Strict` session cookie plus an in-memory CSRF token, then removes and clears the fragment token.

Only an explicit `crp.locale` selection may enter browser storage. Session/control/CSRF tokens, credentials, drafts, responses, and errors remain memory-only. Reload with a valid cookie but no launch fragment is GET-only; reopen with `crp ui` for mutations. Exchange, session, or CSRF authentication failure is terminal for the tab.

## Commands

```text
crp ui [--no-open] [--json]
crp init [--no-open] [--json]
crp start [--json]
crp status [--json]
crp stop [--json]
crp restart [--json]
crp shutdown [--json]
crp provider list|add|test|activate|delete [--json]
crp guide [--json]
```

Human CLI output supports `en` and `zh-CN`. A single global `--locale en|zh-CN` may appear anywhere; resolution is `--locale`, `CRP_LOCALE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, then `en`, and is never persisted. JSON keys, codes, enums, messages, and actions remain stable English contracts. JSON failures leave stdout empty and write exactly one parseable envelope to stderr.

`start`, `install`, and `setup` identify failures as `supervisor_start`, `codex_bootstrap`, or `proxy_start`. Bootstrap failure short-circuits proxy startup, while a completed bootstrap remains durable if the proxy phase fails.

`crp init` is a strict compatibility alias for `crp ui`. It accepts only `--no-open` and `--json`; legacy secret/upstream options, unknown options, and positional arguments fail before discovery or disk writes. It never creates the legacy flat secret configuration.

`crp install` and `crp setup` are deprecated aliases for `crp start`. These three commands accept only `--json`. `check`, `capture on|off|status`, `guide`, and `install-cli` remain implemented compatibility/inspection commands; there are no provider-update, Activity, Settings, or diagnostics CLI commands.

## Migration From 0.2.2

Before first startup, stop the old proxy and privately back up the whole CRP home plus Codex configuration. Backups may contain credentials.

The first supervisor startup transactionally reads legacy `config.json` and `node/proxy-config.json` when present, writes collision-safe byte-exact private backups, stores the secret through the required native adapter, creates schema-2 `providers.json` with one inactive and untested `Default` profile, validates the registry, and only then scrubs legacy secret fields. The user must test and activate `Default`; migration does not assume compatibility.

On an ordinary pre-commit failure, CRP attempts reverse-order restoration and removes only transaction-owned registry/credential state. Foreign replacements and all backups are preserved. Committed or rollback-degraded migration codes require CRP to remain stopped while an operator reviews Activity and the private backups; repeated retry or partial manual copying can make an uncertain state worse.

Returning to `0.2.2` requires stopping CRP and restoring the complete pre-upgrade backup as a unit. Schema 2 is not automatically downgraded. Real-home migration, native stores, and rollback are L3 platform operations.

## Development and Release Gates

```bash
npm ci
npm run lint
npm test
node scripts/run-test-group.mjs core-chain
node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
node --test test/package-content.test.mjs test/native-keyring-smoke.test.mjs test/release-workflows.test.mjs
npm pack --dry-run --json --ignore-scripts
```

The package-content test requires the exact reviewed 30-file allowlist and rejects runtime state, credentials, tests, Changesets, logs, databases, and generated output. Deterministic tests use temporary homes, synthetic credentials, injected credential adapters, and loopback upstreams.

The serial `core-chain` group uses the production CLI/Admin/registry/provider/WorkerManager/forked-worker path and proves switching, in-flight snapshots, restart, shutdown, cleanup, and secret scans. Its injected memory credential adapter and loopback upstreams do not satisfy the separate real native-keyring/external-provider gate.

The current core tree passes 295/295 tests (`262` unit-core, `7` capture, `25` integration, and `1` core-chain), lint across 29 source files, a zero-vulnerability runtime audit, and the exact reviewed 30-file package. A separate local macOS D2 run passed production native Keychain access, detached Supervisor discovery, a real external provider test and proxied Responses request, activate/start/restart/health/stop/shutdown, HTTP `200 OK`, stable Supervisor PID, and worker PID replacement. A separate isolated clean-home run passed detached bootstrap. This completes the local core gate without replacing the cross-platform native, filesystem/ACL, visual, migration, and human L3 release gates.

Supervisor discovery applies a 2-second liveness probe and returns a client with a separate 30-second operation timeout. Proxy forwarding joins base and incoming URLs structurally, preserving base paths and query parameters while avoiding duplicate path separators. The retained `provider add --api-key <KEY>` behavior and broader child-environment minimization remain explicit future follow-up work and do not block local core completion.

This release requires a minor Changeset. Do not run `npm run version-packages` or `npm run release` during feature preparation. See [RELEASING.md](./RELEASING.md) for local evidence and remaining remote/human gates.
