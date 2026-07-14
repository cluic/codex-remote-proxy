# CRP Core-First CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Privately bootstrap a clean Codex home, localize human CLI output, stabilize JSON/start failures, and prove the production core with deterministic and explicitly authorized live gates.

**Architecture:** Scope A extends the existing Codex adapter and Supervisor projection; Scope B keeps independent CLI dictionaries, locale resolution, JSON projection, and staging inside `node/bin/crp.mjs`. After both close, D1 serially composes production components and D2 runs only with explicit real-provider/native-keyring authorization.

**Tech Stack:** Node.js ESM 22.13+, `node:test`, existing Supervisor/Admin/ProviderService/WorkerManager/forked worker, loopback HTTP, native `@napi-rs/keyring` for D2 only.

**Design:** `docs/superpowers/specs/2026-07-14-crp-core-first-cli-design.md`

**Status:** Plan complete; implementation and evidence pending.

---

## Scope Guard

- Retain `provider add --api-key <KEY>` unchanged; keep CLI i18n in `node/bin/crp.mjs`; add no runtime module.
- Do not change manifests, package policy/exact 30-path allowlist, `/api/v1`, registry schema 2, `OpenAI`, or `http://127.0.0.1:15100`; add no aggregate setup route.
- Freeze `node/ui/**`, `node/test/e2e/**`, `node/playwright.config.mjs`, `docs/UIUX.md`, and `output/**`.
- General child-environment minimization remains future L3 work; D2 removes only its live credential before CRP process spawn.
- Scope A and B require distinct assigned owners and reciprocal no-edit boundaries; only the minimal D1 RED skeleton runs before they start, then D1 completion/GREEN and D2 run serially after both close in the same working tree.
- Required: verify existing repository paths before assigning planned files.
- Prohibited: do not assign zsh's read-only `status` parameter in verification commands.

## Task A1: Missing Config Safe Create

**Files:** Modify `node/src/codex/codex-config.mjs`; test `node/test/codex-config.test.mjs`.

- [ ] **RED:** From an isolated home without `.codex`, assert `{ changed:true, backupPath:null }`, parent `0700`/file `0600` off Windows, exact fixed content, no backup/temp/lock, and a byte/mtime-identical second call.
- [ ] Run `cd node && node --test test/codex-config.test.mjs`; expect `ENOENT` at lock creation.
- [ ] **Minimal implementation:** Add injected `mkdirSync`/`lstatSync`; create only the real immediate parent, lock it, treat missing target as empty, exclusive-temp write + `fsync` + `chmod 0600`, verify absence, atomic rename, and no backup; preserve the existing-file branch.
- [ ] Rerun the focused file; expect new and existing behavior green.

**Risk:** L3 real filesystem semantics; tests use only their current temporary root.

## Task A2: Creation Races and Cleanup

**Files:** Modify `node/src/codex/codex-config.mjs`; test `node/test/codex-config.test.mjs`.

- [ ] **RED:** Inject re-entrant lock contention, target appearance before rename, parent symlink/non-directory/replacement, and temp open/write/fsync/chmod/rename/cleanup failures; assert foreign state survives, primary error wins, and owned residue is absent.
- [ ] Run the focused file; expect missing-source race/ownership cases to fail.
- [ ] **Minimal implementation:** Revalidate parent/target identity, use exclusive lock/temp ownership, return `CODEX_CONFIG_CHANGED` for a newly appeared target, remove only owned paths, and preserve primary failures over cleanup noise.
- [ ] Run the focused file twice; inspect only each test's `$TMPDIR` root for `.bak`, `.tmp`, `.claim`, or lock residue; never traverse `/var/folders`.

**Risk:** L3 concurrency/ownership; no fixed sleeps or global temp scans.

## Task A3: Stable Public Bootstrap Errors

**Files:** Modify `node/src/codex/codex-config.mjs`, `node/src/supervisor/supervisor.mjs`; test `node/test/codex-config.test.mjs`, `node/test/integration/admin-server.test.mjs`.

