# Releasing

This package publishes from `node/` through Changesets and GitHub Actions. Ordinary updates use patch Changesets so releases remain on the current minor line. Both preflight and the publication workflow reject a minor or major release until the release policy is deliberately changed, and versioning synchronizes only the npm lockfile root version before opening the release pull request.

## One-Time Publishing Setup

Configure npm Trusted Publishing for `@cluic/codex-remote-proxy`:

- Repository: `cluic/codex-remote-proxy`
- Workflow file: `.github/workflows/release.yml`
- Environment: leave empty unless publishing is intentionally scoped to a GitHub environment

Publishing uses GitHub OIDC and requires no long-lived `NPM_TOKEN`.

## Feature Pull Request

1. Add a patch Changeset under `node/.changeset/` for package behavior changes, as required by release preflight.
2. Run every local gate below on the final tree.
3. Push a branch and open a pull request only after L3 human review is scheduled.
4. Wait for the macOS, Windows, Linux, and release-preflight workflows and retain their run URLs.
5. Attach the macOS and Windows sanitized UI artifacts plus real native-backend smoke evidence.
6. Obtain L3 expert approval before merge.

Every checkout that occurs before pull-request code runs must use `persist-credentials: false`. Native credential smoke jobs must prove the intended Keychain, Credential Manager, or Secret Service backend; a file fallback is not acceptable evidence.

Release preflight requires a complete structured npm audit report. It retries an incomplete report up to three times with each attempt capped at 90 seconds; a completed vulnerability finding fails immediately and is never converted into a passing result.

## Local Deterministic Gate

Do not confuse an injected development wrapper with a production-path smoke.
`runCli(..., { paths: getPaths(tempHome) })` intentionally keeps Supervisor,
Provider, and Codex-bootstrap effects under that temporary home. The direct
source entry below resolves the real `~/.codex` and `~/.codex-remote-proxy` and
must remain read-only unless a real-home L3 operation was explicitly approved:

```bash
npm run dev:cli -- check --json
```

Run from `node/`:

```bash
npm run lint
npm run typecheck:ui
npm run build:ui
npm run verify:ui-build
npm test
node --test test/codex-config.test.mjs test/codex-history-repair.test.mjs
node --test test/crp.test.mjs test/worker-manager.test.mjs test/integration/admin-server.test.mjs test/integration/crp-lifecycle.test.mjs test/integration/worker-restart.test.mjs
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
node --test test/package-content.test.mjs test/native-keyring-smoke.test.mjs test/release-workflows.test.mjs
npm pack --dry-run --json --ignore-scripts
npm run changeset -- status
```

Historical M2D/V7 working-tree evidence on Node 22.19 on 2026-07-16:

- exact full suite: 451/451 total (`401` unit-core + `8` isolated capture + `41` ordinary integration + `1` serial core-chain);
- history/config focus: 98/98;
- strict status/lifecycle and Worker-gate focus: 105/105;
- browser E2E: 41/41;
- syntax check: 31 source files;
- runtime audit: 0 vulnerabilities;
- package-content: 3/3 against the exact reviewed 32-file allowlist;
- diff and sensitive-value scans: pass; both fixed ports released;
- final independent M2D/V7 L3 review: `PASS`, with no unresolved P0/P1/P2.

M2E/V8 final local evidence on 2026-07-16:

- React + TypeScript + Vite source is build-time only; the reviewed package still contains exactly `ui/index.html`, `ui/app.js`, and `ui/styles.css`;
- anonymous Metrics, Provider-card switching, conditional Setup CAS selection, responsive bilingual pages, and the disabled Forwarding Records placeholder are implemented locally;
- the exact package allowlist is now 33 files, adding `src/supervisor/metrics-store.mjs` without publishing `ui-src/` or frontend build tooling;
- exact `npm test` passes 463/463 (`412` unit-core + `8` isolated capture + `42` ordinary integration + `1` serial core-chain); Metrics focus passes 6/6 and lint checks 33 source files;
- UI typecheck/build/exact-output verification and package-content 3/3 against the exact 33-file allowlist pass;
- Chromium passes 33/33, including the complete English/Chinese 1440/1024/390 responsive matrix;
- full and runtime dependency audits report zero vulnerabilities, and `design-qa.md` records the matched same-state visual comparison with no unresolved P0/P1/P2.
- `git diff --check` and production/documentation sensitive-pattern scans pass; independent final review returns `PASS` after resolving all P2 documentation/evidence findings.

