# CRP Web Product Reference And V8 Contract

> The historical v0.app input and the production V8 override for the Codex Remote Proxy local management Web application.
>
> This document intentionally ignores the existing Web implementation and leaves visual design to v0.app.
>
> The v0 prototype produced from this brief is now a visual reference only. M2E/V8 authorizes a clean frontend replacement and the additive anonymous Metrics contract recorded in `docs/ROADMAP.md`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/PERMISSIONS.md`, and `docs/UIUX.md`; those living contracts supersede conflicting statements below.

## M2E/V8 Scope Override

- Production is implemented as a responsive Vite + React + TypeScript build-time SPA under `node/ui-src/`, not this prototype's Next.js runtime or mock state.
- The Admin server and npm package still expose exactly `ui/index.html`, `ui/app.js`, and `ui/styles.css`; development source, build tools, source maps, dynamic chunks, remote assets, telemetry, and a frontend runtime server are not shipped.
- Overview includes anonymous local aggregate request, result, Token-coverage, model, Provider, and latency charts from `GET /api/v1/metrics/overview`.
- Metrics remains active independently of Capture and never contains per-request identifiers, URLs, headers, bodies, session/thread IDs, credentials, raw errors, or exact timings.
- Overview implements request-result and observed-Token trends, model distribution, and a Provider performance table. It does not claim a separate latency trend chart or cost analytics.
- Provider cards expose direct authoritative Switch or Test and switch actions. Explicit activation applies to a running Worker or starts a stopped Worker, and stopped-state labels say `and start`.
- Conditional Setup runs `save Provider -> compatibility test with activateIfNone/CAS selection -> Codex bootstrap/history repair -> Worker start`. The CAS selection never starts or reconfigures the Worker, and Setup does not call explicit activation.
- Permanent navigation includes a disabled `Forwarding Records / 转发记录` item marked `Coming soon / 即将上线`; the MVP has no forwarding-record route, data, API, Capture control, payload view, export, or purge behavior.
- Activity is sanitized control-plane history. System exposes immutable runtime facts plus Prepare Codex and in-memory diagnostic metadata; Capture state and controls are not part of the V8 Web surface.
- Credentials are blank write-only inputs and are cleared from React state and the current DOM value before validation, request dispatch, or re-rendering.
- The complete `en`/`zh-CN` application is responsive through the required 390x844 narrow viewport and preserves keyboard, focus, reduced-motion, read-only, and terminal-session contracts.
- The fixed addresses are `http://127.0.0.1:15100` for the proxy and `http://127.0.0.1:15101` for local management.
- Local acceptance passes Chromium 33/33, the English/Chinese 1440/1024/390 responsive matrix, and the matched same-state visual comparison recorded in `design-qa.md`.

## Historical v0 Prototype Input

Sections 1 through 18 below are preserved as the source brief that produced the visual reference. They are not the current production contract where they conflict with the M2E/V8 override or the living API/data/UI documents. In particular, the historical separate stopped-Worker activation step and the historical claim that frontend implementation had not begun are superseded.

## 1. What v0.app Should Build

Create one routed, interactive frontend prototype for the CRP local management application.

- Use synthetic in-memory data only.
- Simulate all operations as state transitions.
- Do not call localhost or any external API.
- Do not create a backend, database, real authentication, or real credential storage.
- Do not persist anything except a simulated language preference.
- Include a review-only scenario switcher or query parameter so every required state can be opened directly. This control must not appear as a real product feature.
- Build the product itself, not a landing page or marketing site.

Recommended build sequence:

1. Application shell, routes, language switcher, and review-state switcher.
2. Setup, Overview, and Providers.
3. Activity and System.
4. Read-only, failure, degraded, confirmation, accessibility, and bilingual states.

v0.app may freely choose layout, visual style, colors, typography, icons, components, spacing, and motion. Functional rules in this document must remain intact.

## 2. Product Definition

Codex Remote Proxy, or CRP, is a local, single-user control and proxy application for Codex.

It keeps Codex signed in through ChatGPT while forwarding model requests to one selected OpenAI-compatible provider. Provider switching happens inside CRP, so Codex keeps the same provider identity and existing OpenAI-tagged conversation history remains discoverable.