- [ ] **RED:** Through real `createSupervisor` + Admin, table-drive `CODEX_CONFIG_PARENT_UNSAFE`, `BUSY`, `CHANGED`, `READ_FAILED`, and `WRITE_FAILED`; assert secret/path/cause/stack absence before exact stable message/action/details/requestId equality.
- [ ] Run `cd node && node --test test/codex-config.test.mjs test/integration/admin-server.test.mjs`; expect raw failures to become `INTERNAL_ERROR`.
- [ ] **Minimal implementation:** Classify adapter phases into safe `CrpError` contracts and pass them through `createCodexService`; keep `POST /codex/bootstrap` body and `{ result:{ changed, backupCreated } }` unchanged.
- [ ] Rerun both files; expect all existing Admin projections green.

**Risk:** L3 public/filesystem contract; never interpolate private causes.

## Task B1: Locale Precedence

**Files:** Modify `node/bin/crp.mjs`, `node/test/crp.test.mjs`; create `node/test/crp-i18n.test.mjs`.

- [ ] **RED:** Assert `--locale` anywhere > `CRP_LOCALE` > `LC_ALL` > `LC_MESSAGES` > `LANG` > `en`; cover `_`/case/encoding/modifier normalization, `zh* -> zh-CN`, `en* -> en`, environment fallthrough, and invalid/duplicate explicit input before discovery/mutation.
- [ ] Run `cd node && node --test test/crp.test.mjs test/crp-i18n.test.mjs`; expect `--locale` rejection.
- [ ] **Minimal implementation:** Strip one global locale pair before parsing, resolve against injected `environment = process.env`, reject unsupported explicit values statically, and never persist locale.
- [ ] Rerun focused tests; assert the scan never consumes another option's value, including `--api-key`.

**Risk:** L1 parsing; retained provider-add syntax is invariant.

## Task B2: Complete Human `en`/`zh-CN`

**Files:** Modify `node/bin/crp.mjs`, `node/test/crp.test.mjs`, `node/test/crp-i18n.test.mjs`.

- [ ] **RED:** Assert exact dictionary-key parity and both locales for help, validation, status, provider/lifecycle success, guide/check/capture compatibility, stage names, known errors/actions, and generic fallback; technical commands/paths/URLs/IDs/codes/enums remain literal.
- [ ] Run focused tests; expect Chinese and parity cases to fail.
- [ ] **Minimal implementation:** Define frozen equal-key dictionaries and formatting helpers in `crp.mjs`; route every human render through keys while leaving JSON success construction unchanged.
- [ ] Run focused tests and `cd node && npm run lint`.

**Risk:** L2 broad presentation surface; interpolate only explicit safe values.

## Task B3: Language-Independent JSON Errors

**Files:** Modify `node/bin/crp.mjs`, `node/test/crp.test.mjs`, `node/test/crp-i18n.test.mjs`.

- [ ] **RED:** For validation, Admin `CrpError`, and a secret-bearing raw error, assert exit 1, empty stdout, exactly one parseable stderr document, identical locales, `{ok:false,command,stage:null,error:{code,message,action,details}}`, optional safe requestId, and absence-before-equality secret/cause/stack checks.
- [ ] Run focused tests; expect current `Error: ...` text and raw message leakage.
- [ ] **Minimal implementation:** Detect JSON intent before parsing, strictly project known safe fields, use fixed English validation contracts, and map unknowns to static `CLI_COMMAND_FAILED`; write stderr once.
- [ ] Rerun focused tests; assert existing JSON successes are byte/shape compatible.

**Risk:** L2 CLI contract; negative RED assertions must never print the sentinel.

## Task C1: Staged Start

**Files:** Modify `node/bin/crp.mjs`, `node/test/crp.test.mjs`, `node/test/crp-i18n.test.mjs`.

- [ ] **RED:** For `start`/`install`/`setup`, fail each phase and assert exact `supervisor_start`, `codex_bootstrap`, or `proxy_start`; localized human guidance; bootstrap short-circuit; no rollback after proxy failure; retry skips configured bootstrap; success aliases remain compatible.
- [ ] Run focused tests; expect missing stages.
- [ ] **Minimal implementation:** Track the stage before ensure, conditional `POST /codex/bootstrap`, and `POST /proxy/start`; attach only that enum to CLI failure projection; add no compensation or endpoint.
- [ ] Rerun focused tests and assert exact Admin request order.

