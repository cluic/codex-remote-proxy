# CRP Core-First CLI and Real-Chain Design

Date: 2026-07-14

Status: Approved by user; implementation and live evidence pending

Mode: Cluic Harness Builder `iterate`

## Idea Triage

This change replaces Web refinement as the active implementation priority. The existing UI remains packaged but frozen while CRP proves that a clean machine can bootstrap Codex, manage a provider, start the fixed proxy, and complete a real upstream request through the CLI. Task 12 release evidence remains parked; it is neither cancelled nor complete.

## Approved Boundary

- Keep the Supervisor, WorkerManager, proxy worker, Admin API `/api/v1`, registry schema version 2, native credential boundary, and fixed settings intact.
- Keep Codex `model_provider = "OpenAI"` and `http://127.0.0.1:15100` intact.
- Do not add a setup aggregation endpoint. CLI and the later Web UI continue to use the existing Admin endpoints and core services.
- Freeze `node/ui/**`, `node/test/e2e/**`, `node/playwright.config.mjs`, `docs/UIUX.md`, and `output/**` until core acceptance is complete.
- Retain the current `provider add --api-key <KEY>` interface in this slice. Its shell-history/process-list exposure is an accepted known risk, not a resolved security claim.
- Do not change package contents merely to separate CLI translations. The CLI dictionaries remain independent from the Web dictionaries but may live in `node/bin/crp.mjs` so the reviewed package allowlist remains stable.

## Current Gaps

1. `bootstrapCodexConfig` assumes both `~/.codex/` and `config.toml` already exist. A clean home therefore reaches the Admin API as generic `INTERNAL_ERROR`.
2. Human CLI text is English-only. `--json` failures are human strings rather than a stable JSON document.
3. `start` performs Supervisor discovery, optional Codex bootstrap, and worker start, but failures do not identify the failed phase or partial progress.
4. Existing tests prove individual production modules and a synthetic CLI lifecycle. No single gate exercises the real CLI adapter, Admin client/server, registry, provider service, WorkerManager, forked worker, and proxy forwarding together.
5. No retained result proves the core path against an operator-authorized real provider, native credential backend, and external upstream.

## Selected Approach

Strengthen the existing shared core incrementally. The Codex adapter gains clean-home creation and stable public errors; the CLI remains an Admin API client and gains an independent bilingual presentation boundary plus staged start errors; integration coverage composes the existing production modules. A separately authorized live-smoke runner supplies real native/upstream evidence.

This is preferred to a CLI-only parallel implementation because it keeps Web and CLI behavior on the same core services. It is preferred to a new one-shot setup endpoint because the current endpoints already express the required state transitions and are consumed by the packaged UI.

## Clean-Home Codex Bootstrap Contract

`POST /api/v1/codex/bootstrap` keeps its empty request body and existing response projection `{ result: { changed, backupCreated } }`.

When `~/.codex/` is missing, bootstrap creates the directory with private `0700` permissions where supported. An existing parent must be a real directory; an unsafe or symbolic-link parent fails closed. Bootstrap then acquires its sidecar lock and treats a missing `config.toml` as empty input.

For a missing file, bootstrap writes the complete fixed OpenAI section through an exclusive same-directory temporary file, `fsync`, `chmod 0600`, and atomic rename. Immediately before rename it verifies that another writer has not created the target. The successful result is `{ changed: true, backupPath: null }`, so the Admin response is `{ changed: true, backupCreated: false }`. No backup is created because no source existed.

For an existing file, the current contract remains: preserve line endings and unrelated sections, compare bytes before mutation, preserve source mode, make an exclusive adjacent backup only when content changes, recheck the source before rename, and avoid a rewrite or backup when already configured. Repeating bootstrap after creation is byte-idempotent.

Expected failures use safe `CrpError` codes rather than falling through to `INTERNAL_ERROR`:

| Code | Meaning | Retry guidance |
| --- | --- | --- |
| `CODEX_CONFIG_PARENT_UNSAFE` | The `.codex` parent is not a safe real directory | Repair the directory and retry |
| `CODEX_CONFIG_BUSY` | Another bootstrap owns the sidecar lock | Wait and retry |
| `CODEX_CONFIG_CHANGED` | The source appeared or changed during bootstrap | Review the current file and retry |
| `CODEX_CONFIG_READ_FAILED` | Existing configuration could not be safely read | Repair permissions or file state |
| `CODEX_CONFIG_WRITE_FAILED` | Private atomic creation/replacement failed | Preserve existing state, repair filesystem access, and retry |

Public messages and details must not contain home paths, config bytes, backup paths, temporary paths, raw causes, or credentials.

## CLI Locale Contract

The only output locales are `en` and `zh-CN`. Locale resolution is:

1. one explicit `--locale <value>` located anywhere in the command line;
2. `CRP_LOCALE`;
3. `LC_ALL`;
4. `LC_MESSAGES`;
5. `LANG`;
6. `en`.

Tags beginning with `zh` after `_` to `-` normalization map to `zh-CN`; tags beginning with `en` map to `en`. Encoding and modifier suffixes such as `.UTF-8` and `@variant` are ignored. An unsupported explicit `--locale` is a validation error before Supervisor discovery or filesystem mutation; unsupported environment values fall through to the next source. Locale is process-local and is never persisted.

The independent CLI dictionaries must have exact key parity. They cover help, validation, status, provider/lifecycle success, guide/check/capture compatibility text, stage names, known errors, actions, and generic fallbacks. Technical commands, paths, URLs, IDs, error codes, enum values, and JSON property names remain literal.