### Primary User

An ordinary Codex Desktop user who has a compatible Base URL and API key but does not want to edit configuration files or manage local processes from a terminal.

### Core Goals

- Configure a working provider in under five minutes.
- Test and switch between named providers without changing Codex history ownership.
- Make local management service, proxy service, active provider, and Codex readiness independently understandable.
- Support safe proxy start, stop, and restart.
- Give every failure a plain cause and one recommended next action.
- Keep complete credentials out of reads, browser storage, activity, diagnostics, errors, and screenshots.
- Provide complete English and Simplified Chinese experiences.

### Product Invariants

- Codex provider identity is always OpenAI.
- Codex proxy address is always http://127.0.0.1:15100.
- The local Admin address is http://127.0.0.1:15101.
- CRP has zero or one active provider.
- Provider switching affects new requests only.
- In-flight requests keep the provider snapshot captured when they started.
- The management service stays available while the proxy service restarts.
- Complete credentials are always write-only.

### Explicit Non-Goals

Do not design:

- Login, registration, accounts, roles, teams, or organization controls.
- LAN or internet administration, cloud sync, or team sharing.
- Load balancing, provider weights, or automatic failover.
- Cost or billing analytics, inferred Token estimates, and per-request traffic analytics.
- Request/response body inspection or raw-log viewing.
- Viewing, revealing, copying, or recovering a saved API key.
- Editable ports, Capture controls, or credential-backend selection.
- Supervisor shutdown from the Web.
- Launch-at-login, system tray, or desktop-shell controls.
- Automatic migration repair, rollback, or lock cleanup.
- A downloadable diagnostic bundle.

## 3. Information Architecture

The daily workspace has five visible destinations, one of which is deliberately unavailable:

1. Overview
2. Providers
3. Forwarding Records (disabled, coming soon)
4. Activity
5. System

Setup is conditional and is not a permanent main-navigation destination. Provider creation and details are subordinate to Providers. Compact route selection and proxy controls stay in the sidebar runtime block on every main page; Overview keeps readiness and metrics without a duplicate control section. Diagnostic summary stays on System.

| Route or state | Responsibility |
| --- | --- |
| Session initialization | Simulate the one-time local launch exchange |
| /setup | Resume-safe initial configuration |
| /overview | Readiness, active provider facts, anonymous Metrics, and next action |
| /providers | Provider inventory and legal actions |
| /providers/new | Securely create a provider |
| /providers/:id | Configure, discover models, test, activate, and delete |
| /activity | Sanitized lifecycle history |
| /system | Read-only local configuration plus two explicit system actions |
| Read-only re-entry | GET-only workspace with explicit same-origin management recovery while the cookie session remains valid |
| Terminal session failure | Stop product use and instruct reopening through crp ui |

### Global Product Controls

Make these globally available:

- Product identity.
- Access mode: Manage or Read only.
- Proxy summary: running, stopped, restarting, or failed.
- Active provider name or No active provider.
- Provider route selection and icon-only start/stop/restart controls.
- Language: English / 简体中文.

Do not add avatars, account menus, notification centers, organization switchers, or cloud indicators.

## 4. Access And Global States

CRP has no login page. Browser authority comes from launching crp ui.

| State | Product behavior |
| --- | --- |
| Initializing | Show session-exchange loading, success, invalid launch, and failure |
| Writable | Reads and legal mutations are available |
| Read-only re-entry | Navigation and reads work; every mutation is disabled before interaction; instruct running crp ui again |
| Terminal auth failure | Stop all product/API simulation for the tab; keep language selection; instruct close and reopen through crp ui |
| Management service disconnected | Mark current facts unverified, stop mutations, and instruct reopening after restoration |

The real application keeps control and CSRF tokens in memory and removes the launch fragment after exchange. The prototype only needs to represent the visible states, not implement that security mechanism.

### Refresh Rules

- Load current facts when entering a page.
- Re-read authoritative facts after every simulated mutation.
- Disable conflicting actions while an operation is pending.
- Do not rely only on optimistic state.
- Do not invent real-time streaming; the current product has no SSE or WebSocket contract.

