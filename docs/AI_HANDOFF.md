# AI Handoff

## Product Summary

CRP preserves ChatGPT login/remote features while routing Codex model traffic to an OpenAI-compatible upstream. The approved next milestone adds named providers, reliable lifecycle management, and a local Web UI for ordinary users.

## Current Scope

V1 implementation is underway. Task 1 quality gates and dependencies have landed; no provider-lifecycle product behavior has landed yet. Task 2, stable paths, errors, and Codex bootstrap, is next. Read `docs/PRD.md`, the formal design spec, and `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md` before changing code.

## Architecture

Target: long-lived supervisor control plane plus independent proxy worker. Codex remains on `model_provider = "OpenAI"` and fixed `http://127.0.0.1:15100`; supervisor Admin API defaults to `127.0.0.1:15101`.

## Data and API

- Non-secret profiles live in a schema-versioned registry.
- API keys live in native credential stores with explicit `0600` fallback.
- Local API contract is in `docs/API.md`; data contract is in `docs/DATA_MODEL.md`.

## Permissions

One authenticated local OS user. Admin API is loopback-only, origin/host checked, CSRF protected, and never returns full keys. See `docs/PERMISSIONS.md`.

## Current Progress

Architecture, provider model, core flows, UI direction, errors, testing, and MVP boundary were visually reviewed and approved on 2026-07-10. The written specification and detailed V1 plan are approved, subagent-driven sequential execution is selected, and Task 1 is complete.

## How To Run Current Code

```bash
cd node
npm ci
npm run lint
npm test
npm run test:unit
node bin/crp.mjs --help
```

Do not run `crp start` against a real home directory during tests because it modifies Codex configuration.

## Verification

- Node 22.19 baseline and Task 1 gate: `npm test` passes 12/12 tests and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 22.19 additions: `npm run lint` syntax-checks the current source roots and `npm run test:unit` passes the 12 top-level tests.
- Node 24.2 stability: `node --test test/capture-store.test.mjs` passes 7/7 without hanging after replacing fixed watcher sleeps with bounded condition waits and pre-assertion cleanup.
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
- Keep file-watcher tests condition-based and cleanup-safe across supported Node versions.
