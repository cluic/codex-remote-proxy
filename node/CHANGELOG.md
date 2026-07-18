# @cluic/codex-remote-proxy

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
