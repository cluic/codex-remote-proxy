# Product Requirements

## M2E/V8 Local Web Management Outcome

V8 replaces the legacy local Web implementation with a v0-aligned operational console while preserving the established loopback session, CSRF, read-only, lifecycle, provider, Codex, and write-only credential contracts. V8.1 adds a compact sidebar route/lifecycle surface, complete model selection, fixed feedback, explicit bounded read-only recovery, and secret-free Provider duplication. The daily workflow must let a local user understand readiness, inspect anonymous operational trends, switch an eligible Provider globally or from its card, manage Provider configuration, review sanitized Activity, and inspect immutable system facts without using the CLI.

The Overview uses independent anonymous Metrics even when Capture is disabled. It reports bounded request/result counts, observed Token totals and coverage, model/Provider distribution, and histogram-derived latency bounds; it never offers cost claims or per-request inspection. Forwarding Records is explicitly deferred: a disabled bilingual navigation entry communicates availability without a route, data request, Capture toggle, or simulated feature.

## Product Summary

Codex Remote Proxy keeps Codex signed in with ChatGPT while routing model traffic through a user-selected OpenAI-compatible upstream. The current unreleased minor implements a durable local control plane, named provider profiles, bounded provider-model discovery, reliable proxy lifecycle management, complete English/Simplified Chinese human CLI output, and a bilingual browser-based management UI without changing Codex's provider identity during routine use.

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
- When bootstrap changes the Codex-level effective provider URL, privately forward-repair active/archive rollout and SQLite provider metadata; never trigger this from CRP-internal provider switching.
- Atomically switch the active upstream for new requests without restarting Codex.
- Start, stop, and reliably restart the proxy worker from CLI and UI.
- Show supervisor, worker, active provider, health, and actionable lifecycle errors.
- Show independent anonymous 24-hour/7-day aggregate request, result, observed-Token, model, Provider, and bounded-latency Metrics without requiring Capture.
- Provide global sidebar route/lifecycle controls, direct Provider-card switch/duplicate actions, a responsive bilingual Overview/Providers/Activity/System workspace, and conditional resumable Setup.
- Reserve Forwarding Records as a disabled coming-soon navigation item without implementing Capture management or traffic inspection.
- Make human `provider list` and `status` output operationally useful, and provide side-effect-free layered CLI help.
- Let CLI users add and test in one command, address providers by unique name, refresh a bounded cached model list, and automatically select only the first successfully tested provider without starting the Worker.
- Default help to English unless Chinese is explicitly requested, and remove redundant `init`/`install`/`setup` aliases with side-effect-free migration guidance.
- Migrate the existing single-provider CRP configuration without losing settings.

## Non-Goals

- LAN or internet-accessible administration.
- User accounts, cloud sync, or shared team configuration.
- Provider load balancing or automatic failover.
- Electron/Tauri desktop packaging.
- Viewing captured request or response bodies in the UI.
- Automatic launch at login in the first vertical slice.

## Core User Flows

1. First run: fully exit Codex → launch UI → save provider → run compatibility test with first-wins CAS selection → bootstrap the fixed Codex binding and repair history if required → start the Worker → restart Codex once → complete a request. The selection step never starts the Worker.
2. Routine switch: choose another eligible Provider from its card → explicitly activate atomically → apply the snapshot to a running Worker or start a stopped Worker → new requests use it while in-flight requests retain the prior snapshot and history remains visible.
3. Recovery: select Restart Proxy → worker drains or terminates safely → port is released → worker restarts → health check passes or an actionable error appears.
4. CLI first provider: add with optional `--model` → keep the saved profile even if testing fails → on first success select it atomically while the Worker remains stopped → run `crp start` explicitly.
5. CLI provider maintenance: select by unique name or ID → refresh `/models` into the private cache → manually supply a model when discovery is unsupported → test, activate, or delete through the existing ID-addressed Admin operations.
6. Codex binding recovery: fully exit Codex → run `crp start`/`restart` → discover the exact write set → snapshot and journal only when it is nonempty → publish fixed config → repair provider metadata or retain pending for forward retry → allow activation/start/restart/automatic recovery only after strict readiness passes.

## Responsibilities

- Client UI: responsive bilingual conditional Setup, operational Overview Metrics, sidebar route/lifecycle controls, Provider-card switching/duplication and forms, full model selection with manual fallback, sanitized Activity, immutable System facts, safe write-only secret entry, and an inert Forwarding Records placeholder.
- Supervisor/API: validation, provider persistence, credential access, Codex bootstrap, worker lifecycle, audit events.
- Proxy worker: request forwarding, authorization rewrite, stable ingress, in-flight configuration snapshots, optional capture.
- CLI: an approved Admin-contract subset for `ui`, status, proxy lifecycle, and provider list/add/models/test/activate/delete, plus documented inspection commands. Provider mutations accept ID or unique case-insensitive name; optional add `--model` composes create then test without rolling back creation. All human paths support `en`/`zh-CN`, provider/status/model reads render safe public state, and layered help resolves without Supervisor discovery. Help defaults to English unless `--locale zh-CN` is explicit; JSON and start-stage contracts remain language-independent. Removed `init`/`install`/`setup` commands return migration guidance and do nothing. The CLI has no provider update, Activity, Settings, or diagnostics command.

## Success Criteria

- A new user configures a working provider in under five minutes without manually editing a file.
- Two providers can be tested and switched while Codex threads remain visible.
- A different/missing existing Codex effective URL discovers and repairs historical provider metadata without exposing history content, and an interrupted journaled repair cannot activate, start/restart, or automatically recover the Worker until resumed.
- The proxy worker can restart on the same port without taking down the management UI.
- Full API keys never appear in read APIs, logs, capture headers, diagnostics, or repository files.
- A terminal user can distinguish Supervisor and Worker state, inspect multiple safe provider summaries, and discover command/action syntax without `--json` or a running Supervisor.
- A terminal user can add and test in one command, use a memorable provider name for test/activate/delete/model refresh, and start from a correctly selected first provider without an implicit Worker start.
- Overview can report anonymous 24h/7d trends and data-quality limits with Capture disabled, without exposing any per-request record.
- English and Simplified Chinese desktop and narrow-width layouts remain keyboard accessible and free of page-level horizontal overflow.
- macOS and Windows E2E flows pass; Linux CLI regression tests pass.

Final M2E/V8 local evidence passes exact `npm test` 463/463, Metrics 6/6, lint 33, UI typecheck/build/exact-output verification, package-content 3/3 against the exact 33-file allowlist, Chromium 33/33 with English/Chinese 1440/1024/390 coverage, audits 0, and matched visual QA. No deterministic test may be presented as real Codex-history, native-credential, or external-provider evidence. Production macOS D2 remains historical evidence; copied-corpus real-home history repair, remote platforms, and release L3 approval remain criteria.

## Open Decisions

No decision blocks the design. Launch-at-login, Forwarding Records/Capture management, payload inspection, and failover are intentionally deferred.
