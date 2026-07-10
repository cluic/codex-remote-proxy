# Roadmap

## Current Milestone

M1: design and harness for the multi-provider local management experience.

## MVP Vertical Slices

| Slice | User Value | Status | Verification |
| --- | --- | --- | --- |
| V0: Harness and approved design | Shared product, architecture, security, UI, and test contracts | In review | Doc self-review and user approval |
| V1: Provider lifecycle end to end | Add, test, activate, switch, and restart through local UI without changing Codex provider | Planned | Full acceptance flow in `docs/TESTING.md` |
| V2: Existing-user migration | Upgrade v0.2.2 flat config without losing provider access | Planned | Migration/rollback fixtures on all platforms |
| V3: Cross-platform hardening | Reliable macOS/Windows UI and Linux CLI | Planned | Platform CI, E2E, screenshots, accessibility |

## V1 Internal Delivery Order

1. Supervisor/worker protocol and deterministic process tests.
2. Provider registry, credential adapters, and migration-safe storage.
3. Admin API and security boundary.
4. Onboarding and guided utility UI.
5. Codex bootstrap, end-to-end activation, and restart verification.

## Later

- Launch at login and system tray integrations.
- High-fidelity activity metrics and safe capture tooling.
- Optional provider health monitoring and manual fallback controls.
- Signed installers or a desktop shell only if npm onboarding remains a measured barrier.

## Explicit Non-Goals

Remote administration, accounts, cloud sync, team sharing, load balancing, automatic failover, and capture-body viewing are outside the MVP.
