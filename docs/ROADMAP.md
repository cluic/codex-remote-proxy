# Roadmap

## Current Milestone

M2E/V8 rebuilds the local Web management application as a Vite + React + TypeScript static SPA using the approved v0 prototype as its visual target without adopting Next.js. The slice preserves the existing session, CSRF, read-only, provider, lifecycle, Codex, activity, and packaging contracts; adds anonymous local aggregate Metrics for operational charts; exposes provider switching from list cards; and reserves a disabled Forwarding Records navigation item marked as not yet available. Capture management and payload viewing remain outside the MVP. Task 12 release execution remains parked behind copied-corpus, cross-platform, and release L3 gates.

V8.1 is the post-acceptance interaction refinement: complete model selectors with manual fallback, fixed non-reflowing feedback, sidebar route/lifecycle controls, explicit bounded recovery from a valid read-only cookie session, and secret-free Provider duplication. It does not add Capture management, remote access, or a new runtime frontend service.

## MVP Vertical Slices

| Slice | User Value | Status | Verification |
| --- | --- | --- | --- |
| V0: Harness and approved design | Shared product, architecture, security, UI, and test contracts | Approved | Doc self-review and user approval |
| V1: Provider lifecycle end to end | Add, test, activate, switch, and restart through local UI without changing Codex provider | Local implementation and release gates prepared; external platform evidence and L3 approval pending | Full acceptance flow in `docs/TESTING.md` |
| V2: Existing-user migration | Upgrade v0.2.2 flat config without losing provider access | Transactional implementation and local rollback fixtures landed; real-home L3 platform verification pending | Migration/rollback fixtures plus real-platform review |
| V3: Cross-platform hardening | Reliable macOS/Windows UI and Linux CLI | Workflow and native-smoke harness landed; remote runner results and platform visuals pending | Platform CI run URLs, E2E artifacts, native services, accessibility |
| V4: Core-first CLI proof | Clean-home setup and a verified real provider path before further Web work | Complete locally: clean-home/CLI, deterministic D1, reviewed corrections, and production macOS D2 pass | Production-component integration plus authorized real provider/native-keyring smoke and cleanup evidence |
| V5: CLI operator output repair | Useful bilingual list/status output, discoverable layered help, and unambiguous lifecycle/alias guidance | Complete locally: focus 24/24, exact full 313/313, lint 29, audit 0, independent review PASS | Locale-explicit CLI output/help tests plus unchanged JSON/Admin/lifecycle regressions |
| V6: Provider discovery and CLI ergonomics | Add and validate providers in one command, operate by memorable names, inspect bounded cached model catalogs, and select the first tested provider without starting the proxy | Complete locally: exact 358/358, focused reviews, lint 30, package 3/3, audit 0, diff check, Chromium 41/41 | Locale-explicit CLI tests, cache/control-plane tests, deterministic lifecycle integration, full suite, lint, audit, secret scan, and L3 design review |
| V7: Codex provider-transition history repair | Keep local historical sessions discoverable when CRP changes Codex's effective provider base URL | Complete locally; no real-home execution was performed | Temporary-root rollout/SQLite fixtures, crash-recovery journal tests, bootstrap integration, full suite, audit, secret scan, and independent L3 review |
| V8: Local Web management rebuild | Replace the legacy UI with a dense v0-aligned operational console, provider quick switching, and privacy-preserving aggregate metrics | Complete locally: exact 463/463, package 3/3, Chromium 33/33, responsive and visual QA pass | Unit/API tests, exact reviewed package allowlist, Chromium E2E, accessibility checks, and desktop/mobile screenshots |

## Active M2E/V8 Final Gate

