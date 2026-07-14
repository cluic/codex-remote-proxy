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
| 2026-07-14 | Pause Web refinement and make core CLI proof the active slice | Core behavior must be proven before additional management-page polish | Freeze Web source/E2E; implement and verify clean-home CLI, production-component composition, and real live smoke first |
| 2026-07-14 | Extend the existing shared core without a setup aggregation endpoint | CLI and Web already share versioned Admin operations and future Web work must not require a core rewrite | Preserve Admin `/api/v1`, registry schema 2, Supervisor/worker boundaries, fixed `OpenAI`, and `127.0.0.1:15100` |
| 2026-07-14 | Create a missing Codex config during explicit bootstrap/start | A clean home currently fails before CRP can configure Codex | Privately create the parent and atomic `0600` file, create no backup for a missing source, and preserve existing-file backup/mode/idempotency behavior |
| 2026-07-14 | Localize human CLI output but keep machine contracts language-independent | CLI needs English and Simplified Chinese without destabilizing automation | Resolve `--locale` and locale environment variables; keep JSON keys, codes, enums, messages, and actions stable |
| 2026-07-14 | Require deterministic composition and a separate real live smoke | Module tests or loopback/injected integration cannot prove native keyring and external-provider behavior | Local core completion requires both gates plus redacted cleanup evidence; both now pass |
| 2026-07-14 | Retain `provider add --api-key <KEY>` for now | The user deferred credential-input redesign | Record argv/history exposure as a known risk and revisit it later; it does not block local core completion |
| 2026-07-14 | Keep D1 and D2 evidence claims separate | A production-component loopback chain and detached lifecycle alone do not prove native credential retrieval or external forwarding | D1 remains deterministic evidence; the final production native-keyring and real-upstream D2 run completes the local core gate |
| 2026-07-14 | Separate discovery and operation timeouts | Reusing the 2-second discovery probe caused a successful real provider test to surface as `SUPERVISOR_UNAVAILABLE` | Probe `/status` for 2 seconds, then return a client with a 30-second normal-operation timeout |
| 2026-07-14 | Join proxy targets through parsed URL components | String concatenation turned a root base ending in `/` plus `/responses` into `//responses` | Preserve base paths, encoded request paths, and combined queries while emitting one path separator |
| 2026-07-14 | Distinguish local core completion from release completion | macOS D2 can pass while other platform and L3 evidence is still absent | Mark the local core gate complete without weakening cross-platform native, filesystem/ACL, visual, migration, or expert release gates |
