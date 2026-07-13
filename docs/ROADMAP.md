# Roadmap

## Current Milestone

M2: V1 implementation, with Tasks 1 through 10 landed and the approved bilingual Web UI implementation in progress.

## MVP Vertical Slices

| Slice | User Value | Status | Verification |
| --- | --- | --- | --- |
| V0: Harness and approved design | Shared product, architecture, security, UI, and test contracts | Approved | Doc self-review and user approval |
| V1: Provider lifecycle end to end | Add, test, activate, switch, and restart through local UI without changing Codex provider | In progress: Tasks 1-10 complete; Overview visual and English/Simplified Chinese UI design approved; implementation and acceptance remain | Full acceptance flow in `docs/TESTING.md` |
| V2: Existing-user migration | Upgrade v0.2.2 flat config without losing provider access | Core implementation landed; L3 platform verification pending | Migration/rollback fixtures on all platforms |
| V3: Cross-platform hardening | Reliable macOS/Windows UI and Linux CLI | Planned | Platform CI, E2E, screenshots, accessibility |

## V1 Internal Delivery Order

1. Landed: supervisor/worker protocol and deterministic process tests.
2. Landed: provider registry, credential adapters, and migration-safe storage.
3. Landed: Admin API, security boundary, and supervisor-backed CLI routing.
4. In progress: bounded onboarding and guided utility Web UI assets with `en`/`zh-CN` runtime dictionaries.
5. Core behavior landed; UI acceptance and L3 platform verification remain for Codex bootstrap, end-to-end activation, and restart.

## Later

- Launch at login and system tray integrations.
- High-fidelity activity metrics and safe capture tooling.
- Optional provider health monitoring and manual fallback controls.
- Signed installers or a desktop shell only if npm onboarding remains a measured barrier.

## Explicit Non-Goals

Remote administration, accounts, cloud sync, team sharing, load balancing, automatic failover, and capture-body viewing are outside the MVP.