**Risk:** L3 lifecycle semantics; completed bootstrap remains durable.

## Task D1: Serial Production-Component Chain

**Files:** Create `node/test/integration/core-cli-chain.test.mjs`; modify `node/scripts/run-test-group.mjs`, `node/scripts/run-tests.mjs`; production source: none.

- [ ] **RED before Scope A/B starts:** In the current working tree, create only the minimal production-chain skeleton through `runCli -> ensureSupervisor -> SupervisorClient -> createSupervisor` and assert clean-home `start --json` cannot bootstrap. Run `cd node && node --test test/integration/core-cli-chain.test.mjs`; retain the command, tree identity, expected assertion, and safe failing output as RED evidence before assigning either implementation writer.
- [ ] Freeze the D1 file after RED while Scope A/B implement and close; do not ask the post-merge tree to reproduce base behavior and do not create another worktree.
- [ ] **After Scope A/B close, complete D1:** Resume the same test with real Admin/registry/provider service, injected memory credential adapter, WorkerManager, forked worker, fixed proxy, and loopback A/B. Exclude it from parallel integration, add a serial `core-chain` group after ordinary integration, and cover add/test/activate, bootstrap/start, actual Responses forwarding, held A while new traffic switches to B, same-port restart/new PID, status/stop/shutdown, stable JSON, and full-secret scans.
- [ ] In `finally`, release gates, close processes/servers, remove only the isolated root, and prove no state, secret, lock/temp, child, or `15100`/`15101` listener remains.
- [ ] **GREEN:** Run `cd node && node scripts/run-test-group.mjs core-chain` twice, then `npm test`; retain passing evidence separately from the earlier RED record.

**Risk:** L3 fixed ports/processes; preflight ports before mutation and use bounded conditions, not sleeps.

## Task D2: Authorized Real Native/Upstream Gate

**Files:** Create `node/test/live/core-cli-live-smoke.mjs`, `node/test/core-cli-live-smoke.test.mjs`; production source: none.

- [ ] **RED:** Inject process/port/keyring/fs/HTTP boundaries; assert authorization and inputs before mutation, current-`$TMPDIR` containment, occupied-port refusal, credential removal before spawn, redacted streams, `finally` cleanup, and cleanup uncertainty as failure.
- [ ] **Minimal implementation:** Require `--confirm-real-provider-cost` plus `CRP_LIVE_BASE_URL`, `CRP_LIVE_MODEL`, `CRP_LIVE_API_KEY`; move/delete the secret from environment, use one isolated temp home, and invoke real CLI/detached Supervisor without general env minimization.
- [ ] Use unchanged `--api-key` to add/test/activate/bootstrap/start, proxy one minimal Responses request, verify literal `OpenAI`/fixed URL, scan streams/files before cleanup, shut down, delete/verify the exact native credential ref, remove root, and prove ports free; emit only a stable redacted result and never write `output/**`.
- [ ] Run deterministic tests: `cd node && node --test test/core-cli-live-smoke.test.mjs`.
- [ ] With explicit operator approval only: `cd node && CRP_LIVE_BASE_URL='<real-url>' CRP_LIVE_MODEL='<real-model>' CRP_LIVE_API_KEY='<secret>' node test/live/core-cli-live-smoke.mjs --confirm-real-provider-cost`; require exit 0, `Core live smoke passed.`, and retained redacted cleanup evidence.

**Risk:** L3 native secret mutation, cost, external traffic, and cleanup; injected/loopback/cleanup-failed runs cannot satisfy it.

## Final Gate

- [ ] Run focused A/B/Admin/live-harness tests, D1 twice, `cd node && npm run lint && npm test && npm audit --omit=dev`, and `node --test test/package-content.test.mjs` (exact 30 unchanged).
- [ ] Run `git diff --check`, bounded complete-secret/residue scans, independent requirements review, then code-quality/security review.
- [ ] Classify merge L3; update evidence docs only after verified counts, D1, authorized D2, and cleanup confirmation. Do not commit, push, release, or resume Web/Task 12 in this plan.
