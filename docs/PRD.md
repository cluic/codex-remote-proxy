# Product Requirements

## Product Summary

Codex Remote Proxy keeps Codex signed in with ChatGPT while routing model traffic through a user-selected OpenAI-compatible upstream. The current unreleased minor implements a durable local control plane, named provider profiles, reliable proxy lifecycle management, complete English/Simplified Chinese human CLI output, and a bilingual browser-based management UI without changing Codex's provider identity during routine use.

## Target Users

- Primary: ordinary Codex Desktop users who have an OpenAI-compatible base URL and API key but do not want to edit configuration files.
- Secondary: developers who want bounded CLI automation, UI diagnostic summaries, and multiple provider profiles.
- Initial platform: management UI on macOS and Windows; CLI remains supported on Linux.

## Core Problems

1. Changing Codex `model_provider` changes which historical threads the app lists.
2. The project has no explicit, reliable restart operation.
3. It persists only one flat upstream configuration and has no named provider lifecycle.
4. CLI-only setup excludes users who are uncomfortable with terminals and config files.

## MVP Scope

- `crp ui` starts the local supervisor and opens the management UI.
- Add, edit, test, activate, and delete named provider profiles.
- Require the native OS credential service for the public Supervisor and fail closed when it is unavailable.
- Keep Codex on `model_provider = "OpenAI"` and a fixed loopback proxy URL.
- Safely create a missing Codex configuration during explicit start/bootstrap; keep repeated bootstrap byte-idempotent and back up only changed existing files.
- Atomically switch the active upstream for new requests without restarting Codex.
- Start, stop, and reliably restart the proxy worker from CLI and UI.
- Show supervisor, worker, active provider, health, and actionable lifecycle errors.
- Migrate the existing single-provider CRP configuration without losing settings.

## Non-Goals

- LAN or internet-accessible administration.
- User accounts, cloud sync, or shared team configuration.
- Provider load balancing or automatic failover.
- Electron/Tauri desktop packaging.
- Viewing captured request or response bodies in the UI.
- Automatic launch at login in the first vertical slice.

## Core User Flows

1. First run: launch UI → add provider → run compatibility test → save and activate → patch Codex once → restart Codex once → complete a request.
2. Routine switch: choose another tested provider → activate atomically → new requests use it while history remains visible.
3. Recovery: select Restart Proxy → worker drains or terminates safely → port is released → worker restarts → health check passes or an actionable error appears.

## Responsibilities

- Client UI: onboarding, provider forms, status, lifecycle actions, activity display, safe secret entry.
- Supervisor/API: validation, provider persistence, credential access, Codex bootstrap, worker lifecycle, audit events.
- Proxy worker: request forwarding, authorization rewrite, stable ingress, in-flight configuration snapshots, optional capture.
- CLI: an approved Admin-contract subset for `ui`/`init`, status, proxy lifecycle, and provider list/add/test/activate/delete, plus documented compatibility commands; all human paths support `en`/`zh-CN`, while JSON and start-stage contracts remain language-independent. It has no provider update, Activity, Settings, or diagnostics command.

## Success Criteria

- A new user configures a working provider in under five minutes without manually editing a file.
- Two providers can be tested and switched while Codex threads remain visible.
- The proxy worker can restart on the same port without taking down the management UI.
- Full API keys never appear in read APIs, logs, capture headers, diagnostics, or repository files.
- macOS and Windows E2E flows pass; Linux CLI regression tests pass.

The implementation and latest deterministic code gates satisfy the functional criteria with 296/296 assertions (`262` unit-core + `8` capture + `25` integration + `1` core-chain). D1 includes the serial production-component CLI chain with temporary homes, an injected memory credential adapter, loopback upstreams, A/B switching with an in-flight request, same-port restart, shutdown, cleanup, and secret scans. The prior unchanged-Web browser gate remains historical 41/41 evidence, not current Web acceptance. A separate production macOS D2 passes native Keychain access, real Dusapi provider test and proxied `/responses` HTTP `200 OK`, detached lifecycle including PID-preserving Supervisor restart with worker replacement, and cleanup; separate clean-home detached bootstrap evidence also passes. This completes local core acceptance. Remote platform-native evidence, macOS/Windows UI flows, Linux CLI workflow evidence, real-home migration/rollback, cross-platform filesystem/ACL behavior, and L3 expert approval remain release criteria.

## Open Decisions

No decision blocks the design. Launch-at-login, high-fidelity styling, traffic inspection, and failover are intentionally deferred.
