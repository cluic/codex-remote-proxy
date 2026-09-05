# @cluic/codex-remote-proxy

## 0.4.21

### Patch Changes

- 1d6c333: Fix gateway startup and update rollback timeouts on existing Capture databases by preparing the forwarding index in an isolated background worker, safely settling cancellation/shutdown, disclosing temporary recording preparation, and clearing stale Worker errors after a verified successful retry.

## 0.4.20

### Patch Changes

- 790dcd0: Speed up forwarding history with a metadata covering index and route-scoped chart loading; add precise filters, compact responsive records, and accessible request details that preserve the list position and explain errors and payload availability.

## 0.4.19

### Patch Changes

- 0b47394: Route eligible GET `/models` and `/v1/models` requests through the ChatGPT account first, preserving query strings, bypassing Provider model rewrites, and falling back to custom Providers after an account 429 while honoring the latest quota reset.

## 0.4.18

### Patch Changes

- 33ca36d: Route Codex JSON Image Edits through the ChatGPT account, reject malformed edit formats before custom fallback, and make route previews request-format aware.

## 0.4.17

### Patch Changes

- 1cce39c: Add ChatGPT account passthrough for multipart Image Edits requests, including bounded non-file model inspection, transparent account forwarding, no post-delivery replay, and model-only custom-route rewriting.

## 0.4.16

### Patch Changes

- bdf23c2: Forward eligible GPT Image generation requests byte-for-byte through the ChatGPT Codex account route while preserving model-aware custom fallback on explicit quota exhaustion.

## 0.4.15

### Patch Changes

- 80e08d7: Make account-first routing operation-aware, keep direct image API traffic on model-aware custom providers, align route preview with live requests, and record explicit route and provider-selection reasons.

## 0.4.14

### Patch Changes

- 9854e6e: Quarantine safely readable invalid Provider registries into a fixed crash-resumable recovery marker so `crp ui` can open Web Setup without deleting the original registry.

## 0.4.13

### Patch Changes

- 50b6c56: Recover early-version legacy configuration automatically by importing conflicting complete sources as separate inactive Providers or continuing into Web Setup when no complete source exists.

## 0.4.12

### Patch Changes

- c46e86c: Redesign Forwarding Records as an eight-column request ledger with cached Token attribution, a default-off detailed Capture mode, and on-demand privacy-screened request and response inspection.

## 0.4.11

### Patch Changes

- 9b5b944: Replace the Overview traffic trend chart with an accessible 12-week daily Token heatmap backed by compact UTC daily Metrics rollups.

## 0.4.10

### Patch Changes

- a505c3b: Show compact path/query text in Forwarding Records and hide `/models` catalog traffic by default behind a pagination-safe, summary-aware visibility toggle while preserving inclusive API behavior for callers that omit the new option.

## 0.4.9

### Patch Changes

- 449ff19: Record bounded requested and effective forwarded model names in Capture, expose them through searchable Forwarding Records metadata, and show model rewrites in both the records table and detail panel while keeping legacy rows nullable.
- 4d2beb1: Add a compact live Overview route preview that traces account preference, matched routing rules, Provider order, model rewrites, and predicted outlets for an exact model, with conditional fallback rails and advanced retry details available on demand plus a configuration-only fallback while the Worker is stopped.

## 0.4.8

### Patch Changes

- efe7810: Add write-only client API keys with disable, deletion, expiration, and atomic lifetime request limits; make public Worker listening require key authentication while preserving loopback Codex access; and make CLI output default to English with a persistent `crp language` switch for Simplified Chinese.

## 0.4.7

### Patch Changes

- acd663a: Let each routing rule cover multiple exact models, and replace the provider model-list mode editor with a configurable discovery path plus per-model add, manual-entry deletion, enable, and disable controls. Existing model and routing settings migrate without changing their runtime behavior, and edits continue to hot-apply to a running Worker.

## 0.4.6

### Patch Changes

- 6ce3234: Hot-apply provider and model-routing changes, add per-model routing-rule groups and custom provider model availability, allow safe running provider deletion with fallback, and repair detached Codex account monitoring and diagnostics.

## 0.4.5

### Patch Changes

- 85d7314: Add a maintained OpenRouter provider preset, recognize `response.done` usage, keep managed Capture settings authoritative, explain Token observation gaps, add identity-bound CLI version/update commands with automatic rollback, expose build links, and make Overview metrics interactive and fully inspectable.

## 0.4.4

### Patch Changes

- a6ff3ee: Add reusable provider model-mapping groups, persist observed forwarding Token metadata, distinguish completed streams from client aborts, and localize newly supported Activity operations.

## 0.4.3

### Patch Changes

- 623207d: Add metadata-only Forwarding Records with durable provider attribution, safe weighted custom-provider failover, managed user-level start at login, system-aware UI language selection, and compact Overview/System layouts with corrected account-routing and Metrics presentation.

## 0.4.2

### Patch Changes

- 067be9f: Add privacy-bounded Codex account and quota monitoring, an opt-in account-first Responses route with strict rate-limit fallback, transactional schema-3 routing settings, and bilingual management controls.

## 0.4.1

### Patch Changes

- 698f3ac: Synchronize only the package-lock root version during release preparation so version bumps cannot recalculate or prune the reviewed dependency graph.
- 78dce69: Keep ordinary releases on the current minor line by requiring patch Changesets instead of incrementing the minor version for every package behavior update.

## 0.4.0

### Minor Changes

- b61249f: Restore POSIX npm-bin symlink execution and let an ordinary Web compatibility test safely select the first Provider without starting the Worker or calling readiness-gated activation.

  Propagate Provider model policy into Worker snapshots and perform bounded, lexical top-level model rewrites while preserving unrelated JSON bytes and supported content encodings. Stream pass-through traffic with backpressure, cancel upstream work on client disconnect, strip invalid hop-by-hop/integrity headers, and bound/redact Capture and debug observations.

  Classify Responses success from semantic completion, conserve bounded Provider/model distribution remainders, persist saturated Metrics safely, and disclose dropped metric updates instead of showing a precise success rate.

## 0.3.0

### Minor Changes

- 33141f0: Safely bootstrap a clean Codex home, add complete English and Simplified Chinese CLI output with stable machine errors and start stages, cover the production core path with a serial integration gate, separate short Supervisor discovery probes from normal operation timeouts, join proxy target URLs structurally so trailing-slash base URLs forward correctly, keep CLI human-output tests independent of the host locale, and reconcile capture database changes from a synchronous content fingerprint.
- 33141f0: Add the supervisor, named-provider lifecycle, secure English/Simplified Chinese local UI, strict `init`-to-`ui` compatibility boundary, required native credential storage, and migration from pre-supervisor flat configuration.

## 0.2.2

### Patch Changes

- a026305: Avoid loading SQLite capture support when CLI commands only need default capture settings, so interactive `crp init` and `crp start` prompts stay visible instead of being interrupted by experimental SQLite warnings.

## 0.2.1

### Patch Changes

- c07ec46: Fix Windows startup detection so `crp start --debug` keeps the proxy process running.

## 0.2.0

### Minor Changes

- Add optional SQLite request capture with hot toggle support.

## 0.1.3

### Patch Changes

- 6d6c1eb: Add automated npm publishing with Changesets and GitHub Actions.
