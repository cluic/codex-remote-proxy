# Architecture

## Current State

Version 0.2.2 is a Node CLI plus one proxy process. `crp start` writes a single runtime configuration, patches Codex to use the `OpenAI` provider section, and spawns the proxy. Only capture enablement hot-reloads.

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

- `supervisor`: owns state transitions, admin server, activity records, and child-process lifecycle.
- `provider-registry`: validates and persists non-secret profiles and the active provider ID.
- `credential-store`: exposes get/set/delete by opaque credential reference; implements Keychain, Credential Manager, and file fallback adapters.
- `codex-config`: backs up and idempotently bootstraps the fixed OpenAI provider entry.
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
- Supervisor metadata: `~/.codex-remote-proxy/providers.json` and `state.json`, mode `0600` where supported.
- Credentials: native OS store; `~/.codex-remote-proxy/secrets.json` only after explicit fallback consent.
- Activity events: bounded local JSONL or SQLite store without request/response bodies.
- macOS and Windows receive UI support; Linux uses the same supervisor and CLI without an initial UI guarantee.

## Risks

- Credential backend differences across platforms.
- Atomic activation and in-flight request correctness.
- Port release races during restart.
- Localhost CSRF and DNS-rebinding-style attacks.
- Safe migration from the existing flat secret-bearing configuration.

These areas require integration tests and L3 review before release.
