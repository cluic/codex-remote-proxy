# Architecture

## Current State

Version 0.2.2 remains the published release. Tasks 2 through 11 have implemented the supervisor control plane, proxy worker, provider and credential persistence, migration, Admin API, supervisor-backed CLI, and the packaged three-file bilingual Web UI. Task 12 local packaging, workflow-policy, and release-documentation gates are prepared at `af918d5`; real macOS/Windows/Linux workflow runs, native credential services, platform screenshots, and L3 expert approval remain release gates.

## Implemented Overview

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

Landed in Tasks 2 through 11:

- `shared/paths`: derives CRP registry, lower-level private credential-adapter, state, control token, activity, log, Codex configuration, and Codex auth paths from one home root.
- `shared/errors`: defines stable `CrpError` fields and safe public serialization for known and unknown failures.
- `codex-config`: preserves custom providers and source line endings while idempotently bootstrapping the fixed OpenAI provider entry; a sidecar CRP lock serializes writers, changed files receive an exclusive timestamped adjacent backup, and the source is rechecked before atomic mode-preserving replacement.
- `provider-schema`: canonicalizes safe URLs, validates auth and extra-header syntax plus complete stored profiles, and builds public provider objects from an explicit allowlist.
- `provider-registry`: synchronously manages provider CRUD, test state, and the active provider ID through strict schema-version-2 documents, lock-serialized reload-before-mutate writes, refreshed defensive reads, and same-directory fsynced `0600` atomic replacement.
- `credential-store`: exposes native and schema-version-1 private adapters behind one asynchronous get/set/has/delete contract without enumeration. The public Supervisor constructs native storage only and fails closed; the file adapter is limited to trusted dependency injection until a separately reviewed L3 startup-consent path exists. Native operations never replay into the independent file namespace.
- `native-keyring`: lazily loads synchronous `@napi-rs/keyring` entries during construction under service `org.cluic.codex-remote-proxy`, supports injected loaders/factories, preserves backend failures only as internal causes, and exposes safe stable errors.
- `file-credential-store`: validates a real private parent and regular private file, opens and identity-checks a descriptor before reading, validates exact secret-only documents, refreshes reads, and serializes clone-before-commit mutations with exclusive `0600` lock and temporary files.
- `runtime-settings`: accepts only positive, strictly increasing safe-integer generations, clone-and-freezes plain settings before replacing one active reference, and exposes only configured state plus generation publicly.
- `proxy forwarding`: optionally captures exactly one runtime snapshot before request-body listeners and pins target, transport, request ID, authentication, extra headers, TLS, timeout, capture context, and logs for that request. Static configuration remains the generation-zero compatibility path. Dynamic health exposes only runtime and capture public state; an unconfigured source never falls back to the static upstream.
- `worker-protocol`: validates exact version-1 parent messages (`configure`, `drain`, `shutdown`, `status`) and child messages (`ready`, `configured`, `drained`, `status`, `fatal`). Configure accepts HTTPS or explicit loopback HTTP only, requires HTTP-token authentication fields, validates the exact final authentication value with Node header rules, and rejects sensitive or authentication-conflicting extra headers. Resolved settings are accepted only inside parent configure messages; child output and sanitized projections contain only allowlisted lifecycle state and stable public errors, and invalid input receives the fixed `worker-fatal` correlation ID.
- `proxy-worker`: creates one runtime settings source and forwarding app after the first valid configure, binds only then, applies strictly increasing generations while ready or running, rejects configure once drain begins, tracks in-flight requests independently of later phase changes, closes the listener and idle keep-alive connections during drain, acknowledges repeated drain requests without leaving the drained phase, closes capture and IPC resources during shutdown, and bounds forced cleanup after parent disconnect even when graceful shutdown is already waiting so a hanging upstream cannot orphan the worker.
- `worker-manager`: serializes lifecycle operations, validates restart snapshots before disturbing the current worker, validates every child message before use, correlates immediately observed acknowledgements by request ID and child epoch, cancels waiters on send failure, confirms configuration health before running, drains and escalates termination within deadlines, retains child control after termination timeout, proves the fixed port free before replacement, and recovers unexpected exits with a cancellable rolling crash window and sanitized public state.
- `activity/migration/provider-service`: persists a bounded sanitized event allowlist, transactionally migrates descriptor-validated legacy files, serializes provider CRUD/test/activation compensation, and exposes start/stop/restart facades that resolve only the active credential and advance confirmed generations.
- `session-auth`: owns one private 32-byte control token plus in-memory expiring browser session/CSRF tokens; existing token files are descriptor-validated and unsafe, malformed, symbolic-link, or broadly accessible files fail closed.
- `admin-api`: enforces the exact loopback Host and Origin, disables CORS, authenticates CLI bearer and browser cookie/CSRF requests, bounds and validates request bodies, dispatches the versioned allowlisted routes, and positively projects provider, worker, status, read-only settings, diagnostic-summary metadata, and error data.
- `supervisor`: requires native credential construction, composes activity and credentials before migration, constructs the registry only after migration, owns worker/provider/auth/Admin services, writes a positive `0600` state projection only after Admin readiness, and performs idempotent reverse-order cleanup on startup failure or signal shutdown.
- `cli-supervisor-client`: discovers and validates the private supervisor state, authenticates to the loopback Admin API, dispatches lifecycle and provider commands, treats `init` as the strict `ui` alias, creates browser sessions for `ui`/`init`, starts a missing supervisor through an injected spawn boundary, rejects legacy secret-bearing flags and positional input, verifies `pid` plus `startedAt` before shutdown signaling, and bounds failed-spawn cleanup.
- `web-ui`: serves only packaged `index.html`, `styles.css`, and `app.js`; exchanges the launch fragment for the browser session, implements complete `en`/`zh-CN` onboarding and daily management views, clears secret state before any request or re-render, disables every mutation in GET-only re-entry, and uses the Admin API as its only state boundary.

