# AI Handoff

## Product Summary

CRP preserves ChatGPT login/remote features while routing Codex model traffic to an OpenAI-compatible upstream. The approved next milestone adds named providers, reliable lifecycle management, and a local Web UI for ordinary users.

## Current Scope

V1 implementation is underway. Tasks 1 and 2 have landed; no provider-registry or provider-lifecycle product behavior has landed yet. Task 3, the atomic provider registry, is next. Read `docs/PRD.md`, the formal design spec, and `docs/superpowers/plans/2026-07-10-crp-v1-implementation.md` before changing code.

## Architecture

Landed: shared paths, safe public errors, and idempotent Codex bootstrap with source-EOL preservation, CRP sidecar locking, exclusive adjacent backups, external-change detection, atomic replacement, and permission preservation. Target: long-lived supervisor control plane plus independent proxy worker. Codex remains on `model_provider = "OpenAI"` and fixed `http://127.0.0.1:15100`; supervisor Admin API defaults to `127.0.0.1:15101`.

## Data and API

- Non-secret profiles live in a schema-versioned registry.
- API keys live in native credential stores with explicit `0600` fallback.
- Local API contract is in `docs/API.md`; data contract is in `docs/DATA_MODEL.md`.

## Permissions

One authenticated local OS user. Admin API is loopback-only, origin/host checked, CSRF protected, and never returns full keys. See `docs/PERMISSIONS.md`.

## Current Progress

Architecture, provider model, core flows, UI direction, errors, testing, and MVP boundary were visually reviewed and approved on 2026-07-10. The written specification and detailed V1 plan are approved, subagent-driven sequential execution is selected, and Tasks 1 and 2 are complete.

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
- Node 22.19 Task 2 gate: `node --test test/codex-config.test.mjs` passes 15/15, including deterministic rename failure, exclusive same-timestamp backup collision, busy lock, external source change, CRLF preservation, guide semantics, and all three start aliases; `npm test` passes 27/27, `npm run lint` syntax-checks 9 source files, and `npm audit --omit=dev` reports zero vulnerabilities.
- Node 24.2 stability: `node --test test/capture-store.test.mjs` passes 7/7 without hanging after replacing fixed watcher sleeps with bounded condition waits and pre-assertion cleanup.
- Future V1 gate: the full matrix and acceptance flow in `docs/TESTING.md`.

## Known Risks

Credential migration, localhost browser security, worker IPC, port release races, in-flight activation semantics, secret leakage, and cross-platform atomic rename and permission semantics.

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
- Atomic configuration writes must compare content first and preserve source file permissions.
