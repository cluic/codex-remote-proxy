---
"@cluic/codex-remote-proxy": patch
---

Route eligible GET `/models` and `/v1/models` requests through the ChatGPT account first, preserving query strings, bypassing Provider model rewrites, and falling back to custom Providers after an account 429 while honoring the latest quota reset.
