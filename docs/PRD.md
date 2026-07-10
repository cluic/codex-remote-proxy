# Product Requirements

## Product Summary

Codex Remote Proxy keeps Codex signed in with ChatGPT while routing model traffic through a user-selected OpenAI-compatible upstream. The next product milestone adds a durable local control plane, named provider profiles, reliable proxy lifecycle management, and a browser-based management UI without changing Codex's provider identity during routine use.

## Target Users

- Primary: ordinary Codex Desktop users who have an OpenAI-compatible base URL and API key but do not want to edit configuration files.
- Secondary: developers who want CLI automation, diagnostics, and multiple provider profiles.
- Initial platform: management UI on macOS and Windows; CLI remains supported on Linux.

## Core Problems

1. Changing Codex `model_provider` changes which historical threads the app lists.
2. The project has no explicit, reliable restart operation.
3. It persists only one flat upstream configuration and has no named provider lifecycle.
4. CLI-only setup excludes users who are uncomfortable with terminals and config files.

## MVP Scope

- `crp ui` starts the local supervisor and opens the management UI.
- Add, edit, test, activate, and delete named provider profiles.
- Store API keys in macOS Keychain or Windows Credential Manager, with an explicit `0600` file fallback.
- Keep Codex on `model_provider = "OpenAI"` and a fixed loopback proxy URL.
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
- CLI: automation-compatible access to the same supervisor contracts.

## Success Criteria

- A new user configures a working provider in under five minutes without manually editing a file.
- Two providers can be tested and switched while Codex threads remain visible.
- The proxy worker can restart on the same port without taking down the management UI.
- Full API keys never appear in read APIs, logs, capture headers, diagnostics, or repository files.
- macOS and Windows E2E flows pass; Linux CLI regression tests pass.

## Open Decisions

No decision blocks the design. Launch-at-login, high-fidelity styling, traffic inspection, and failover are intentionally deferred.
