# Roadmap

## Current Milestone

M2: V1 release readiness. Tasks 1 through 11 are implemented and documented through `d114061` and `dd4de3f`; Task 12 package/platform gates are `af918d5` and credential-boundary hardening is `210cb71`. This documentation commit records final local evidence; remote platform/native/visual/migration evidence, human L3 approval, and pull request, push, merge, versioning, publication, and release remain pending.

## MVP Vertical Slices

| Slice | User Value | Status | Verification |
| --- | --- | --- | --- |
| V0: Harness and approved design | Shared product, architecture, security, UI, and test contracts | Approved | Doc self-review and user approval |
| V1: Provider lifecycle end to end | Add, test, activate, switch, and restart through local UI without changing Codex provider | Local implementation and release gates prepared; external platform evidence and L3 approval pending | Full acceptance flow in `docs/TESTING.md` |
| V2: Existing-user migration | Upgrade v0.2.2 flat config without losing provider access | Transactional implementation and local rollback fixtures landed; real-home L3 platform verification pending | Migration/rollback fixtures plus real-platform review |
| V3: Cross-platform hardening | Reliable macOS/Windows UI and Linux CLI | Workflow and native-smoke harness landed; remote runner results and platform visuals pending | Platform CI run URLs, E2E artifacts, native services, accessibility |

## V1 Internal Delivery Order

1. Landed: supervisor/worker protocol and deterministic process tests.
2. Landed: provider registry, credential adapters, and migration-safe storage.
3. Landed: Admin API, security boundary, and supervisor-backed CLI routing.
4. Implemented and verified: bounded onboarding and guided utility Web UI assets with complete `en`/`zh-CN` runtime dictionaries.
5. Prepared and verified locally: Task 12 exact package-content verification, macOS/Windows/Linux workflow definitions, native credential smoke harness, release preflight, credential-boundary hardening, minor Changeset, and release documentation. Still pending: actual remote runs, platform native/visual/security artifacts, real-home migration/rollback evidence, human L3 expert confirmation, and the pull request through release workflow.

## Task 12 Release Gate

- Satisfied locally: Task 11 source `d114061`, Task 11 docs `dd4de3f`, Task 12 gate source `af918d5`, safety source `210cb71`, exact 30-file package allowlist, and ordinary minor Changeset status. Final-tree evidence is lint 29, `npm test` 258/258 (`227` core + `7` isolated capture + `24` integration), integration 24/24, Chromium E2E 41/41, audit 0, package-content 3/3 against the exact 30-file allowlist, minor Changeset status since `origin/main`, and a clean cached diff check.
- Pending externally: remote macOS/Windows/Linux workflow URLs, real Keychain/Credential Manager/Secret Service evidence, macOS/Windows sanitized screenshots, real-home migration/rollback evidence, human L3 confirmation, and pull request, push, merge, versioning, publication, and release. Task 12 is not complete.
- Preserve the stable `OpenAI` Codex provider and `http://127.0.0.1:15100` proxy invariants.
- Use synthetic temporary credentials and platform runners; do not exercise a developer's real HOME or credential namespace.
- Pending externally: remote macOS/Windows/Linux workflow URLs, real Keychain/Credential Manager/Secret Service proof, macOS/Windows visual attachments, real-home migration/rollback evidence, and L3 expert confirmation.
- Push, pull request, merge, versioning, publishing, and release remain prohibited until those gates pass.

## Later

- Launch at login and system tray integrations.
- High-fidelity activity metrics and safe capture tooling.
- Optional provider health monitoring and manual fallback controls.
- Signed installers or a desktop shell only if npm onboarding remains a measured barrier.

## Explicit Non-Goals

Remote administration, accounts, cloud sync, team sharing, load balancing, automatic failover, and capture-body viewing are outside the MVP.
