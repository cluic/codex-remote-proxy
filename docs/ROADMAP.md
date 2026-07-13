# Roadmap

## Current Milestone

M2: V1 implementation, with Tasks 1 through 11 implemented, verified, and committed through `d114061` plus this documentation closeout; Task 12 release-readiness gates and L3 approval remain.

## MVP Vertical Slices

| Slice | User Value | Status | Verification |
| --- | --- | --- | --- |
| V0: Harness and approved design | Shared product, architecture, security, UI, and test contracts | Approved | Doc self-review and user approval |
| V1: Provider lifecycle end to end | Add, test, activate, switch, and restart through local UI without changing Codex provider | In progress: Tasks 1-11 implemented and deterministically verified; Task 12 platform/release gates and L3 approval remain | Full acceptance flow in `docs/TESTING.md` |
| V2: Existing-user migration | Upgrade v0.2.2 flat config without losing provider access | Core implementation landed; L3 platform verification pending | Migration/rollback fixtures on all platforms |
| V3: Cross-platform hardening | Reliable macOS/Windows UI and Linux CLI | Planned | Platform CI, E2E, screenshots, accessibility |

## V1 Internal Delivery Order

1. Landed: supervisor/worker protocol and deterministic process tests.
2. Landed: provider registry, credential adapters, and migration-safe storage.
3. Landed: Admin API, security boundary, and supervisor-backed CLI routing.
4. Implemented and verified: bounded onboarding and guided utility Web UI assets with complete `en`/`zh-CN` runtime dictionaries.
5. Next: Task 12 package-content verification, macOS/Windows/Linux gates, native credential smoke coverage, platform visual/security review, release documentation, and L3 expert confirmation.

## Task 12 Entry Gate

- Satisfied: exact eight-file Task 11 source commit `d114061` and this documentation closeout are complete, and local `output/` screenshots were not committed.
- Pending: register one exact Task 12 writable scope and no-edit boundary in `docs/AGENT_COORDINATION.md`.
- Preserve the stable `OpenAI` Codex provider and `http://127.0.0.1:15100` proxy invariants.
- Use synthetic temporary credentials and platform runners; do not exercise a developer's real HOME or credential namespace.
- Treat Task 12 as L3, attach macOS/Windows visual and security evidence, and obtain expert confirmation before merge.

## Later

- Launch at login and system tray integrations.
- High-fidelity activity metrics and safe capture tooling.
- Optional provider health monitoring and manual fallback controls.
- Signed installers or a desktop shell only if npm onboarding remains a measured barrier.

## Explicit Non-Goals

Remote administration, accounts, cloud sync, team sharing, load balancing, automatic failover, and capture-body viewing are outside the MVP.