V8.1 release-preparation rerun on 2026-07-17:

- the user-authorized temporary Supervisor and Worker were shut down cleanly,
  releasing fixed ports `15100` and `15101`;
- exact `npm test` passes 466/466 (`414` unit-core + `8` isolated Capture +
  `43` ordinary integration + `1` serial core-chain);
- Chromium passes 39/39, and syntax, UI typecheck/build/exact-output,
  package/release 21/21, installed-tarball CLI smoke, Changesets minor status,
  sensitive-pattern, diff, and both dependency-audit gates pass; and
- the direct source CLI projects the real `~/.codex` and
  `~/.codex-remote-proxy`, while the earlier `crpdev` wrapper is confirmed to
  be intentionally isolated through its injected temporary paths.

Publication of changes after `0.4.1` remains blocked on deliberate working-tree staging,
copied-real-history rehearsal, remote platform evidence, and final L3 approval.

Current release-preparation adjustments include a shipped MIT License and a
deterministic English default for CLI output and first-time Web sessions. The
Web UI retains only an explicit user language selection.

The final local rerun passes CLI/i18n 30/30, Chromium 39/39, UI
typecheck/build/exact-output, lint, runtime audit, package/release tests 21/21,
the exact 34-file package dry run, and exact `npm test` 467/467 (`415`
unit-core + `8` Capture + `43` ordinary integration + `1` serial core chain).

The 2026-07-18 audit-remediation branch supersedes those aggregate counts for
the current source tree: exact `npm test` passes 519/519 (`458` unit-core +
`9` isolated Capture + `51` ordinary integration + `1` serial core chain),
Chromium passes 46/46, lint checks 33 source files, UI typecheck and exact-build
verification pass, the runtime audit reports zero vulnerabilities, and the
package/release suite passes 21/21 against the exact 34-file dry-run package.
The required Changeset is minor and independent final review reports no
remaining P0-P2. These are local temporary-root and loopback results; they do
not replace the external release gates below.

Historical commits remain Task 11 implementation `d114061`, Task 11 docs `dd4de3f`, Task 12 package/platform gates `af918d5`, and credential-boundary hardening `210cb71`; the then-current M2D/V7 evidence was for its uncommitted reviewed working tree. These local results used temporary roots and synthetic history and do not prove copied-corpus real-home performance/recovery, remote Keychain/Credential Manager/Secret Service behavior, cross-platform filesystem semantics, browser launch behavior, or platform screenshots.

## Migration Review

Treat upgrade and rollback as L3 operations. Before using a real home directory:

1. stop the old proxy;
2. privately back up the entire CRP home and Codex configuration;
3. verify that the first supervisor start retains byte-exact legacy backups, creates schema-3 `custom_only` registry state, and scrubs legacy secret fields only after commit; independently verify byte-exact rollback of the schema-2-to-3 upgrade;
4. test and activate the migrated inactive `Default` provider;
5. inspect Activity for committed or rollback-degraded migration codes before any retry.

Before exercising M2D/V7 history repair, fully stop Codex and use a private copy of a representative history corpus. Verify storage growth, the 300-second bootstrap budget, interruption after each durable phase, forward retry, fixed marker/lock recovery, and byte/logical backup restoration before authorizing any real-home run.

Rollback to `0.2.2` requires the supervisor to be stopped and the complete pre-upgrade backup to be restored as one unit. Do not mix the schema-3 registry with restored flat files. Do not publish until migration and rollback evidence has passed real-platform expert review.

## Release Pull Request and Publish

After a feature pull request merges to `main`, the release workflow opens or updates a strict `changeset-release/*` pull request from `github-actions[bot]`. Review its version and changelog changes, remove or update the dated pre-release notices in all three READMEs, wait for all platform/preflight gates, and merge it only after L3 approval. The workflow then publishes through npm Trusted Publishing.

Do not run these commands during feature preparation:

```bash
npm run version-packages
npm run release
```

As of 2026-07-16, the historical local macOS D2 passed with the production Keychain adapter and a real upstream on its reviewed tree. Remote macOS/Windows/Linux workflow run URLs, remote/cross-platform native-service evidence, Windows screenshots, copied-corpus history repair, real-home migration/rollback, final release L3 approval, pull request, push, merge, versioning, publication, and release are still pending.
