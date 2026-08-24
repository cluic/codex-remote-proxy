# @cluic/codex-remote-proxy

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
