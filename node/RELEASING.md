# Releasing

This package publishes from `node/` through Changesets and GitHub Actions. The currently published version is `0.2.2`; the supervisor, multi-provider, and bilingual local-UI work is an unreleased minor change.

## One-Time Publishing Setup

Configure npm Trusted Publishing for `@cluic/codex-remote-proxy`:

- Repository: `cluic/codex-remote-proxy`
- Workflow file: `.github/workflows/release.yml`
- Environment: leave empty unless publishing is intentionally scoped to a GitHub environment

Publishing uses GitHub OIDC and requires no long-lived `NPM_TOKEN`.

## Feature Pull Request

1. Add a minor Changeset under `node/.changeset/`.
2. Run every local gate below on the final tree.
3. Push a branch and open a pull request only after L3 human review is scheduled.
4. Wait for the macOS, Windows, Linux, and release-preflight workflows and retain their run URLs.
5. Attach the macOS and Windows sanitized UI artifacts plus real native-backend smoke evidence.
6. Obtain L3 expert approval before merge.

Every checkout that occurs before pull-request code runs must use `persist-credentials: false`. Native credential smoke jobs must prove the intended Keychain, Credential Manager, or Secret Service backend; a file fallback is not acceptable evidence.

## Local Deterministic Gate

Run from `node/`:

```bash
npm run lint
npm test
node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
node --test test/package-content.test.mjs test/native-keyring-smoke.test.mjs test/release-workflows.test.mjs
npm pack --dry-run --json --ignore-scripts
npm run changeset -- status
```

Latest code evidence at safety commit `210cb71` on 2026-07-14:

- exact full suite: 258/258 total (`227` core + `7` isolated capture + `24` integration);
- post-security focused tests: 67/67;
- browser E2E: 41/41;
- integration suite: 24/24;
- syntax check: 29 source files;
- runtime audit: 0 vulnerabilities;
- package dry run: exact reviewed 30-file allowlist;
- `actionlint`, workflow policy checks, and independent requirements/quality reviews: approved.

Relevant commits are Task 11 implementation `d114061`, Task 11 docs `dd4de3f`, Task 12 package/platform gates `af918d5`, and credential-boundary hardening `210cb71`. This documentation commit records final local gates; these local results do not prove real Keychain, Credential Manager, or Secret Service behavior, Windows filesystem semantics, browser launch behavior, or platform screenshots.

## Migration Review

Treat upgrade and rollback as L3 operations. Before using a real home directory:

1. stop the old proxy;
2. privately back up the entire CRP home and Codex configuration;
3. verify that the first supervisor start retains byte-exact legacy backups, creates schema-2 registry state, and scrubs legacy secret fields only after commit;
4. test and activate the migrated inactive `Default` provider;
5. inspect Activity for committed or rollback-degraded migration codes before any retry.

Rollback to `0.2.2` requires the supervisor to be stopped and the complete pre-upgrade backup to be restored as one unit. Do not mix the schema-2 registry with restored flat files. Do not publish until migration and rollback evidence has passed real-platform expert review.

## Release Pull Request and Publish

After a feature pull request merges to `main`, the release workflow opens or updates a strict `changeset-release/*` pull request from `github-actions[bot]`. Review its version and changelog changes, remove or update the dated pre-release notices in all three READMEs, wait for all platform/preflight gates, and merge it only after L3 approval. The workflow then publishes through npm Trusted Publishing.

Do not run these commands during feature preparation:

```bash
npm run version-packages
npm run release
```

As of 2026-07-14, remote macOS/Windows/Linux workflow run URLs, real macOS Keychain, Windows Credential Manager, and Linux Secret Service evidence, Windows screenshots, real-home migration/rollback, human L3 expert approval, pull request, push, merge, versioning, publication, and release are still pending.