Human output is localized. JSON success shapes remain backward compatible. With `--json`, failure writes exactly one parseable JSON document to stderr, writes nothing to stdout, and exits 1:

```json
{
  "ok": false,
  "command": "start",
  "stage": "codex_bootstrap",
  "error": {
    "code": "CODEX_CONFIG_WRITE_FAILED",
    "message": "Codex configuration could not be written safely.",
    "action": "Repair local filesystem access and retry.",
    "details": {}
  }
}
```

JSON `message` and `action` use the stable English contract; `--locale` changes only human output. A safe Admin `requestId` is retained when present. Unknown errors become a static `CLI_COMMAND_FAILED` projection and never expose `error.message`, `cause`, or `stack`.

## Staged Start Contract

The `start`, `install`, and `setup` aliases retain the same success payload and execute the same ordered phases:

1. `supervisor_start`: discover or start the Supervisor.
2. `codex_bootstrap`: when status is not configured, call `POST /codex/bootstrap` and wait for success.
3. `proxy_start`: call `POST /proxy/start` and wait for the worker public state.

The stable failure stage is included in JSON and used to select localized human guidance. A bootstrap failure prevents `/proxy/start`. A proxy failure does not roll back a successful Codex bootstrap; the error explicitly identifies `proxy_start`, allowing a retry without rewriting the already-idempotent config. No aggregate endpoint or hidden compensation transaction is introduced.

## Verification Model

### Deterministic production-component gate

One isolated-home integration test must execute:

```text
runCli
  -> ensure/discover Supervisor context
  -> real SupervisorClient over loopback HTTP
  -> real Admin server
  -> real registry + provider service
  -> injected in-memory credential adapter
  -> real WorkerManager
  -> real forked proxy worker on 127.0.0.1:15100
  -> deterministic loopback upstreams A and B
```

The test covers provider add/test/activate, clean-home bootstrap, worker start, an actual proxied Responses request, A-to-B switching while an A request is in flight, same-port restart, status, stop, shutdown/cleanup, stable JSON, and complete-secret scans. Only the credential adapter and upstream are substituted so the gate remains deterministic. This gate proves component composition, but it does not by itself prove real native or external-provider behavior.

### Operator-authorized live smoke

Core completion additionally requires one retained live-smoke result using the real CLI code, detached Supervisor, native OS keyring, real WorkerManager/forked worker, fixed proxy port, and an explicitly supplied real provider/model. The runner must:

- require an explicit confirmation flag and required inputs;
- move the secret into memory and remove it from inherited environment before spawning the Supervisor or worker;
- use an isolated directory under the current `$TMPDIR`, never traverse all of `/var/folders`, and refuse occupied fixed ports before mutation;
- create, test, activate, bootstrap, start, and proxy one minimal Responses request;
- verify `OpenAI` and `http://127.0.0.1:15100` in the created Codex config;
- scan captured CLI streams and all isolated-home files for the complete credential before cleanup;
- shut down processes, delete the exact native credential entry, and remove temporary files in `finally`;
- return only stable redacted pass/fail output.

The live run is opt-in, never an ordinary `npm test` or CI requirement, may incur provider cost, and must not be claimed from an injected or loopback-only execution. A cleanup failure is a failed gate.

## Web Compatibility

No Web source changes are allowed in this slice. The existing Web flow already calls the same bootstrap and lifecycle endpoints, so safe clean-home creation and stable Admin error codes improve its future behavior without a core rewrite. UI alignment, step-state rendering, and activation/start presentation remain parked until the core gate passes.

## Deferred Known Risks

- `provider add --api-key <KEY>` can expose a credential through shell history or process inspection; the user explicitly deferred changing this interface.
- Provider command required-field validation currently occurs after Supervisor startup and remains a follow-up unless implementation can correct it without widening this approved slice.
- The Supervisor and worker inherit broader process environment data than the least-privilege target; the live runner must remove its credential before spawn, while general environment minimization remains follow-up hardening.
- The final active provider cannot currently be deleted through the public API, so the live runner requires ownership-proven native-entry cleanup after shutdown.
- Task 12 remote platform/native/visual/migration evidence and expert release approval remain pending and separate from this core milestone.

## Acceptance Criteria

1. A missing `.codex` directory and config are privately and atomically created without a backup; a second bootstrap is a byte-identical no-op.
2. Existing config preservation, locking, backup, race, and permission tests continue to pass.
3. Every supported human CLI path has English and Simplified Chinese output; locale precedence and dictionary parity are deterministic.
4. JSON success remains compatible, and every JSON failure is one stable language-independent document with no secret or raw error leakage.
5. Start failures identify `supervisor_start`, `codex_bootstrap`, or `proxy_start`; later phases do not run after an earlier failure.
6. The deterministic production-component gate passes with no process, port, credential, lock, or temporary-file residue.
7. An authorized live smoke passes against a real provider and native keyring, with retained redacted evidence and successful cleanup.
8. Full tests, lint, audit, package allowlist, secret scans, and affected contract reviews pass without editing Web files.

## Risk and Merge Classification

The documentation is L0. Implementation is L3 because it creates Codex configuration, uses native credentials and a real external provider in the acceptance path, and changes process lifecycle/error behavior. Deterministic checks, live redacted evidence, independent review, rollback/cleanup evidence, and expert confirmation are required before merge or release.
