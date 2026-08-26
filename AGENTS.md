# AGENTS.md

## Project Map

- CLI and supervisor entrypoint: `node/bin/crp.mjs`
- Proxy worker: `node/src/server.mjs`
- Provider, credential, and control-plane modules: `node/src/`
- Local Web management UI: `node/ui/` (target architecture)
- Tests: `node/test/`

## Working Rules

- Read this file before editing.
- Implement only within the user-approved scope.
- Keep Codex `model_provider` and the proxy address stable; provider switching belongs inside CRP.
- Never return, log, capture, or commit complete API keys.
- Update affected API, data, permissions, UI/UX, testing, status, and handoff documentation with behavior changes.
- Do not run parallel writable agents without exact scopes and no-edit areas.
- When the user asks to conserve root-agent context, delegate repository reconnaissance and review to a subagent.
- Record reusable work mistakes as one concise required or prohibited sentence.
- Clear secret state and its current DOM value before validation, requests, or re-rendering.
- Cancel stale asynchronous focus callbacks and preserve newer user focus.
- Browser fixtures must mirror production enum values and response contracts.
- Temporary-resource checks must stay within the current `$TMPDIR`; traversing all of `/var/folders` is prohibited.
- Temporary-resource checks must target task-specific glob paths instead of recursively scanning every `$TMPDIR` entry.
- Package-content tests must compare the exact reviewed allowlist.
- CI native-backend gates must probe the intended platform service and must not accept fallback storage.
- Tests must import only declared direct dependencies, and every checkout before pull-request code must set `persist-credentials: false`.
- Secret-bearing negative tests must assert absence before equality so a RED failure cannot print the sentinel.
- CLI human-output tests must set an explicit locale instead of inheriting the developer environment.
- Deterministic loopback D1 evidence must not be reported as native-keyring or external-upstream D2 completion.
- macOS native-keyring tests must isolate CRP paths through `CRP_HOME` while preserving the real `HOME` required to access the login Keychain.
- Read-only diagnostics must not run tests or commands that create temporary resources.
- Detached Supervisor startup failures must preserve only strictly allowlisted errors and must not collapse into readiness timeouts.
- Sensitive-diff scans must use separately quoted simple patterns; nested shell quoting in one composite regex is prohibited.
- Shell search patterns containing backticks must be single-quoted so command substitution cannot occur.
- Automatic first-provider selection must use compare-and-set and must not start or reconfigure the Worker.
- Partial-commit tests must encode deterministic resource order in fixture names instead of relying on filesystem traversal order.
- Replacement-race tests must retain the displaced inode so immediate filesystem inode reuse cannot erase the simulated identity change.
- Public numeric summaries must enforce explicit lower and upper bounds; safe-integer checks alone are insufficient.
- Parallel-write coordination paths must exactly match the files assigned to each agent before writing begins.
- Production recovery adapters must inject every inspection and execution method required by the lower-level recovery contract.
- Any Codex configuration lock must make public readiness false until bootstrap safely resolves it.
- A multi-resource repair may modify only snapshots that were durably backed up in the same attempt.
- Recoverable deletion must use a fixed discoverable intermediate marker; a random claim alone is prohibited.
- Exact Codex provider inspection and patching must share one semantic statement scanner.
- The target config hash must be rechecked before history writes and before pending state is cleared.
- Rollout metadata must be durable before rename, and final verification must fsync every affected parent directory.
- Every committed `pending: true` failure must preserve a discoverable marker or retain the Codex config lock.
- Unexpected Worker recovery must run inside the strict Codex readiness gate and recheck its cancellation generation before spawning.
- When a workspace read returns `EPERM`, rerun the required command with sandbox escalation before attributing it to macOS privacy controls.
- Verify a prior writer's actual status before spawning a replacement for a temporarily missing agent-list entry.
- Response-start metrics must be measured at the first non-empty response body chunk, not when response headers arrive.
- Initialization effects must not depend on state they mutate when cleanup can abort bootstrap.
- Programmatic dialog transitions must cancel stale focus restoration and prioritize explicit autofocus.
- Closed off-canvas navigation must leave the focus and accessibility order.
- Setup selection must use no-start compare-and-set; stopped-worker activation must disclose that it starts the Worker.
- Visually hidden tables must be clipped by a non-table wrapper.
- Metrics storage limits must accommodate every valid maximum-cardinality document.
- Temporary release-smoke cleanup must stay inside its exact `$TMPDIR` root and use an allowed bounded filesystem operation.
- Session-bootstrap routes must compare the raw request target, and tests must preserve non-canonical targets.
- Asynchronous catalog refresh must preserve nonempty manual selections and clear provider-scoped catalogs before switching.
- Zsh scripts must not use `path` as a variable name because it overrides the executable search path.
- Package-manager CLI entry checks must compare canonical filesystem paths so POSIX bin symlinks execute.
- Legacy persisted values accepted by storage validation must remain valid through every downstream runtime validator or be explicitly migrated.
- E2E Metrics fixtures must declare unsaturated conservation assumptions and return the exact requested window shape.
- Overlapping command-output ranges must be de-duplicated before reporting duplicate source content.
- Package and lockfile root versions must remain synchronized.
- UI command-label changes must update every role/name locator in the same edit.
- Debug previews and Capture bodies, metadata, paths, and errors must redact every configured protected value without changing forwarded bytes.
- Protected-value scanning must cover reversible percent, JSON-escape, Base64, base64url, and mixed-case hex representations without emitting decoded metadata.
- Diagnostics must be issued as separate commands instead of chaining them with shell separators.
- Integration tests must await terminal Metrics/Capture settlement before closing the server that owns those resources.
- Routine package updates must use patch Changesets; minor or major releases require an explicit release-policy change.
- Package versioning must refresh the npm lockfile root version before opening a release pull request.
- Version-only release updates must not recalculate or prune the dependency graph.
- Worker protocol shape changes must update every runtime snapshot fixture in the same edit.
- Cross-platform tests that inject a target platform must distinguish host filesystem semantics from generated target-platform semantics.
- Authenticated visual checks must keep control tokens in-process instead of placing them in browser command arguments or logs.
- Custom-provider routing must strip ChatGPT authorization independently of the provider auth-header configuration.
- A block spanning multiple exhausted quota windows must last until the latest exhausted-window reset.
- UI information-architecture changes must update every E2E locator tied to removed headings or containers before the full browser run.
- Fixed-port core-chain verification must inspect active listeners first and must not stop a user-owned CRP service without approval.
- Repository diagnostics must use paths relative to their declared working directory.
- GitHub CLI JSON queries must use fields advertised by the installed `gh` version.
- Retryable POST routing may replay only before upstream delivery is possible; uncertain delivery must cool the provider for later requests.
- Managed startup mutations must prove marker and inode identity, publish without clobber, disable through inert content, and preserve foreign paths and shared-directory modes.
- Running provider pools must reject eligible configuration mutations unless the resulting snapshot is hot-applied and confirmed; failed probes must not invalidate a live snapshot.
- Per-request runtime settings must be captured once and reused by authentication and routing.
- Post-commit audit failures must report committed degradation or remain safely best-effort; they must not misreport the primary mutation as uncommitted.
- Generic feature copy must describe the complete contract instead of naming incidental example models.
- Generated UI verification must use the declared `verify:ui-build` package script.
- UI validation helpers must not introduce non-loopback absolute URL literals.
- Uncommitted Changesets must be validated with plain `changeset status`; `--since` is for committed history.
- Large route-specific payload allowances must not widen the global Admin request-body limit.
- Composite form actions must align with the input control rather than a field wrapper that includes help text.
- npm authentication and registry-version diagnostics must run as separate commands so one failure cannot suppress the other.
- SQLite test fixtures must close every database handle before deleting their temporary directory.
- SVG endpoint labels must anchor inward so platform font metrics cannot overflow the viewport.
- Detached child commands must resolve from an explicitly constructed runtime path instead of assuming an interactive-shell PATH.
- Compact responsive route diagrams must preserve internal containment instead of relying on off-canvas horizontal overflow.
- Conditional routing branches must default to a complete summary and disclose the full rail only after explicit expansion.
- Collapsed controls must be materially shorter than the content they replace; hiding details without reducing chrome is prohibited.
- Routing previews must share the live scheduler and label conditional fallbacks and predicted outlets without claiming a guaranteed final provider.

## Required Checks

- Current test suite: `cd node && npm test`
- Runtime dependency audit: `cd node && npm audit --omit=dev`
- Future UI-bearing changes: run browser E2E and retain visual evidence.
- Future credential, config migration, or lifecycle changes are L3 and require expert confirmation.

## Done Means

- Relevant deterministic checks pass.
- Changed behavior has tests or a documented reason.
- Sensitive values are absent from logs, API responses, fixtures, and diffs.
- Affected public documentation reflects the resulting facts.
- The diff contains no unrelated changes and its merge risk is classified.
