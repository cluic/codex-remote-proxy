# Codex Remote Proxy Product Evolution Design

Date: 2026-07-10

Status: Approved in conversation; written specification pending user review

Mode: Cluic Harness Builder `iterate`

## Idea Triage

This is a current-milestone product enhancement, not a backlog note. It addresses four verified gaps in v0.2.2: provider-bound history visibility, incomplete restart semantics, single-provider persistence, and CLI-only onboarding.

## Product Boundary

- Users: ordinary Codex Desktop users first; developer automation second.
- Core problem: route Codex traffic to multiple compatible upstreams without changing the Codex provider identity or requiring config-file editing.
- MVP: local Web UI plus CLI for provider CRUD, compatibility testing, atomic activation, and reliable worker lifecycle.
- Non-goals: accounts, cloud sync, remote/LAN admin, load balancing, auto failover, desktop shell, and capture-body UI.
- Client: onboarding and guided local management.
- Server: loopback supervisor, provider registry, credentials, Codex bootstrap, worker management.
- Data plane: fixed-port proxy worker with immutable per-request provider snapshots.
- Roles: one authenticated local OS user.
- External services: OpenAI-compatible upstreams and native OS credential stores.
- Verification: two-provider end-to-end switch, history/provider stability, same-port restart, cross-platform E2E, and secret scans.

## Considered Approaches

### A. Single Node Process

Proxy, UI, API, and persistence share one process. It minimizes initial code but takes the UI offline during restart and preserves the existing responsibility coupling.

### B. Supervisor + Proxy Worker — Selected

A long-lived supervisor serves the UI/API and owns persistence. A child worker owns only proxy traffic and can restart independently. This adds an IPC contract but directly satisfies reliable restart and stable management requirements.

### C. Desktop Application + Daemon

Electron or Tauri could provide the most native experience but adds packaging, signing, updater, and platform complexity before npm-based onboarding has been measured.

## Approved Architecture

The supervisor listens on `127.0.0.1:15101`; the worker listens on fixed `127.0.0.1:15100`. Codex is bootstrapped once to `model_provider = "OpenAI"` and the fixed worker URL. Provider activation persists the selected profile and pushes a monotonically increasing immutable snapshot to the worker. Requests capture their snapshot at start so activation never changes an in-flight target or credential.

The supervisor owns worker draining, termination, port-release confirmation, respawn, snapshot delivery, and health verification. It remains reachable throughout a worker restart. Repeated crash recovery uses capped backoff and stops after a bounded threshold.

## Provider and Credential Design

Provider profiles store name, base URL, auth header/scheme, safe extra headers, model passthrough/override policy, credential reference, timestamps, and compatibility-test result. Complete keys are write-only through the Admin API and live in native platform stores. A permission-restricted file backend is an explicit fallback, not the default.

A provider must pass both connection validation and a minimal Responses API request using a selected test model before first activation. Failure returns a stable code and a user action.

## UI Design

The approved direction is a guided utility console. First run presents provider details, test, activate, and Codex bootstrap as a short wizard. Later visits open an overview with active provider, supervisor/worker state, fixed proxy address, recent error, provider switch, and restart actions.

Four pages are in scope: Overview, Providers, Activity, and Settings. Technical details are collapsed by default. Secret values are never prefilled. Status never relies on color alone, controls are keyboard-accessible, and async lifecycle changes are announced.

## Error Handling

- Authentication failure prompts key replacement without echoing the key.
- DNS, TLS, timeout, HTTP 404, and Responses incompatibility are separate errors.
- Port conflicts identify the safe next action and never silently change the fixed URL.
- Worker crashes trigger bounded recovery and sanitized activity events.
- Migration failures restore the prior configuration from backup.
- Concurrent activation/restart mutations return the existing operation instead of racing.

## Impacted Areas

- Code: CLI, proxy server, new supervisor, provider registry, credential adapters, worker protocol, Admin API, static UI.
- Contracts: new registry schema, credential adapter, IPC protocol, HTTP API, migration format.
- Existing behavior: proxy forwarding and optional capture must remain compatible.
- Docs: all harness living docs created with this design.
- Release: npm package contents, platform CI, security review, and migration notes.

## Acceptance Criteria

1. A clean user launches `crp ui` and configures a provider in under five minutes without editing files.
2. Two providers can be created, tested, and activated from the UI.
3. Provider B activation routes new requests to B while an in-flight A request completes against A.
4. Codex continues to use provider key `OpenAI` and the same local proxy URL.
5. Restart keeps the supervisor/UI available and restores the worker on the same port.
6. Existing v0.2.2 configuration migrates transactionally with rollback.
7. No full key appears in API reads, logs, activity, capture headers, diagnostics, fixtures, or diffs.
8. Current proxy tests plus new unit, integration, browser E2E, accessibility, macOS, Windows, and Linux CLI gates pass.

## Scoped Implementation Shape

The next plan will sequence tests and contracts before implementation: worker lifecycle protocol, provider/credential persistence, local API security, guided UI, migration, then cross-platform hardening. The first deliverable remains one end-to-end vertical slice rather than disconnected backend and UI projects.

## Verification and Merge Classification

- Documentation commit: L0; reviewable after doc checks and diff inspection.
- V1 implementation: L3 because it changes credential handling, browser-local security, Codex configuration, migration, and process lifecycle.
- V1 cannot auto-merge. It requires deterministic checks, visual evidence, AI review, rollback evidence, and expert confirmation.

## Documentation Sync

Architecture, API, data, permissions, UI/UX, testing, roadmap, status, handoff, coordination, and durable decisions are represented in the root `docs/` contracts. Changes to implementation facts must update the owning documents in the same review.
