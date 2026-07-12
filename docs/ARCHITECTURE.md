# Architecture

## Current State

Version 0.2.2 remains a Node CLI plus one proxy process. `crp start` writes a single runtime configuration, bootstraps Codex to use the `OpenAI` provider section, and spawns the proxy. Task 2 has landed shared path and public-error contracts plus an idempotent Codex configuration adapter; the supervisor, provider registry, credential stores, Admin API, and independent worker remain target-state architecture.

## Target Overview

The approved design splits the local application into a long-lived supervisor control plane and a replaceable proxy worker data plane.

```text
Browser UI / crp CLI
          |
          v
Supervisor (127.0.0.1:15101)
  - Admin API and static UI
  - Provider registry
  - Credential adapters
  - Codex config adapter
  - Worker manager and activity log
          |
          | IPC + immutable config snapshots
          v
Proxy Worker (127.0.0.1:15100)
  - HTTP/SSE forwarding
  - Authorization rewrite
  - Per-request provider snapshot
          |
          v
Active OpenAI-compatible upstream
```

## Invariants

1. Codex keeps `model_provider = "OpenAI"` so existing OpenAI-tagged threads remain visible.
2. Codex keeps the fixed proxy address `http://127.0.0.1:15100` after bootstrap.
3. Provider activation affects new requests only; in-flight requests retain their starting snapshot.
4. The supervisor remains available while the worker restarts.
5. The worker never receives unrelated provider credentials.

## Module Boundaries

Landed in Task 2:

- `shared/paths`: derives CRP registry, credential fallback, state, control token, activity, log, Codex configuration, and Codex auth paths from one home root.
- `shared/errors`: defines stable `CrpError` fields and safe public serialization for known and unknown failures.
- `codex-config`: preserves custom providers and source line endings while idempotently bootstrapping the fixed OpenAI provider entry; a sidecar CRP lock serializes writers, changed files receive an exclusive timestamped adjacent backup, and the source is rechecked before atomic mode-preserving replacement.

Remaining target-state boundaries:

- `supervisor`: owns state transitions, admin server, activity records, and child-process lifecycle.
- `provider-registry`: validates and persists non-secret profiles and the active provider ID.
- `credential-store`: exposes get/set/delete by opaque credential reference; implements Keychain, Credential Manager, and file fallback adapters.
- `worker-protocol`: versioned IPC messages for configure, drain, shutdown, health, and events.
- `proxy-worker`: forwards traffic from immutable provider snapshots; does not own persistent configuration.
- `admin-api`: loopback-only versioned HTTP contract used by both UI and CLI.
- `web-ui`: static local app with onboarding and daily management views.

## Lifecycle

- Activate: validate profile → resolve secret → optionally re-test → persist `activeProviderId` → send snapshot generation N+1 → wait for worker acknowledgement.
- Restart: mark restarting → ask worker to drain → enforce timeout → wait for exit and port release → spawn → send active snapshot → require health success.
- Crash: record sanitized error → restart with capped exponential backoff → stop looping after the configured threshold.

## Storage and Deployment

- Package remains distributed through npm.
- The landed path contract reserves `~/.codex-remote-proxy/providers.json`, `secrets.json`, `state.json`, `control-token`, `activity.jsonl`, and `supervisor.log`; modules other than the existing CLI state path have not landed yet.
- Supervisor metadata target: `~/.codex-remote-proxy/providers.json` and `state.json`, mode `0600` where supported.
- Credentials: native OS store; `~/.codex-remote-proxy/secrets.json` only after explicit fallback consent.
- Activity events: bounded local JSONL or SQLite store without request/response bodies.
- Codex configuration replacement holds an exclusive sidecar lock, compares bytes before writing, creates backups with exclusive-copy semantics, rechecks the source before rename, and preserves the source permission mode through same-directory temporary-file `fsync` and rename; unchanged content is neither rewritten nor backed up.
- macOS and Windows receive UI support; Linux uses the same supervisor and CLI without an initial UI guarantee.

## Risks

- Credential backend differences across platforms.
- Atomic activation and in-flight request correctness.
- Port release races during restart.
- Localhost CSRF and DNS-rebinding-style attacks.
- Safe migration from the existing flat secret-bearing configuration.

These areas require integration tests and L3 review before release.