## 5. First-Time Setup

Setup is derived from saved facts and is resumable. Do not store setup progress or drafts.

If one or more saved providers already exist, let the user choose one and resume from its current test state. Do not claim that a provider came from migration because the public data has no migration-origin field.

### Step 1: Save Provider

Collect:

- Name.
- Base URL.
- API key as a write-only secret.
- Optional advanced authentication header, authentication scheme, and extra headers.
- Model mode: passthrough or override.
- Override model when override mode is selected.

The provider is saved before testing. If a later step fails, the saved provider remains available.

### Step 2: Choose Test Model And Test

The compatibility test requires a non-empty model.

Offer:

- Select from the cached model catalog.
- Explicitly refresh the catalog.
- Enter a model manually when discovery is unavailable.

Keep these operations distinct:

- Model refresh does not test compatibility.
- Compatibility test does not refresh the model catalog.
- Neither operation activates the provider or starts the proxy.
- Refresh failure preserves the last good catalog.
- A compatibility failure is a completed product result, not necessarily a broken HTTP request.

### Step 3: Activate (Historical Prototype Behavior)

Activation requires:

- Compatibility state Passed.
- Credential configured.

Historical prototype behavior depended on Worker state:

- Worker stopped: save the active provider selection; keep Worker stopped.
- Worker running: wait for the activation response, then re-read status. On success, new requests use the selected provider.

Do not promise activation health sub-steps that the public response contract does not expose. Do not start the Worker implicitly.

### Step 4: Prepare Codex

Every Prepare Codex action requires confirmation because no preview endpoint can determine changes in advance.

Explain the fixed result:

- Codex provider identity remains OpenAI.
- Codex proxy address becomes http://127.0.0.1:15100.
- A missing private configuration may be created without a backup.
- An existing configuration is backed up only if content changes.
- Unrelated Codex settings remain intact.

After execution, display the returned result:

- changed = false: no change required.
- changed = true and backupCreated = false: a missing configuration was created; no backup was needed because no prior file existed.
- changed = true and backupCreated = true: existing configuration changed and a backup was created.

The operation result is memory-only. After reload, show only current Codex status returned by the status API.

### Step 5: Start Proxy

- Requires an active provider with Passed test state and a configured credential.
- Wait for the Worker to be listening and healthy.
- If Codex configuration changed, instruct the user to restart Codex once.
- Finish on Overview with refreshed facts.

## 6. Overview

Overview answers:

1. Is CRP ready?
2. Which provider will new requests use?
3. What is the single best next action?

### Required Status Groups

| Group | Required facts |
| --- | --- |
| Local management service | Running state, PID, started time |
| Proxy service | Phase, PID, generation, configured, listening, in-flight, restart count, safe error |
| Active provider | Name, safe Base URL, test status, credential configured, model mode, last test |
| Codex integration | OpenAI identity, fixed proxy URL, current bootstrap status |
| Recent context | Latest actionable error and a short sanitized activity list |

Keep management service and proxy service visibly separate. A running management service does not mean the proxy is listening.

### Recommended Action Priority

Evaluate in this order:

1. A lifecycle mutation is starting, restarting, draining, or otherwise pending: Show the current operation, disable conflicting actions, and wait for refreshed terminal state.
2. No providers: Add provider.
3. No active provider:
   - If an inactive provider is Passed and credentialConfigured, Activate it.
   - Otherwise, if a saved provider has a configured credential, Test it.
   - Otherwise, Replace credential on a selected inactive provider.
4. Active provider credential is unavailable:
   - If another provider is Passed with a configured credential, Activate that provider.
   - Otherwise, if an inactive provider has a configured credential, Test that provider.
   - Otherwise, if an inactive provider exists, Replace its credential.
   - Otherwise, Add provider.
5. Active provider is Untested or Failed and its credential is configured: Retest the active provider. Switching to another eligible provider is a secondary action.
6. Codex is not prepared: Prepare Codex.
7. Worker stopped: Start proxy.
8. Worker failed: Restart only if the active provider is still Passed with a configured credential; otherwise fix provider eligibility first.
9. Worker running and facts healthy: Ready.

