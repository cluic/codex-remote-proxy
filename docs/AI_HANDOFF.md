# AI Handoff

## Product Summary

CRP preserves ChatGPT login/remote features while routing Codex model traffic to an OpenAI-compatible upstream. The approved next milestone adds named providers, reliable lifecycle management, and a local Web UI for ordinary users.

## Current Scope

Documentation, harness, and implementation planning only. No product implementation from the approved design has landed. Read `docs/PRD.md`, the formal design spec, and `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md` before changing code.

## Architecture

Target: long-lived supervisor control plane plus independent proxy worker. Codex remains on `model_provider = "OpenAI"` and fixed `http://127.0.0.1:15100`; supervisor Admin API defaults to `127.0.0.1:15101`.

## Data and API

- Non-secret profiles live in a schema-versioned registry.
- API keys live in native credential stores with explicit `0600` fallback.
- Local API contract is in `docs/API.md`; data contract is in `docs/DATA_MODEL.md`.

## Permissions

One authenticated local OS user. Admin API is loopback-only, origin/host checked, CSRF protected, and never returns full keys. See `docs/PERMISSIONS.md`.

## Current Progress

Architecture, provider model, core flows, UI direction, errors, testing, and MVP boundary were visually reviewed and approved on 2026-07-10. The written specification is approved and the detailed V1 plan awaits execution-mode selection.

## How To Run Current Code

```bash
cd node
npm ci
npm test
node bin/crp.mjs --help
```

Do not run `crp start` against a real home directory during tests because it modifies Codex configuration.

## Verification

- Current baseline: `cd node && npm test`
- Runtime audit: `cd node && npm audit --omit=dev`
- Future V1 gate: the full matrix and acceptance flow in `docs/TESTING.md`.

## Known Risks

Credential migration, localhost browser security, worker IPC, port release races, in-flight activation semantics, and secret leakage.

## Recent Decisions

- Use harness-builder `iterate` mode.
- Target ordinary users with CLI + local Web UI.
- Support macOS/Windows UI first and preserve Linux CLI.
- Use Supervisor + Proxy Worker.
- Keep Codex provider and proxy URL stable.
- Use guided utility console UI.
- Classify future V1 implementation as L3.
- Execute the approved design through the task sequence in `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md`.
