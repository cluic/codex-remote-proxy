![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy

Codex Remote Proxy (CRP) keeps Codex signed in with ChatGPT while routing model traffic to a selected OpenAI-compatible provider. Codex continues to use the built-in `OpenAI` provider identity, so switching upstreams does not move existing OpenAI-tagged threads.

[简体中文](./README.zh-CN.md)

> Release status: npm `0.2.2` is still the published pre-supervisor version and does not include `crp ui`. The instructions below describe the pending next minor release; its external platform and L3 gates must pass before publication.

## Install After Release

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

`crp ui` starts or discovers the local supervisor and opens the management UI. The interface supports English and Simplified Chinese; choose the language from the header. Only an explicitly selected locale is stored in browser storage.

## What You Can Manage

The local UI supports the complete daily workflow:

- create named provider profiles;
- enter a credential through a write-only field;
- test OpenAI Responses API compatibility;
- activate and switch between tested providers;
- replace a credential on an inactive provider or delete an inactive provider;
- start, stop, restart, and inspect the proxy worker;
- review sanitized activity and read-only settings;
- generate an in-memory diagnostic summary containing only creation state, generation time, and sanitized event count.

Provider activation affects new requests. Requests already in flight keep the provider snapshot with which they started.

## Stable Codex Configuration

CRP bootstraps Codex once and preserves these invariants:

```toml
model_provider = "OpenAI"
```

```text
http://127.0.0.1:15100
```

Provider switching happens inside CRP. Do not create a different Codex `model_provider` for each upstream and do not change the fixed proxy address during routine switching.

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

Reloading a tab with a still-valid session but no launch fragment opens a GET-only workspace. Read operations remain available, but mutation controls stay disabled until the page is reopened with `crp ui`. A failed exchange or later session/CSRF failure is terminal for that tab.

## CLI

The UI is recommended whenever a credential must be entered. These supervisor commands are also available:

```text
crp ui [--no-open] [--json]
crp init [--no-open] [--json]
crp start [--json]
crp status [--json]
crp stop [--json]
crp restart [--json]
crp shutdown [--json]
crp provider list|add|test|activate|delete [--json]
```

`crp init` is a compatibility alias for `crp ui`; it accepts only `--no-open` and `--json`, never prompts for a provider, and never writes the legacy flat configuration. Legacy `--api-key`, `--upstream-base-url`, capture/host/port options, unknown options, and positional arguments are rejected before supervisor discovery or disk mutation.

`crp provider add` supports advanced authentication and model options, but it requires a write-only `--api-key` argument. Command-line secrets may be visible in shell history or process inspection, so this path is intended only for controlled automation. Use `crp guide --json` for the exact machine-readable command shapes.

`crp install` and `crp setup` remain deprecated aliases for supervisor-backed `crp start`. They, and `crp start`, accept only `--json`. Other implemented compatibility/inspection commands are `check`, `capture on|off|status`, `guide`, and `install-cli`; none adds provider update, Activity, Settings, or diagnostics CLI operations.

## Upgrading From 0.2.2

The next minor release migrates the pre-supervisor flat configuration to provider-registry schema 2 on first supervisor startup.

1. Stop the old managed proxy.
2. Make a private backup of `~/.codex-remote-proxy/` and `~/.codex/config.toml`. Treat every backup as secret-bearing.
3. Run `crp ui`.
4. Review the migrated provider named `Default`, run its compatibility test, and activate it only after the test passes.

Migration reads the legacy `config.json` and runtime `node/proxy-config.json` when present. It creates collision-safe, byte-exact private backups, stores the credential through the required native backend, creates an inactive and untested schema-2 provider, validates the committed registry, and only then scrubs secret fields from the legacy files. Backups are retained.

If a transaction fails before commit, CRP attempts to restore the original bytes and remove only registry and credential state that the transaction can prove it owns. It never deletes a foreign replacement. A `MIGRATION_COMMITTED_DEGRADED`, `MIGRATION_COMMITTED_LOCK_DEGRADED`, or `MIGRATION_ROLLBACK_DEGRADED` result means the final state is uncertain or needs repair: stop CRP, do not repeatedly retry, preserve the backups, and review the sanitized Activity error code before changing files. Automatic restoration from a backup is intentionally not attempted in a degraded state.

Rollback to `0.2.2` is not a schema downgrade. Stop CRP first and restore the complete private pre-upgrade backup as one unit; do not copy a secret back into only one legacy file or mix schema-2 registry state with flat configuration. Real-home migration and rollback remain L3 operations and require platform-specific review.

## Development

```bash
cd node
npm ci
npm run lint
npm test
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
npm pack --dry-run --json --ignore-scripts
```

Tests use temporary homes, synthetic credentials, injected adapters, and loopback mock upstreams. Do not run supervisor startup or migration tests against a real home directory.

Release preparation and remaining external gates are documented in [node/RELEASING.md](./node/RELEASING.md).
