---
"@cluic/codex-remote-proxy": patch
---

Avoid loading SQLite capture support when CLI commands only need default capture settings, so interactive `crp init` and `crp start` prompts stay visible instead of being interrupted by experimental SQLite warnings.