1. Implemented: the legacy hand-authored Web source is replaced by a build-time Vite + React + TypeScript SPA while production still publishes exactly `ui/index.html`, `ui/app.js`, and `ui/styles.css` with no runtime frontend server, CDN, telemetry, remote fonts, source maps, or dynamic chunks.
2. Implemented: fragment-to-session exchange, cookie-only GET-only re-entry with explicit bounded management recovery, CSRF mutation boundary, terminal auth behavior, locale persistence, write-only credentials, authoritative re-fetches, fixed `OpenAI`, and fixed `15100`/`15101` are preserved.
3. Implemented: responsive Overview, Providers, Activity, System, and conditional resumable Setup. Provider cards expose authoritative quick switching, including explicit start-on-activate labeling when the Worker is stopped.
4. Implemented: independent local aggregate Metrics stores request/result counts, Provider/model distribution, observed Token totals and coverage, and fixed latency histograms in a strict private 32 MiB schema-1 document. It does not persist request IDs, URLs, headers, bodies, session/thread IDs, credentials, raw errors, or exact timings.
5. Implemented: Forwarding Records is one disabled bilingual sidebar item with no route, API call, mock records, or Capture controls.
6. Implemented: the v0 prototype is a visual reference only; its Next.js runtime, mock data, analytics, remote assets, review controls, and fake mutations are not shipped.
7. Verified: Metrics storage focus 6/6; exact 463/463; lint 33; UI typecheck/build/exact-output pass; exact 33-file package 3/3; Chromium 33/33 with keyboard/read-only/security and English/Chinese 1440/1024/390 coverage; audits 0; matched desktop comparison and mobile overflow checks pass in `design-qa.md`.

## Completed M2D/V7 Slice

1. Read the existing root `model_provider` and only that provider section's supported `base_url` binding from the same pre-patch `config.toml` snapshot. A same normalized URL skips history repair even if the provider name changes. A different or missing existing URL triggers discovery; invalid UTF-8 and malformed or ambiguous selected-provider bindings fail closed without writes. This scanner is not a whole-document TOML validator.
2. Rebind every `session_meta.payload.model_provider` under active and archived rollout files, plus `threads.model_provider` in the legacy and discovered current Codex SQLite stores, to the post-bootstrap Codex provider `OpenAI`.
3. Preserve messages, malformed JSONL lines, `cwd`, `has_user_event`, `.codex-global-state.json`, session indexes, file modes, line endings, and rollout mtimes. Detect but never modify `encrypted_content`.
4. For a nonempty history write set, create private byte-exact rollout backups, exclusive fsynced SQLite logical snapshots, and the pending journal before config publication; then publish config and complete history repair through idempotent forward recovery. An empty write set uses the config-only path without a pending journal. An interrupted journaled operation must remain discoverable and must not be skipped merely because config publication already occurred.
5. Reject symlinks, identity changes, unsafe paths, unknown provider bindings, and conflicting pending transitions with stable errors. Bootstrap failure must prevent Worker start and must not be flattened into success.
6. Expose only bounded counts and an encrypted-content warning through the existing additive bootstrap result. Do not expose paths, IDs, message content, provider credentials, or complete API keys.
7. Serialize provider activation, Worker start/restart, and unexpected-exit recovery with bootstrap through one strict Codex readiness gate. Queued automatic recovery must honor stop/close cancellation before spawn.
8. Historical V7 boundary: do not change CRP provider add/test/activate/hot-switch semantics, registry schema 2, fixed Codex provider `OpenAI`, fixed proxy URL `http://127.0.0.1:15100`, Web design/styles/features, manifests, or release operations. Its sole Web-source exception was onboarding request order `bootstrap -> activate -> start`; V8 later supersedes only that historical Web boundary.

Items 1 through 8 are implemented. On Node 22.19, history/config passes 98/98, strict status/lifecycle passes 105/105, and exact `npm test` passes 451/451 (`401` unit-core + `8` isolated capture + `41` ordinary integration + `1` serial core-chain). Lint checks 31 source files, package-content passes 3/3 against the exact 32-file allowlist, runtime audit reports zero vulnerabilities, diff checks pass, and request-order-only Chromium regression passes 41/41. Both fixed ports were free afterward. No gate touched real Codex history, credentials, or an external provider. Final independent L3 review returned `PASS` with no unresolved P0/P1/P2.

## Completed M2C/V6 Slice