An unrelated inactive provider that is Failed or Untested must not override a healthy Ready state.

### Active Provider Retest Failure

Active, test status, and Worker phase are separate axes.

If an active provider is retested and fails:

- It remains active.
- A running Worker keeps its existing runtime snapshot and is not stopped automatically.
- New Start or Restart operations are unavailable until the active provider passes again or another eligible provider is activated.
- Overview shows Active + Failed together and recommends retest or switch.

If an active provider's credential becomes unavailable, it also remains active. A running Worker may keep its existing in-memory snapshot, but Start and Restart remain unavailable until another eligible provider is activated.

### Lifecycle Actions

- Start: requires eligible active provider; completes only when Worker is listening and healthy.
- Stop: stops only Worker; management and Web remain available.
- Restart: drains, replaces, and health-checks Worker.
- Switch: affects new requests only; in-flight requests keep the previous provider.

If the latest authoritative status reports inFlight greater than zero, confirm before Restart. This is a best-effort warning because in-flight state can change before the request; the server still owns draining.

## 7. Providers

### List

Show:

- Active marker.
- Name.
- Base URL without query or fragment.
- Test state: Untested, Passed, or Failed.
- Last test time.
- Model mode and override value.
- Credential configured state.
- Legal actions and disabled reasons.

Provider ID belongs in technical details, not as the primary human label.

Required list states:

- Empty.
- Providers exist but none active.
- Active provider with Worker stopped.
- Active provider with Worker running.
- Active provider with failed latest retest.
- Read-only access.
- Loading and request failure.

### Action Eligibility

| Action | Rule |
| --- | --- |
| View | Available with read access |
| Test | Credential must be configured |
| Refresh models | Credential must be configured |
| Activate | Inactive, Passed, and credential configured |
| Edit | Inactive only |
| Replace credential | Inactive only |
| Delete | Inactive only |

For an active provider, explain: activate another eligible provider first.

### Create And Edit Fields

- Name: required and unique case-insensitively.
- Base URL: HTTPS for public upstreams; HTTP only for loopback.
- API key: write-only.
- Authentication header: default authorization.
- Authentication scheme: default Bearer; empty means raw key.
- Extra headers: cannot use sensitive names or collide with authentication.
- Model mode: passthrough or override.
- Model override: required in override mode.

Visible secret behavior:

- Never prefill or reveal a saved key.
- Do not display a masked value as form data.
- Show only Configured or Not configured.
- Do not persist drafts.
- Never place the value in errors, technical details, Activity, or screenshots.

Changing Base URL, authentication, extra headers, model policy, or credential resets test status to Untested. Changing only the name preserves test state.

Credential replacement also removes the provider's model-cache entry. Re-read the provider and catalog, then show catalog state Missing.

### Provider Detail

Include:

- Summary and active state.
- Configuration.
- Model catalog.
- Compatibility test.
- Activation.
- Delete for inactive providers.
- Technical details with immutable ID and safe error metadata.

### Model Catalog

| State | Meaning | Required behavior |
| --- | --- | --- |
| Missing | No usable current catalog | Offer refresh and manual model entry |
| Fresh | Fetched within 24 hours | Show models and timestamps |
| Stale | Older than 24 hours but within 30 days | Keep models, mark stale, offer refresh |
| Refresh failed with prior data | Last refresh failed | Preserve and identify the last good catalog |
| Committed degraded | New catalog is committed but cleanup/activity failed | Re-read facts; do not treat as a network failure or immediately retry |

The API does not reveal why a catalog is Missing. Do not invent a specific reason.

Delete requires explicit confirmation naming the provider and explains that its credential and cached catalog are removed.

## 8. Activity

Activity is sanitized lifecycle history, not traffic analytics.

Show newest first:

- Timestamp.
- Category.
- Action.
- Provider name when resolvable, otherwise safe Provider ID.
- Result.
- Stable error code.
- Expandable allowlisted details.

Support offset pagination and a clear empty state.

Never show credentials, credential references, authorization values, headers, bodies, raw errors, stacks, internal paths, backup paths, or Capture contents.

Do not add search, filters, date ranges, charts, or analytics because the current API does not provide them.

