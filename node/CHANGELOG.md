# @cluic/codex-remote-proxy

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