## Lifecycle

- Activate: validate profile → resolve secret → optionally re-test → persist `activeProviderId` → send snapshot generation N+1 → wait for worker acknowledgement.
- Restart: mark restarting → ask worker to drain → enforce timeout → wait for exit and port release → spawn → send active snapshot → require health success.
- Crash: record sanitized error → back off 250/500/1000/2000 ms for the first four crashes in a rolling 60-second window → enter `failed` immediately on the fifth crash. The exponential schedule remains capped at 4000 ms, but that fifth in-window delay is not executed.

## Storage and Deployment

- Package remains distributed through npm.
- The landed path contract reserves `~/.codex-remote-proxy/providers.json`, the lower-level injected adapter path `secrets.json`, `state.json`, `control-token`, `activity.jsonl`, and `supervisor.log`; ordinary Supervisor startup does not select `secrets.json`.
- Provider metadata: `~/.codex-remote-proxy/providers.json`, atomically replaced with mode `0600` where supported after complete document validation.
- Supervisor runtime metadata: `~/.codex-remote-proxy/state.json`, atomically written with mode `0600` after Admin readiness and removed only by the owning supervisor instance.
- Credentials: public Supervisor startup requires the native OS store. Native loader or operation failure is a safe backend-unavailable error. `~/.codex-remote-proxy/secrets.json` belongs only to trusted injected lower-level use today; the UI, CLI, and Admin API cannot select it. A future public consent path requires L3 review, and no credential migration or native-operation replay is implicit.
- Activity events: implemented bounded private JSONL without request/response bodies.
- Codex configuration replacement holds an exclusive sidecar lock, compares bytes before writing, creates backups with exclusive-copy semantics, rechecks the source before rename, and preserves the source permission mode through same-directory temporary-file `fsync` and rename; unchanged content is neither rewritten nor backed up.
- Provider-registry mutation holds an exclusive `0600` sidecar lock across disk reload, complete validation, same-directory temporary-file `fsync`, `chmod 0600`, rename, and in-memory replacement; validation or persistence failure leaves the prior in-memory document unchanged. Bounded cleanup preserves primary errors and distinguishes a durable committed/degraded result from a retryable failure; permanent residual locks require explicit repair and restart and are never auto-removed.
- File-credential mutation follows the same conservative durable-commit rules while using a strict schema-version-1 secret-only document. Reads validate the parent and path before opening, verify descriptor identity, and never read secret bytes by path. An exclusive gate covers mutation. Release atomically renames the canonical gate to a unique claim, verifies and removes only that claim, and never deletes the canonical path. The canonical primary lock remains present throughout gate claim validation, so a competing instance that acquires the empty gate still reports busy; foreign or uncertain gate state must prove a canonical blocker before primary release, otherwise the primary lock is retained. Foreign or permanent claimed primary locks likewise restore a nonempty canonical blocker. Permanent secret-temp cleanup failure records uncommitted degradation and stops later mutations before another lock opens. Public errors contain no reference, secret, path, or file bytes.
- The same static UI is packaged on every platform. macOS and Windows are the initial desktop UI priorities, while Linux retains full supervisor/CLI support; real platform acceptance is pending remote workflow evidence.

## Risks

- Credential backend differences across platforms.
- Atomic activation and in-flight request correctness.
- Port release races during restart.
- Localhost CSRF and DNS-rebinding-style attacks.
- Safe migration from the existing flat secret-bearing configuration.
- Provider compatibility tests never follow redirects; 3xx is a stable failure so custom authentication cannot be forwarded to another origin. Active profiles reject every update and deletion until another provider is activated, regardless of worker state.
- Provider-service activation persists the candidate active ID, reconciles committed/degraded persistence from the registry, marks the worker attempt before sending, and applies one selected credential through a strictly increasing snapshot. A health failure or rejected acknowledgement is treated as an unknown worker commit and restores the prior profile with a newer confirmed generation (`1 -> 2 -> 3`); rollback uncertainty is degraded and requires explicit repair.

Deterministic integration and browser tests cover these areas locally. Real native credential services, real-home migration/rollback, cross-platform filesystem/process behavior, macOS/Windows visuals, and localhost browser launch still require platform evidence and L3 expert review before release.