## 9. System

System values are read-only. A writable session may still perform two explicit system actions: Prepare Codex and Generate diagnostic summary.

### Read-Only Information

- Codex identity OpenAI.
- Proxy address http://127.0.0.1:15100.
- Admin address http://127.0.0.1:15101.
- Current Codex bootstrap status.
- Management and Worker summaries.
- Native credential-storage requirement.
- Capture configured, active, restart-required, and safe error state when returned.

Do not add port editors, Capture toggles, credential-backend selectors, path editors, database browsers, or Supervisor shutdown.

### Prepare Codex

Use the confirmation and result rules from Setup. Do not imply that a previous result survives reload unless the status API explicitly returns it.

### Diagnostic Summary

Label the action Generate diagnostic summary, not Export or Download.

The result contains only:

- created.
- generatedAt.
- eventCount.

Current behavior returns eventCount = 0. Do not present it as the Activity total. Generating the summary and preparing Codex do not create Activity events.

Allow viewing or copying this small in-memory result. Do not show a file, archive, path, download button, logs, or request data.

## 10. Errors, Pending, And Degraded Results

Every mutation needs Pending, Success, Failed, and Degraded presentation.

Safe errors provide:

- code.
- message.
- action.
- requestId.
- Small allowlisted details.

Presentation order:

1. Plain-language result.
2. Recommended next action.
3. Whether primary data was committed.
4. Technical code and request ID.

Committed/degraded means primary data is already saved but cleanup or Activity recording failed.

- Do not say nothing was saved.
- Re-read facts before offering another mutation.
- Do not make immediate retry the primary action.
- Keep the warning visible beyond a short toast.

Do not expose raw responses, causes, stacks, local paths, or arbitrary details.

## 11. Confirmations

Always confirm:

- Delete provider.
- Replace credential.
- Prepare Codex.

Confirm Restart when the latest status reports in-flight requests.

Explain before execution without an extra dialog:

- Activate affects new requests only.
- Stop leaves management available.
- Refresh models uses the saved credential but does not test or activate.
- Generate diagnostic summary creates in-memory metadata only.

## 12. Internationalization And Accessibility

All pages and states must switch between English and Simplified Chinese without repeating a mutation.

Only the language preference may persist.

| English | 简体中文 |
| --- | --- |
| Overview | 总览 |
| Providers | 提供商 |
| Activity | 活动 |
| System | 系统 |
| Local management service | 本地管理服务 |
| Proxy service | 代理服务 |
| Active provider | 当前提供商 |
| Compatibility test | 兼容性测试 |
| Prepare Codex | 配置 Codex |
| Read only | 只读 |
| Degraded | 降级 |

Use locale-aware dates and numbers. Keep IDs, URLs, ports, request IDs, and error codes literal.

Requirements:

- WCAG 2.2 AA contrast.
- Full keyboard access and semantic labels.
- Correct dialog focus entry and return.
- Async results announced to assistive technology.
- Status never uses color alone.
- Reduced-motion support.
- Long English and Chinese text wraps without clipping or overlap.

Primary viewports: 1440 x 900 and 1024 x 768. Also verify overflow safety at 390 x 844 without treating mobile as the primary product.

## 13. Synthetic Prototype Data

Use only synthetic examples.

| Field | Provider A | Provider B |
| --- | --- | --- |
| Name | Primary Gateway | Local Lab |
| Base URL | https://api.example.com/v1 | http://127.0.0.1:18080/v1 |
| Active | Yes | No |
| Test state | Passed | Failed |
| Credential | Configured | Configured |
| Model mode | Passthrough | Override |
| Model override | None | example-codex-model |
| Catalog | Fresh | Stale |

Runtime example:

- Management service Running, PID 48320.
- Proxy service Running, PID 48344, generation 12, two in-flight requests.
- Active provider Primary Gateway.
- Codex identity OpenAI.
- Proxy URL http://127.0.0.1:15100.

Never put a sample API-key value into a saved-key display.

## 14. Required Review Scenarios

Make these accessible through real routes plus the review-only scenario switcher:

