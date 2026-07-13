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
| 2026-07-13 | Ship complete `en` and `zh-CN` dictionaries in the static app | The ordinary-user UI must support English and Simplified Chinese without widening the asset allowlist | Only explicit `crp.locale` selection persists; all other browser state is memory-only |
| 2026-07-13 | Make valid-cookie reload without a launch fragment GET-only | A reload must not retain the control token or silently regain mutation authority | Users can inspect state but must reopen with `crp ui` before changing it |
| 2026-07-14 | Require exact package and real native-backend release gates | Broad tarball checks and fallback-capable smoke tests can provide false assurance | The package has a reviewed 30-file allowlist, and each platform must prove its intended credential service before release |
| 2026-07-14 | Require native credentials at the public Supervisor boundary | Per-provider fallback consent could not safely select the startup backend | UI, CLI, and Admin expose no file-backend control; lower-level file storage is trusted-injection only pending future L3 startup consent |
| 2026-07-14 | Make `init` a strict alias of `ui` | Legacy secret setup persisted credentials in flat configuration | `init` accepts only `--no-open`/`--json` and rejects legacy options or positional input before discovery and writes |
| 2026-07-14 | Keep diagnostic export as a metadata-only compatibility path | The route name predates the implemented behavior | `/diagnostics/export` returns in-memory `{ created, generatedAt, eventCount }` and creates no bundle or file |
