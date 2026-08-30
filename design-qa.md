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

## Client API Keys and Public Listening QA

- Verified on 2026-08-24.
- System implementation: `output/playwright/task11/access-keys-manages-write--5d572-cation-for-public-listening-chromium/system-access-keys-1440x900.png`
- Verified state: English writable session, stopped Worker, `0.0.0.0` selected, client authentication visibly required and locked, and one active key with a future expiration plus a five-request lifetime limit.
- The create flow generates a 256-bit browser-side value, keeps the complete value in the secret input only until submission, clears both React state and the live DOM before the request is released, and never renders or records that value in the fixture response/call log. The edit flow submits only changed metadata, then disable, enable, and irreversible delete all settle through the real UI mutation path.
- The API-key value input and Generate key action have identical vertical position and 42 px control height. The populated table keeps name/hint, status, usage, a realistic two-line expiration, last-used value, and all three row actions inside the card at the 1440 px viewport; no action is clipped by the scroll boundary.
- Switching to all-interface listening forces authentication on and disables the switch. Listen-address changes remain unavailable while the Worker is running. The shared responsive matrix also opens System in English and Chinese at 1440, 1024, and 390 widths without page-level horizontal overflow.
- Full Chromium E2E matrix: 56/56 passed. Visual review found no actionable P0, P1, or P2 issue.

## Overview Route Preview QA

- Verified on 2026-08-25.
- Custom-provider evidence: `output/playwright/task11/route-preview-traces-the-l-142cd-onditional-account-fallback-chromium/route-preview-custom-1440x900.png`
- Collapsed account-first fallback evidence: `output/playwright/task11/route-preview-traces-the-l-142cd-onditional-account-fallback-chromium/route-preview-account-fallback-1440x900.png`
- Expanded account-first fallback evidence: `output/playwright/task11/route-preview-traces-the-l-142cd-onditional-account-fallback-chromium/route-preview-account-fallback-expanded-1440x900.png`
- Mobile evidence: `output/playwright/task11/route-preview-traces-the-l-142cd-onditional-account-fallback-chromium/route-preview-account-fallback-390x844.png`
- Verified state: a running generation-8 Worker, `gpt-5.6-sol`, an exact routing group preferring Provider Beta, a Provider Beta mapping to `vendor/gpt-5.6-sol`, and Provider Alpha as the second candidate.
- The density revision replaces stacked explanatory cards with one always-visible primary rail and one default-collapsed conditional fallback. The collapsed fallback still names the matched rule, first Provider, and rewritten model; explicit expansion reveals the full amber fallback rail. Provider retry order remains compressed into a single strip beneath it.
- Runtime source, generation, and route type now share the title area. Retry assumptions and delivery semantics remain available in a collapsed Decision details disclosure instead of consuming the default viewport.
- The custom-only board renders at 1128 × 234 px. The account-first fallback summary is a single 32 px row; the collapsed board renders at 1128 × 275 px and expands to 1128 × 357 px only on demand. The 390 px collapsed board renders at 358 × 396 px, keeps each active rail horizontal, removes redundant request/account nodes from the long custom-only rail, and passes clipping, overlap, and document-overflow checks.
- Nodes now use lightweight capsule surfaces instead of nested rectangular cards. Connector highlights travel through consecutive segments with staggered timing; the expanded conditional path retains an amber dashed treatment. Reduced-motion preferences collapse both the entrance and flow animations through the existing global rule.
- The source badge distinguishes live Worker state from a stopped configuration snapshot. Copy consistently says “predicted outlet,” and detailed retry semantics remain accessible without competing with the effective route.
- The focused Chromium route-preview scenario passed in English at 1440 × 900 and 390 × 844. Visual review found no actionable P0, P1, or P2 issue.
- Full Chromium E2E matrix: 57/57 passed.

final result: passed

## Forwarding Model Attribution QA

