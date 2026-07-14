# Roadmap

## Current Milestone

M2A: core-first CLI acceptance is complete locally. Safe clean-home bootstrap, CLI English/Simplified Chinese output, stable staged failures, deterministic D1, the reviewed timeout/URL corrections, and production macOS native-keyring/real-upstream D2 all pass. Web refinement remains frozen, and Task 12 release execution still requires a separate scope and its cross-platform/L3 gates.

## MVP Vertical Slices

| Slice | User Value | Status | Verification |
| --- | --- | --- | --- |
| V0: Harness and approved design | Shared product, architecture, security, UI, and test contracts | Approved | Doc self-review and user approval |
| V1: Provider lifecycle end to end | Add, test, activate, switch, and restart through local UI without changing Codex provider | Local implementation and release gates prepared; external platform evidence and L3 approval pending | Full acceptance flow in `docs/TESTING.md` |
| V2: Existing-user migration | Upgrade v0.2.2 flat config without losing provider access | Transactional implementation and local rollback fixtures landed; real-home L3 platform verification pending | Migration/rollback fixtures plus real-platform review |
| V3: Cross-platform hardening | Reliable macOS/Windows UI and Linux CLI | Workflow and native-smoke harness landed; remote runner results and platform visuals pending | Platform CI run URLs, E2E artifacts, native services, accessibility |
| V4: Core-first CLI proof | Clean-home setup and a verified real provider path before further Web work | Complete locally: clean-home/CLI, deterministic D1, reviewed corrections, and production macOS D2 pass | Production-component integration plus authorized real provider/native-keyring smoke and cleanup evidence |

## Completed Core-First Delivery Record

1. Landed in `1183fb5`: private, atomic, idempotent, backup-free creation of a missing `~/.codex/config.toml`, with stable errors and preserved existing-file behavior.
2. Landed in `1183fb5`: independent CLI `en`/`zh-CN` dictionaries, locale precedence, stable JSON failures, pre-discovery validation, and explicit `supervisor_start` / `codex_bootstrap` / `proxy_start` stages.
3. Landed in `f83c9d6`: serial real CLI/Admin/registry/provider/WorkerManager/forked-worker/proxy composition with an injected memory credential adapter and deterministic loopback upstreams.
4. Completed local D2: production native Keychain, real Dusapi provider test, activate/start/restart/health/stop/shutdown, proxied `/responses` HTTP `200 OK`, stable Supervisor PID, changed worker PID, and cleanup pass; separate clean-home detached bootstrap evidence also passes.
5. Keep the parked Web defects frozen by explicit user decision. Resume Web or Task 12 external release evidence only under a separate scope.

The parked Web work is first-step test-model field alignment, removal of step-1 content from steps 2/3, and fresh browser verification of the real bootstrap/activation/start flow against the corrected core. No Web source, E2E, or visual evidence changed in the core-first slice.

## V1 Internal Delivery Order

1. Landed: supervisor/worker protocol and deterministic process tests.
2. Landed: provider registry, credential adapters, and migration-safe storage.
3. Landed: Admin API, security boundary, and supervisor-backed CLI routing.
4. Implemented and verified: bounded onboarding and guided utility Web UI assets with complete `en`/`zh-CN` runtime dictionaries.
5. Prepared and verified locally: Task 12 exact package-content verification, macOS/Windows/Linux workflow definitions, native credential smoke harness, release preflight, credential-boundary hardening, minor Changeset, and release documentation. Still pending: actual remote runs, platform native/visual/security artifacts, real-home migration/rollback evidence, human L3 expert confirmation, and the pull request through release workflow.

## Task 12 Release Gate

Task 12 remains parked after local core completion. Its prior local evidence remains valid for the `5fecf45` tree, while final release review must use the later implementation tree and fresh cross-platform evidence.

The current core tree passes `npm test` with 296 assertions (`262` unit-core + `8` isolated capture + `25` ordinary integration + `1` serial core-chain), lint across 29 source files, runtime audit with zero vulnerabilities, and the exact reviewed 30-file package check. The previous 41/41 Chromium E2E result remains historical evidence for the unchanged Web source, not a current browser acceptance gate.

- Satisfied locally at the earlier Task 12 documentation tree: Task 11 source `d114061`, Task 11 docs `dd4de3f`, Task 12 gate source `af918d5`, safety source `210cb71`, exact 30-file package allowlist, ordinary minor Changeset status, lint 29, `npm test` 258/258, integration 24/24, Chromium E2E 41/41, audit 0, package-content 3/3, and a clean cached diff check. The later `249c23e` core tree supersedes the current Node count with 296/296; the older commit-bound counts remain historical evidence.
- Pending externally: remote macOS/Windows/Linux workflow URLs and native-service results, macOS/Windows sanitized screenshots, real-home migration/rollback evidence, cross-platform hardlink/`O_NOFOLLOW`/ACL and process evidence, human L3 confirmation, and pull request, push, merge, versioning, publication, and release. Task 12 is not complete.
- Preserve the stable `OpenAI` Codex provider and `http://127.0.0.1:15100` proxy invariants.
- Use synthetic temporary credentials and platform runners; do not exercise a developer's real HOME or credential namespace.
- Push, pull request, merge, versioning, publishing, and release remain prohibited until those gates pass.

## Later

- Launch at login and system tray integrations.
- High-fidelity activity metrics and safe capture tooling.
- Optional provider health monitoring and manual fallback controls.
- Signed installers or a desktop shell only if npm onboarding remains a measured barrier.

## Explicit Non-Goals

Remote administration, accounts, cloud sync, team sharing, load balancing, automatic failover, and capture-body viewing are outside the MVP.