1. `provider add` accepts an optional test-only `--model`; creation remains committed if the follow-up compatibility test fails or cannot complete.
2. `provider test`, `activate`, `delete`, and `models` accept exactly one of `--id` or `--name`; names resolve by exact case-insensitive match through the public provider list and receive a per-ID snapshot revalidation before the operation. This is not an atomic server-side name selector; concurrent automation should use immutable IDs.
3. Model discovery uses explicit authenticated `GET <base>/models` refreshes, rejects any model ID containing the complete request credential before persistence or projection, retains only bounded model IDs in an independent schema-version-1 private cache, and leaves the last good cache intact on refresh failure. It does not change provider test or activation state.
4. CLI compatibility tests opt into first-successful-provider selection. The selection uses a registry compare-and-set while the Worker is stopped; it never starts or reconfigures the Worker. Existing Web/Admin tests keep their prior behavior until later Web work.
5. Help uses English unless `--locale zh-CN` is explicitly supplied. Root, command, provider-group, and provider-action help use consistent usage/options/examples sections. `init`, `install`, and `setup` stop executing as aliases and return side-effect-free migration guidance.
6. Keep registry schema 2, Codex provider `OpenAI`, proxy URL `http://127.0.0.1:15100`, Web page source, credentials, manifests, and release operations unchanged.

Items 1 through 6 are implemented. Exact `npm test` passes 358/358 (`320` unit-core + `8` isolated capture + `29` ordinary integration + `1` serial core-chain); model-cache 20/20, CLI 70/70, control-plane 74/74, and post-review risk 157/157 focuses also pass. Lint checks 30 source files, package-content passes 3/3 against the exact 31-file allowlist, runtime audit reports zero vulnerabilities, `git diff --check` passes, and unchanged-Web Chromium passes 41/41. The isolated development Supervisor previously on `15101` was authenticated and shut down normally before D1.

## Completed Core-First Delivery Record

1. Landed in `1183fb5`: private, atomic, idempotent, backup-free creation of a missing `~/.codex/config.toml`, with stable errors and preserved existing-file behavior.
2. Landed in `1183fb5`: independent CLI `en`/`zh-CN` dictionaries, locale precedence, stable JSON failures, pre-discovery validation, and explicit `supervisor_start` / `codex_bootstrap` / `proxy_start` stages.
3. Landed in `f83c9d6`: serial real CLI/Admin/registry/provider/WorkerManager/forked-worker/proxy composition with an injected memory credential adapter and deterministic loopback upstreams.
4. Completed local D2: production native Keychain, real Dusapi provider test, activate/start/restart/health/stop/shutdown, proxied `/responses` HTTP `200 OK`, stable Supervisor PID, changed worker PID, and cleanup pass; separate clean-home detached bootstrap evidence also passes.
5. Repaired detached startup so an exact allowlisted migration-input conflict reaches the CLI before readiness timeout, while malformed or unknown child data remains generic. Divergent sources stay byte-identical with no backup creation, credential-store access, or registry mutation; only the sanitized Activity outcome is recorded.
6. Historical 2026-07-14 decision: keep the then-current Web defects frozen while completing core proof. M2E/V8 now supersedes that pause under the user's later authorization.

Historical note: the core-first slice changed no Web visuals and parked first-step alignment and stale step content. V8 replaced that implementation rather than carrying those defects forward.

## Historical Completed CLI Output Repair

This V5 record describes the reviewed 2026-07-15 tree. Its compatibility-alias behavior was intentionally superseded by V6; the output/status evidence remains historical.

1. Render every safe provider summary in human `provider list` output, including count, active marker, name/ID, query/hash-free base URL, test/model/credential state, and an explicit empty state without exposing private fields.
2. Render Supervisor PID/start time; Worker phase/PID/generation/listening/in-flight; active-provider; and fixed Codex `OpenAI`/`15100` state so a stopped Worker is distinguishable from a running Supervisor.
3. Group root help into recommended, other, and compatibility sections, and resolve every first-level command plus provider group/action `-h`/`--help` locally only at exact syntax positions before Supervisor discovery or mutation; trailing or misplaced input remains invalid.
4. Preserve lifecycle behavior and align success copy: `stop` stops only the Worker; `shutdown` names both stopped processes; `init` labels its `ui` compatibility role; `install`/`setup` label their deprecated `start` role. Recommend only `ui` and `start` as startup entries.
5. Do not change JSON, Admin/API, registry, lifecycle, fixed `OpenAI`/`15100`, Web, package, or Task 12 release contracts.