- Verified on 2026-08-27.
- Browser evidence: `output/playwright/task11/forwarding-records-lists-f-74ba4-ata-only-forwarding-records-chromium/forwarding-models-1440x900.png`
- Verified state: four default-visible mixed account/custom rows plus two custom-provider model-catalog rows, one exact model rewrite from `gpt-5.6-sol` to `vendor/gpt-5.6-sol`, one unchanged account model, one unchanged custom model, and one legacy row without model metadata.
- The records table gives model attribution a dedicated, fixed-width column instead of squeezing it into the request path. Exact rewrites use a compact `requested → forwarded` treatment; unchanged models render once; legacy rows say `Not recorded`. The detail panel exposes separate requested and forwarded rows, and search matches either persisted model column.
- Capture schema 5 adds nullable requested/forwarded model columns through the existing additive migration. Values reuse the proxy's bounded protected-value screening, so model metadata can remain available even when Capture intentionally omits a large, compressed, truncated, or protected request body.
- The Admin response remains metadata-only and never projects request/response bodies or authentication headers. The desktop table intentionally keeps only six scan fields—time, request, model, Provider, result, and duration—and has no horizontal overflow while the detail panel is open. Token usage and transfer volume remain fully available in the selected record details; narrow mobile viewports retain a contained table scroller.
- The table uses a two-line date/time cell and a two-line rewrite cell so values never spill into adjacent columns. Both the automated 1280 px assertion and the live Chinese 1280 px check measured a 625 px table viewport with an equal 625 px scroll width; all six columns remained ordered and non-overlapping.
- Production-shaped incoming URLs use the full `http://127.0.0.1:15100` origin, but table cells render only `/path?query`; the detail pane retains the complete incoming and target URLs. `/models` and `/v1/models?refresh=1` rows are excluded by default, summary totals remain four, enabling the visibility control reveals all six rows and updates the summary to six, and disabling it restores the original keyset-safe view.
- Final verification: 601/601 unit tests, 62/62 integration tests, and 57/57 Chromium E2E scenarios passed; the live Chinese browser check showed the requested/forwarded model pair in both the table and detail panel with zero console errors.

## Daily Token Heatmap QA

- Verified on 2026-08-27.
- Browser evidence: `output/playwright/task11/provider-switch-renders-po-5f507-e-window-without-stale-data-chromium/overview-hardening-1440x900.png`
- Verified state: an English writable session with populated 24-hour Metrics and an independent 84-day UTC Token history containing zero-traffic, unobserved, partially observed, and fully observed days.
- The former hourly trend explorer is replaced by a GitHub-style 12-week calendar. Five green intensity levels communicate relative daily observed Token volume, while striped and dotted treatments keep missing and partial usage visibly distinct from a true zero.
- Desktop uses a compact calendar/detail split so the exact selected-day input, output, total, and request coverage remain in the first viewport without leaving an unused half-panel. At 390 px, only the calendar becomes an intentional contained horizontal scroller; the document itself remains within the viewport.
- All 84 days are keyboard-focusable buttons with exact accessible labels. Pointer hover, focus, and click share the same detail state, and a visually hidden data table preserves the complete daily series for non-visual access.
- Heatmap loading and failure state are independent from the 24-hour/7-day Metrics request in both directions: an hourly API failure does not hide successful daily history, and a heatmap failure does not remove current-window cards or summaries. Changing the current Metrics window does not refetch or reset the 12-week series, historical heatmap traffic remains visible when the selected hourly window is empty, and degraded daily persistence adds a non-blocking warning above the latest in-memory totals.
- Final verification: UI typecheck, source lint, generated-build verification, 605/605 unit tests, 63/63 integration tests, 59/59 Chromium E2E scenarios, and the production dependency audit passed. The fixed-port core-chain group was not run locally because the user's existing CRP service owns `127.0.0.1:15100` and `127.0.0.1:15101`; it was left untouched.

## Forwarding Ledger and Detailed Capture QA

