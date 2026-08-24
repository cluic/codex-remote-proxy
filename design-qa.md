# CRP Overview Redesign QA

Date: 2026-08-21

## Comparison Contract

- Source visual truth: `output/overview-redesign/source-option-1-1440x900.png`
- Browser-rendered implementation: `output/overview-redesign/implementation-1440x900.png`
- Combined comparison: `output/overview-redesign/comparison-2880x900.png`
- Viewport and pixels: source and implementation are both 1440 x 900 pixels at a 1440 x 900 CSS viewport with device scale factor 1; no density normalization was required.
- State: English, writable management session, Supervisor connected, Worker running, tested `Fallback API` Provider, Codex configured, ChatGPT Plus authenticated, `account_first` enabled, one returned seven-day quota window, populated 24-hour Metrics.

## Full-view Comparison Evidence

The final implementation preserves the selected direction's fixed sidebar and top bar, restrained green/gray console palette, single account/routing/quota command strip, four compact KPI cards, wide request-result chart, narrower Token trend, and bottom model/Provider summaries. The final document is exactly one 1440 x 900 viewport (`scrollWidth = 1440`, `scrollHeight = 900`), so all selected operational content remains visible without scrolling.

Intentional product-correct deviations from the Stitch source are accepted:

- The source showed fixed five-hour and seven-day quota blocks. The implementation renders the actual account-monitor array and, for the verified state, shows only the returned weekly window.
- The source's generic custom-API switch is replaced by the real `Use ChatGPT quota first` control and names the active fallback Provider.
- The existing CRP shell, brand abbreviation, language selector, Provider selector, and Worker controls are preserved rather than replacing stable application-wide navigation.
- The compact Metrics heading and 24-hour/7-day selector remain visible because they control real data and explain the active aggregation window.

## Focused-region Evidence

No additional crop was required: the equal-density 2880 x 900 side-by-side comparison keeps the command strip, KPI typography, chart legends, chart marks, and bottom summaries readable in one input. The top command strip was also inspected directly in the live browser after the final build to confirm one quota window, a checked account-first switch, full `ChatGPT signed in` copy, and no clipping.

## Required Fidelity Surfaces

- Fonts and typography: the implementation retains the product's existing Avenir/Segoe/PingFang stack and weight hierarchy. Page title, command labels, KPI values, panel titles, technical model names, and microcopy remain legible without wrapping or truncation at 1440 px. This intentionally preserves product typography instead of importing the mock's font stack.
- Spacing and layout rhythm: 256 px sidebar, 64 px top bar, 28 px content gutters, 8 px panels, subtle borders, and compact 12-20 px internal gaps match the selected operational density. Final desktop height is exactly 900 px with no hidden persistent controls.
- Colors and visual tokens: the existing `#17372c` primary, neutral canvas/surface tokens, green success, amber rejection, red error, blue input, and magenta output map closely to the source and retain semantic contrast.
- Image quality and asset fidelity: the source contains no raster product imagery. Existing Lucide icons are retained as the project's standard icon library; no placeholder imagery, custom SVG, emoji, or simulated asset was introduced.
- Copy and content: labels use the live bilingual dictionary and real contracts. Account plan, fallback Provider, quota remaining/reset, KPI values, model names, and Provider performance are data-driven rather than baked into the layout.

## Interaction and Responsive Verification

- Account-first routing was toggled off and back on; the checked state and local settings mutation settled correctly.
- The Metrics window was switched to seven days and back to 24 hours; `aria-pressed` followed the selected window.
- Manual account quota refresh completed through the existing mutation path.
- Browser console errors checked after the final interaction pass: 0.
- At 390 x 844 (`output/overview-redesign/implementation-390x844.png`), the command strip stacks, KPI cards use two columns, navigation moves off-canvas, and the document has no horizontal overflow (`scrollWidth = 375` within the scrollbar-adjusted viewport).
- Full Chromium E2E matrix: 47/47 passed, including English/Chinese and 1440/1024/390 layout checks.

## Comparison History

1. Initial implementation: the account segment duplicated `ChatGPT signed in` with a `Connected` badge and clipped the account copy. Classified P2. Fix: removed the redundant badge and gave the account identity the full segment width.
2. Second implementation: chart height was too conservative relative to the selected mock. Classified P2 composition drift. Fix: increased the request and Token plotting surfaces while keeping legends and summaries in the first viewport.
3. Third implementation: the desktop document measured 922 px high, leaving a 22 px vertical scroll despite all content being visible. Classified P2 viewport mismatch. Fix: applied route-specific Overview content padding; final dimensions are exactly 1440 x 900.
4. Final implementation: no actionable P0, P1, or P2 visual findings remain. The deviations listed above are deliberate product-contract corrections, not unresolved fidelity defects.

## System Page Redesign QA

- Baseline composition: `output/web-v8/reference/v0-system-1272x716.png`
- Browser-rendered implementation at the same viewport: `output/system-redesign/implementation-1272x716.png`
- Side-by-side comparison: `output/system-redesign/comparison-2544x716.png`
- Full desktop implementation: `output/system-redesign/implementation-1440x900.png`
- Mobile implementation: `output/system-redesign/implementation-390x844.png`

The baseline devoted the dominant first viewport to a large one-purpose readiness banner, four oversized status cards, and duplicate proxy controls. The redesign keeps the same shell and visual tokens but compresses management, Worker, preferred Provider, and Codex health into one four-fact strip. The main workspace then gives the largest area to actionable startup and routing settings, while runtime endpoints and diagnostics use the narrower column. ChatGPT quota charts remain on Overview; System carries only the account identity, last-check time, refresh action, and routing preference.

