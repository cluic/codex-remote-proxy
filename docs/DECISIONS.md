# Decisions

| Date | Decision | Context | Consequences |
| --- | --- | --- | --- |
| 2026-07-10 | Use `iterate` harness mode | Existing v0.2.2 project is being expanded | Preserve current behavior while adding living contracts |
| 2026-07-10 | Target ordinary users first | CLI-only setup is a product barrier | Add guided local Web UI while retaining CLI |
| 2026-07-10 | Use Supervisor + Proxy Worker | Reliable restart and stable management access are required | Adds IPC/state coordination but isolates lifecycle |
| 2026-07-10 | Keep Codex provider as `OpenAI` | Thread metadata and listing are provider-bound | Existing history remains visible during upstream switches |
| 2026-07-10 | Keep a fixed loopback proxy address | Rewriting Codex config on every switch is disruptive | Provider activation happens inside CRP |
| 2026-07-10 | Prefer native credential stores | Product will handle multiple long-lived API keys | Platform adapters and L3 review are required |
| 2026-07-10 | Use guided utility console UI | New users need onboarding; experienced users need fast switching | First-run wizard transitions to low-density dashboard |
| 2026-07-10 | Keep Admin API loopback-only | Management actions expose credentials and process control | Reject remote binds and enforce browser-origin protections |
| 2026-07-10 | Defer remote access and failover | They expand security and operational scope | MVP stays local and single-active-provider |
