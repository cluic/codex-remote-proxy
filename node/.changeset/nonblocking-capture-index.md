---
"@cluic/codex-remote-proxy": patch
---

Fix gateway startup and update rollback timeouts on existing Capture databases by preparing the forwarding index in an isolated background worker, safely settling cancellation/shutdown, disclosing temporary recording preparation, and clearing stale Worker errors after a verified successful retry.