At 1440 x 900, the initial System document is exactly one viewport (`scrollWidth = 1440`, `scrollHeight = 900`). At 390 x 844, health facts form a two-by-two grid, settings remain touch-sized, the document has no horizontal overflow (`scrollWidth = 375` in the scrollbar-adjusted viewport), and lower operational sections remain available by vertical scroll. Start-at-login, account-first off/on, account refresh, Codex preparation, and diagnostic generation use real fixture-backed controls; the final interaction pass produced no visible error alert.

The start-at-login setting exposes its platform/user-level boundary directly, and the Provider terminology now distinguishes a preferred equal-weight tie-breaker from weighted routing order. No custom icon assets, placeholder graphics, fixed quota windows, or secret-bearing data were introduced.

## Follow-up Polish

- P3: Real-world accounts with several simultaneous quota windows may benefit from a later density pass after representative production snapshots are available; the current auto-fit layout already remains functional.

## Model Mappings Page QA

- Browser-rendered implementation: `output/playwright/task11/model-mappings-creates-ass-8fe67-n-exact-model-mapping-group-chromium/model-mappings-1440x900.png`
- Verified state: English writable session, running Worker, one `OpenRouter` exact-match group assigned to `Provider Beta`, one hot-applied `gpt-5` → `openai/gpt-5.1` rule, and deletion disabled while assigned.
- The page keeps rule-group navigation narrow and gives the editable mapping table the primary workspace. Assignment count, named Provider tag, unmatched passthrough behavior, and exact-match semantics remain visible without opening a dialog.
- The management flow creates a group, assigns it through Provider settings, edits its target, and prevents deletion while referenced. The final screenshot has no overlay, clipping, overlap, or horizontal overflow at 1440 × 900.
- Full Chromium E2E matrix: 54/54 passed across English/Chinese and 1440/1024/390 layout checks.

## Routing Rules and Provider Models QA

- Verified on 2026-08-24.
- Routing Rules implementation: `output/playwright/task11/routing-rules-manages-prov-b6b37-dels-into-two-routing-rules-chromium/routing-rules-1440x900.png`
- Provider model management: `output/playwright/task11/routing-rules-manages-prov-b6b37-dels-into-two-routing-rules-chromium/provider-models-1440x900.png`
- Verified state: English writable session, running Worker, `Provider Beta` using a configurable `/models` catalog path, five discovered models plus one manual model, one explicitly disabled model, and one active group with two rules covering five models. The first rule sends `M1`, `M3`, and `M5` through Provider Alpha first; the second sends `M2` and `M4` through Provider Beta first.
- One routing rule now accepts multiple model chips, so the group expresses model sets rather than repeating an identical Provider chain for every model. The group list, active marker, rule count, assigned-model count, fallback explanation, Provider ranks, and hot-apply notice remain readable in the first 1440 × 900 viewport.
- The Provider model dialog keeps the catalog path, newly discovered-model default, refresh action, manual add/delete action, search, source badges, per-model enable state, and summary counts in one scrollable modal. Discovered models can be enabled or disabled; user-added models can also be deleted. The footer remains fixed without obscuring the scrollable list.
- The browser flow changes and saves the catalog path, refreshes discovery, disables a discovered model, adds and removes manual models, creates and activates the two-rule/five-model group, edits it while live, confirms a newer generation, scans for protected values, and verifies no page-level overflow. The shared bilingual matrix also opens Routing Rules at 1440, 1024, and 390 widths.
- Follow-up visual review aligns the Add model action exactly with its 42 px input control; the help copy occupies a separate grid row and moves before the full-width action on mobile.
- Full Chromium E2E matrix: 55/55 passed. Visual review found no actionable P0, P1, or P2 issue.

## Product Hardening QA

- Browser-rendered Overview: `output/playwright/task11/provider-switch-renders-po-5f507-e-window-without-stale-data-chromium/overview-hardening-1440x900.png`
- Verified state: 1440 × 900 English writable session with populated 24-hour Metrics, ChatGPT account routing controls, both request and Token trend modes, exact model usage, and bounded Provider performance.
- The former static chart pair is replaced by one full-width explorer. Requests can switch between count and share; Tokens can switch among total, input, and output. Hover and keyboard focus expose an exact time bucket, and unobserved Token buckets render as gaps rather than fabricated zeroes.
- Model usage always identifies unknown and grouped remainder traffic, with an explicit expand control for exact names. Provider performance shows all bounded rows, successful requests, Token usage coverage, and P95 response-start latency; the mobile layout changes to readable cards instead of a compressed table.
- Service reliability excludes client disconnects from the denominator and discloses that exclusion. Forwarding Records distinguish observed usage, upstream-unreported usage, unrecognized protocols, non-applicable requests, and legacy rows.
- OpenRouter was visually verified as a maintained built-in Provider that fills the `/api/v1` endpoint while preserving passthrough for custom Providers.
- Full Chromium E2E matrix: 53/53 passed, including English/Chinese and 1440/1024/390 layout checks. UI typecheck, source lint, generated-build verification, and production UI build passed.
- Deterministic backend groups passed before the fixed-port real-chain gate: unit-core 557/557, Capture 10/10, and integration 57/57. The L3 lifecycle review additionally verified identity-bound update shutdown, automatic previous-version recovery, post-shutdown cleanup failure recovery, fail-closed state/PID/port checks, locale/version aliases, effective Capture status, and semantic `response.done` failures. The local real-chain invocation could not claim `127.0.0.1:15100` because the user's installed CRP instance was intentionally left running; CI runs this isolated fixed-port gate on a free runner.

No actionable P0, P1, or P2 visual findings remain in the final 1440 × 900 evidence.

final result: passed
