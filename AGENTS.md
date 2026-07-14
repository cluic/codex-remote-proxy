# AGENTS.md

## Project Map

- CLI and supervisor entrypoint: `node/bin/crp.mjs`
- Proxy worker: `node/src/server.mjs`
- Provider, credential, and control-plane modules: `node/src/` (target architecture; see `docs/ARCHITECTURE.md`)
- Local Web management UI: `node/ui/` (target architecture)
- Tests: `node/test/`
- Living docs: `docs/AI_HANDOFF.md`, `docs/STATUS.md`, `docs/ROADMAP.md`

## Working Rules

- Read this file, `docs/AI_HANDOFF.md`, and `docs/STATUS.md` before editing.
- Do not implement outside the current vertical slice in `docs/ROADMAP.md`.
- Keep Codex `model_provider` and the proxy address stable; provider switching belongs inside CRP.
- Never return, log, capture, or commit complete API keys.
- Update affected API, data, permissions, UI/UX, testing, status, and handoff docs with behavior changes.
- Do not run parallel writable agents without scopes and no-edit areas in `docs/AGENT_COORDINATION.md`.
- When the user asks to conserve root-agent context, delegate reading and reviewing root and `docs/` documentation to a subagent.
- Record reusable work mistakes as one concise required or prohibited sentence.
- Clear secret state and its current DOM value before validation, requests, or re-rendering.
- Cancel stale asynchronous focus callbacks and preserve newer user focus.
- Browser fixtures must mirror production enum values and response contracts.
- Temporary-resource checks must stay within the current `$TMPDIR`; traversing all of `/var/folders` is prohibited.
- Package-content tests must compare the exact reviewed allowlist.
- CI native-backend gates must probe the intended platform service and must not accept fallback storage.
- Tests must import only declared direct dependencies, and every checkout before pull-request code must set `persist-credentials: false`.
- Secret-bearing negative tests must assert absence before equality so a RED failure cannot print the sentinel.

## Required Checks

- Current test suite: `cd node && npm test`
- Runtime dependency audit: `cd node && npm audit --omit=dev`
- Future UI-bearing changes: run browser E2E and attach visual evidence defined in `docs/TESTING.md`.
- Future credential, config migration, or lifecycle changes are L3 and require expert confirmation.

## Done Means

- Relevant deterministic checks pass.
- Changed behavior has tests or a documented reason.
- Sensitive values are absent from logs, API responses, fixtures, and diffs.
- Living docs and `docs/STATUS.md` reflect the resulting facts.
- The diff contains no unrelated changes and its merge risk is classified.