- Verified on 2026-08-28; this section supersedes the earlier metadata-only Forwarding Model Attribution surface.
- Desktop evidence: `output/playwright/task11/forwarding-records-scans-f-b6c2f--toggles-forwarding-capture-chromium/forwarding-ledger-desktop.png`
- Chinese phone evidence: `output/playwright/task11/forwarding-records-keeps-t-200ce--usable-in-Chinese-at-390px-chromium/forwarding-ledger-phone-zh.png`
- The ledger presents exactly nine scan columns in order: time, request, route decision, result, model, session ID, Provider, three Token values, and duration. All four default-visible outcomes fit without desktop horizontal overflow; the 390 px table uses an intentional contained scroller while the page itself stays within the viewport.
- Metadata Capture and detailed request Capture are separate controls. Details default off, are disabled while metadata Capture is off, and do not silently reactivate when metadata Capture is re-enabled.
- Row click, Enter, and Space issue the dedicated detail GET only after selection. Switching rows clears the previous payload immediately; loading renders no stale panes, unavailable rows show an explicit not-captured state, and failures render an isolated retryable error state.
- Request and response details use separate responsive panes with complete endpoint metadata, encoding/byte/truncation labels, pure `pre` body rendering, safe JSON formatting, and native collapsed `details` elements for headers. Sensitive headers remain redacted, and the copy accurately distinguishes explicitly captured privacy-screened details from list metadata.
- Backend verification covers per-request capture-mode snapshots, fail-closed protected-value handling, legacy schema behavior, cached-input Token projection, nested `request.body`/`response.body` contracts, authentication, `no-store`, bounded fields, 404, and strict methods/queries.
- Final verification: UI typecheck, source lint, generated-build verification, runtime dependency audit, 615/615 unit tests, 64/64 integration tests, and 59/59 Chromium E2E scenarios passed. The full `npm test` reached the fixed-port core-chain gate, which exited with `EADDRINUSE` because the user's CRP service owns `127.0.0.1:15100` and `127.0.0.1:15101`; that service remained untouched.

## Operation-aware Account Routing QA

- Verified: 2026-08-31.
- The live route preview now requires an explicit UI operation selection while preserving `responses` as the API default. `responses`, `chat/completions`, `images/generations`, and `images/edits` travel through the same core route-decision function as proxy traffic.
- The ChatGPT Codex account route now models the official client account base plus canonical operation paths. Eligible `gpt-image-*` requests preserve the Image API path, query, body, account authorization, response headers, and response bytes without translating them into Responses tool calls; `POST /images/edits` and `/v1/images/edits` map to `/backend-api/codex/images/edits`.
- Image Edits preflight derives its parser from Content-Type. Codex `application/json` payloads read only the top-level `model` and preserve image URLs/Base64 plus the complete encoded body; standard `multipart/form-data` still requires one strictly parsed, non-file textual model field and never decodes binary parts.
- Unsupported edits formats return 415 with `unsupported_request_format`; missing models and malformed multipart return distinct 400 reasons. All three paths record no Provider and deliver zero bytes to account or custom upstreams.
- Image Edits are never replayed after account delivery. An explicit account 429 is returned and starts cooldown; only a later request can enter the custom pool, where a mapping or override rewrites only the multipart `model` field. Connection failures and timeouts also do not replay.
- Account Image Edits requests larger than 8 MiB switch to an unrestricted custom route before account delivery with the explicit `account_body_too_large` reason. If exact-model Provider selection or a mapping/override would be required, the request returns 413 without any upstream delivery because uniqueness cannot be proven beyond the bounded prefix.
- The image preview at 1440 × 900 keeps operation, request format, and model controls on one line. JSON and multipart select ChatGPT; the unsupported diagnostic shows the same zero-delivery 415 decision as live routing.
- Forwarding Records use the route-decision column to show route reason and Provider selection reason beneath the primary labels. The nine-column desktop ledger remains readable, while 390 px keeps an intentional contained table scroller with no document overflow.
- Retained visual evidence:
  - `output/playwright/task11/route-preview-traces-the-l-142cd-onditional-account-fallback-chromium/route-preview-image-edits-account-1440x900.png`
  - `output/playwright/task11/route-preview-traces-the-l-142cd-onditional-account-fallback-chromium/route-preview-image-edits-unsupported-format-1440x900.png`
  - `output/playwright/task11/route-preview-traces-the-l-142cd-onditional-account-fallback-chromium/route-preview-image-account-1440x900.png`
  - `output/playwright/task11/forwarding-records-scans-f-b6c2f--toggles-forwarding-capture-chromium/forwarding-ledger-desktop.png`
  - `output/playwright/task11/forwarding-records-keeps-t-200ce--usable-in-Chinese-at-390px-chromium/forwarding-ledger-phone-zh.png`