1. Session initialization.
2. Empty first-time Setup.
3. Saved provider awaiting test.
4. Fresh model catalog.
5. Model refresh failure with manual fallback.
6. Compatibility test pending, failed, and passed.
7. Explicit activation with Worker stopped.
8. Prepare Codex confirmation and each result combination.
9. Setup complete with Worker running.
10. Healthy Overview.
11. Overview with Worker stopped.
12. Overview with Worker failed.
13. Active provider whose latest retest failed while Worker still runs.
14. Restart warning with in-flight requests.
15. Provider list with active and inactive providers.
16. Active provider read-only detail.
17. Inactive provider editing and credential replacement.
18. Missing, fresh, stale, failed-refresh, and committed-degraded model catalogs.
19. Provider deletion confirmation.
20. Activity list, event detail, and empty state.
21. System information, Prepare Codex, and diagnostic summary.
22. GET-only workspace.
23. Terminal session failure.
24. Committed/degraded mutation result.
25. Setup, Overview, one error, one confirmation, and read-only state in both languages.

## 15. Existing Product Action Map

The prototype must not call these routes, but every real product action must correspond to an existing capability.

| Product action | Existing API |
| --- | --- |
| Browser session | POST /api/v1/session |
| Status | GET /api/v1/status |
| List/create providers | GET/POST /api/v1/providers |
| Read/update/delete provider | GET/PATCH/DELETE /api/v1/providers/:id |
| Compatibility test | POST /api/v1/providers/:id/test |
| Read/refresh models | GET/POST /api/v1/providers/:id/models |
| Activate provider | POST /api/v1/providers/:id/activate |
| Worker lifecycle | POST /api/v1/proxy/start, /stop, /restart |
| Activity | GET /api/v1/activity |
| Read settings | GET /api/v1/settings |
| Prepare Codex | POST /api/v1/codex/bootstrap |
| Diagnostic metadata | POST /api/v1/diagnostics/export |

There is no Web capability for Supervisor shutdown, credential reads, raw logs, traffic analytics, Activity filtering, migration rollback, lock repair, or downloadable diagnostics.

## 16. Historical Optional M2D/V7 Content

Do not render this in the current prototype.

This section recorded a pre-implementation plan. M2D/V7 has since implemented additive Prepare Codex result fields for provider-transition history repair. Current V8 may show only:

- Bounded repaired-item counts.
- An encrypted-content warning.

It must never expose paths, thread IDs, messages, database rows, credentials, or complete API keys. Add this only after the response contract is implemented and supplied to the frontend.

## 17. Acceptance Checklist

- Opens directly into the management product.
- Uses in-memory synthetic state and no real API.
- Setup is resumable and shows only the actionable stage.
- Save, model refresh, test, activate, Prepare Codex, and Start remain separate.
- Overview gives one deterministic next action.
- Inactive provider failures do not hide a healthy Ready state.
- Active, test status, credential state, and Worker phase remain separate.
- Active-provider retest failure is represented correctly.
- Activation does not imply Worker start or undocumented health progress.
- Management and Worker states remain separate.
- Active provider edit, credential replacement, and delete are unavailable with reasons.
- Switching affects new requests only.
- Stop leaves management available.
- Read-only mode disables mutations before interaction.
- Session failure is terminal for the tab.
- Credentials never appear or persist.
- System values are read-only; only the two documented actions mutate.
- Diagnostic summary is not a download and eventCount is not Activity total.
- Activity is sanitized and paginated, not an analytics product.
- Degraded results are persistent and fact-reconciled.
- All required states are reachable for review.
- English and Simplified Chinese have equal functional coverage.
- Keyboard, focus, wrapping, and narrow-width safety are represented.
- No non-goal or nonexistent API capability appears.

## 18. Delivery Boundary

v0.app should deliver a visual direction and interactive prototype based on this brief.

Generated React, shadcn/ui, or framework code is design output only. It is not automatically compatible with CRP's static packaging, browser-session security, exact API schemas, secret-clearing implementation rules, bilingual dictionaries, or release gates.

Historical delivery ended at the visual reference. M2E/V8 later resumed Web work, implemented the reconciled production application under the override above, and completed the local browser/visual evidence recorded in `design-qa.md`.