Items 1 through 5 are implemented. The Node 22 CLI/i18n focus passes 24/24; exact `npm test` passes 313/313 (`277` unit-core + `8` capture + `27` integration + `1` core-chain); lint checks 29 source files; audit reports zero vulnerabilities; independent final code/test review reports `PASS`.

## V1 Internal Delivery Order

1. Landed: supervisor/worker protocol and deterministic process tests.
2. Landed: provider registry, credential adapters, and migration-safe storage.
3. Landed: Admin API, security boundary, and supervisor-backed CLI routing.
4. Implemented and verified: bounded onboarding and guided utility Web UI assets with complete `en`/`zh-CN` runtime dictionaries.
5. Prepared and verified locally: Task 12 exact package-content verification, macOS/Windows/Linux workflow definitions, native credential smoke harness, release preflight, credential-boundary hardening, minor Changeset, and release documentation. Still pending: actual remote runs, platform native/visual/security artifacts, real-home migration/rollback evidence, human L3 expert confirmation, and the pull request through release workflow.

## Task 12 Release Gate

Task 12 remains parked after the completed local core, V5/V6 CLI, V7 history-repair, and locally implemented V8 Web/Metrics slices. Its prior local evidence remains valid only for the reviewed trees, while final release review must use the fully verified V8 tree plus fresh copied-corpus and cross-platform evidence.

The reviewed V5 tree passed `npm test` with 313 assertions (`277` unit-core + `8` isolated capture + `27` ordinary integration + `1` serial core-chain), the CLI/i18n focus with 24/24, lint across 29 source files, and runtime audit with zero vulnerabilities. M2C/V6 superseded that local count with 358/358, and M2D/V7 now supersedes it with the exact 451/451 gate above. The Chromium result covers only the onboarding request-order correction plus regressions, not new Web acceptance; remote release evidence and release review remain pending.

- Satisfied locally at the earlier Task 12 documentation tree: Task 11 source `d114061`, Task 11 docs `dd4de3f`, Task 12 gate source `af918d5`, safety source `210cb71`, exact 30-file package allowlist, ordinary minor Changeset status, lint 29, `npm test` 258/258, integration 24/24, Chromium E2E 41/41, audit 0, package-content 3/3, and a clean cached diff check. The later `249c23e` core tree superseded that count with 296/296; the detached-startup repair tree superseded it with 304/304; V5 superseded it with 313/313; V6 superseded it with 358/358. These remain commit-bound historical evidence; the then-current M2D/V7 exact 451/451 gate is recorded above.
- Pending externally: remote macOS/Windows/Linux workflow URLs and native-service results, macOS/Windows sanitized screenshots, real-home migration/rollback evidence, cross-platform hardlink/`O_NOFOLLOW`/ACL and process evidence, human L3 confirmation, and pull request, push, merge, versioning, publication, and release. Task 12 is not complete.
- Preserve the stable `OpenAI` Codex provider and `http://127.0.0.1:15100` proxy invariants.
- Use synthetic temporary credentials and platform runners; do not exercise a developer's real HOME or credential namespace.
- Push, pull request, merge, versioning, publishing, and release remain prohibited until those gates pass.

## Later

- ChatGPT quota-aware routing, beginning with the read-only feasibility gate in
  `docs/FUTURE_CHATGPT_QUOTA_ROUTING.md`; this remains an explicit opt-in L3
  feature and is not part of the current release.
- Launch at login and system tray integrations.
- Forwarding Records management and separately reviewed safe Capture tooling.
- Optional provider health monitoring and manual fallback controls.
- Signed installers or a desktop shell only if npm onboarding remains a measured barrier.

## Explicit Non-Goals

Remote administration, accounts, cloud sync, team sharing, load balancing, automatic failover, and capture-body viewing are outside the MVP.