- Evidence scope combines the public OpenAI multipart Image Edits documentation, the locally installed official Codex binary's JSON edit markers (`image_url`, `model`, `images/edits`), and deterministic loopback fixtures; this record makes no claim of external validation against a live ChatGPT upstream.
- Final verification: source lint, UI typecheck/build verification, patch Changeset validation, package dry-run, runtime dependency audit, 673/673 unit tests, 66/66 integration tests, and 59/59 Chromium E2E scenarios passed. Full `npm test` reached the fixed-port core-chain gate and exited with `EADDRINUSE` because the user's existing CRP owns `127.0.0.1:15100` and `127.0.0.1:15101`; both processes remained untouched.

## Legacy Migration Recovery QA

- Verified on 2026-08-29 with an independent L3 review result of `APPROVE`.
- Legacy saved and runtime files are parsed as independent candidates. Malformed JSON is retained byte-exact; present-but-empty, non-string, conflicting root/nested aliases, invalid URLs, and invalid auth/header shapes cannot become candidates.
- One complete source imports one inactive `Default`; canonical duplicates collapse to one Provider; conflicting complete sources import deterministic `Recovered runtime` and `Recovered saved` Providers with separate credential references and no automatic activation.
- If no source independently forms a complete Provider, migration performs no backup, scrub, registry, or credential mutation and the Supervisor continues into ordinary Web Setup with an empty in-memory schema-9 registry.
- Parseable sources are backed up before credential writes and scrubbed only after the complete multi-Provider registry is verified. Partial credential writes compensate in reverse order; rollback degradation preserves the canonical migration and registry locks as discoverable blockers; post-commit Activity failures report committed degradation.
- Final verification: source lint, patch Changeset validation, package dry-run, runtime dependency audit, 628/628 unit tests, and 65/65 integration tests passed. The fixed-port core-chain gate exited with `EADDRINUSE` because the user's existing CRP still owns `127.0.0.1:15100` and `127.0.0.1:15101`; it remained untouched.

## Invalid Registry Quarantine QA

- Verified on 2026-08-29 with an independent L3 review result of `APPROVE`.
- Only safely readable regular files with invalid JSON, unsupported schema, or invalid registry documents are recoverable. Symlinks, directories, permission/open/fstat failures, identity races, foreign markers, and foreign/malformed transaction locks remain blocking and unchanged.
- Recovery writes a private byte-exact backup, then creates the fixed `providers.json.recovery-invalid` marker through same-directory `linkSync` no-replace semantics, verifies the original inode, fixes mode `0600`, fsyncs the marker, and removes only a canonical link that still matches the source identity.
- The `prepared`, `linked`, and `canonical-released` pending phases bind source identity, PID, transaction ID, and both lock identities. Dead-process startup can resume pre-journal, pre-link, post-link, partial-lock-release, and completed-marker scenes before ordinary lock acquisition; live owners remain busy.
- Recovery never reads, writes, or deletes credential-store entries. Activity is safe best-effort metadata and cannot block Setup after quarantine succeeds.
- Final verification: source lint, patch Changeset validation, package dry-run, runtime dependency audit, 643/643 unit tests, and 66/66 integration tests passed. The fixed-port core-chain gate remains unavailable locally because the user's existing CRP owns `127.0.0.1:15100` and `127.0.0.1:15101`; it was left untouched.
