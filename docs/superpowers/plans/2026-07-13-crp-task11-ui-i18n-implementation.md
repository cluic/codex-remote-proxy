# CRP Task 11 Bilingual Guided UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved guided utility Web UI in English and Simplified Chinese, using the existing secured Admin API without changing backend contracts.

**Architecture:** A semantic static shell loads one vanilla ES module. `app.js` owns in-memory auth and application state, complete `en`/`zh-CN` dictionaries, deterministic rendering, and same-origin Admin API calls; only an explicitly selected locale is persisted. Three Playwright suites share one explicitly scoped fixture that calls `createAdminServer` directly on loopback port `0` with real `SessionAuth`, a temporary `uiRoot`, injected in-memory services, and deterministic loopback mock upstreams. The Task 11 gate never launches `crp ui` or a supervisor and never touches a native keyring or external network.

**Tech Stack:** Node.js ESM 22.13+, vanilla HTML/CSS/JavaScript, existing loopback Admin API, Playwright 1.61.1 with Chromium, `node:test` regressions.

**Base:** `7a87466`

**Status:** Historical Task 11 implementation and deterministic verification completed on 2026-07-14 and committed as `d114061`; current Web acceptance is frozen and incomplete.

## Current Status and Superseded Requirements

This plan records the exact Task 11 work and evidence at `d114061`; its checked items are historical commit-bound evidence. Commit `210cb71` later removed the public file-fallback checkbox and `fallbackConsent` field. Every fallback-consent instruction or checked item below is superseded and must not be reimplemented: current public CLI/UI/Admin contracts require native credential storage and reject fallback selectors.

The current Web tree has three parked acceptance issues: first-step test-model input alignment, step-1 fields remaining visible in steps 2/3, and lack of a fresh real bootstrap/activation/start browser run after the core fixes. The `d114061` result therefore does not establish current Web acceptance. See [UI/UX](../../UIUX.md), [Status](../../STATUS.md), and [AI Handoff](../../AI_HANDOFF.md).

**Owner:** `/root/task11_ui` (completed and released)

---

## Scope Guard

The implementation writer may create or modify only:

- `node/ui/index.html`
- `node/ui/styles.css`
- `node/ui/app.js`
- `node/playwright.config.mjs`
- `node/test/e2e/crp-ui-fixture.mjs`
- `node/test/e2e/onboarding.spec.mjs`
- `node/test/e2e/provider-switch.spec.mjs`
- `node/test/e2e/restart-and-errors.spec.mjs`

The shared fixture is necessary because all three suites need identical temporary-root creation, Admin server/session setup, injected service state, mock-upstream ownership, and bounded cleanup. No second helper or fixture file is allowed.

`node/package.json` and `node/package-lock.json` are no-edit: Task 1 already landed Playwright, `test:e2e`, and packaged `ui/` assets. All `node/src/**`, `node/bin/**`, existing tests outside `node/test/e2e/**`, API/data/security contracts, lifecycle, credential, migration, and release files are no-edit. A missing backend capability or manifest defect is returned to the coordinator instead of being worked around.

The implementation contract is `docs/superpowers/specs/2026-07-13-crp-ui-i18n-design.md`. The existing `docs/API.md`, `docs/DATA_MODEL.md`, `docs/PERMISSIONS.md`, and `docs/TESTING.md` remain authoritative and are no-edit for the Task 11 implementation writer; the coordinator may synchronize living documentation after verified evidence exists.

## Required Copy Contract

Tests use these stable visible labels:

| Key | `en` | `zh-CN` |
| --- | --- | --- |
| `nav.overview` | Overview | 概览 |
| `nav.providers` | Providers | 服务商 |
| `nav.activity` | Activity | 活动 |
| `nav.settings` | Settings | 设置 |
| `onboarding.title` | Connect your first provider | 连接第一个服务商 |
| `provider.test` | Test connection | 测试连接 |
| `provider.compatible` | Compatible | 兼容 |
| `provider.activate` | Activate | 启用 |
| `codex.bootstrap` | Finish Codex setup | 完成 Codex 配置 |
| `proxy.restart` | Restart proxy | 重启代理 |
| `session.expired.title` | Session expired | 会话已过期 |
| `session.expired.action` | Close this tab and run `crp ui` again. | 关闭此标签页并重新运行 `crp ui`。 |

All other visible and accessible copy follows the same dictionary contract. Do not place user-facing English directly in render functions.

### Task 1: Build the E2E Harness and Prove RED

**Files:**
- Create: `node/playwright.config.mjs`
- Create: `node/test/e2e/crp-ui-fixture.mjs`
- Create: `node/test/e2e/onboarding.spec.mjs`
- Create: `node/test/e2e/provider-switch.spec.mjs`
- Create: `node/test/e2e/restart-and-errors.spec.mjs`

- [x] **Step 1: Create the deterministic Playwright configuration**

Set `testDir` to `./test/e2e`, use one Chromium project, disable full parallelism, and disable all automatic sensitive browser artifacts. Tests save only explicitly sanitized Overview screenshots:

```js
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: "test-results/task11",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    trace: "off",
    screenshot: "off",
    video: "off"
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }]
});
```

- [x] **Step 2: Create the one shared CRP fixture**

Export Playwright's `test` and `expect` plus a `crp` fixture with this exact public surface:

```js
// node/test/e2e/crp-ui-fixture.mjs
export const test = base.extend({
  crp: async ({ request }, use, testInfo) => {
    const harness = await createCrpUiHarness({ request, testInfo });
    await harness.start();
    try { await use(harness); }
    finally { await harness.close(); }
  }
});

// harness.launchUrl: fixture-built fragment URL matching the CLI URL contract
// harness.admin(method, path, body): control-token-authenticated setup request
// harness.createProvider(input): API fixture returning the public provider
// harness.upstream(kind): deterministic compatible or 401 loopback upstream URL
// harness.root: isolated temporary UI/state root
// harness.secret: per-test generated credential used by full-value leak scans
// harness.expectCodexBootstrapContract(): asserts bootstrap called once and status invariants remain public
// expectNoSensitiveBrowserStorage(page, secrets): exported storage/input leak assertion
```

`createCrpUiHarness` must use `mkdtemp`, copy the three current UI assets into a temporary `uiRoot`, construct real `SessionAuth` against private temporary token paths, and call `createAdminServer` on `127.0.0.1` port `0`. Inject deterministic in-memory provider, activity, settings, Codex, diagnostics, and worker services with the same public shapes used by Admin contract tests. Bind compatible and authentication-rejecting provider mocks to ephemeral loopback ports; the latter must surface stable `PROVIDER_TEST_AUTH`. Build `launchUrl` from the bound Admin origin plus `/#token=<controlToken>` to simulate the CLI URL contract without executing CLI code. Register cleanup before yielding; `close()` closes the Admin server and mocks, destroys session state, removes the temporary root, and fails if a listening socket remains. No supervisor process, native credential store, real HOME, external provider, browser launcher, or fixed sleep is allowed.

- [x] **Step 3: Write the failing bilingual onboarding tests**

In `onboarding.spec.mjs`, cover browser-language default, stored-locale precedence, create -> test -> activate -> bootstrap, the then-current explicit fallback consent, and fixed Codex invariants. The fallback case is historical and superseded by `210cb71`:

```js
test("completes onboarding in English without storing secrets", async ({ page, crp }) => {
  await page.goto(crp.launchUrl);
  await expect(page.getByRole("heading", { name: "Connect your first provider" })).toBeVisible();
  await page.getByLabel("Provider name").fill("Provider A");
  await page.getByLabel("Base URL").fill(crp.upstream("compatible"));
  await page.getByLabel("API key").fill(crp.secret);
  await page.getByLabel("Test model").fill("test-model");
  await expect(page.getByLabel(/permission-restricted file storage/i)).not.toBeChecked();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Compatible", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByRole("button", { name: "Finish Codex setup" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expectNoSensitiveBrowserStorage(page, [crp.secret]);
  await crp.expectCodexBootstrapContract();
});
```

`expectCodexBootstrapContract()` must assert that the injected `codexService.bootstrap` method was called exactly once, then issue `GET /api/v1/status` and assert `modelProvider === "OpenAI"` and `proxyUrl === "http://127.0.0.1:15100"`. The bootstrap route has an empty body, so this UI fixture must not claim it verified configuration arguments or file bytes; existing backend Codex-config tests own byte-level persistence coverage.

Add a `zh-CN` test that seeds `crp.locale`, expects `html[lang="zh-CN"]`, completes the same flow using Chinese role names, and verifies the language selector switches to English without a reload or repeated API mutation.

- [x] **Step 4: Write the failing daily-flow tests**

In `provider-switch.spec.mjs`, create tested providers A and B through `crp.admin`, open Overview, switch A -> B, navigate every daily page in both locales, verify Settings has no editable port/capture control, edit provider metadata, replace a credential through a blank secret input, retest, and confirm active-provider deletion is unavailable.

Implement `assertMessageParity(MESSAGES)` inside `app.js` and invoke it before application bootstrap. It compares sorted keys for `en` and `zh-CN` and fails closed before auth when they differ. The E2E suite loads every page in both locales and requires identical controls and landmarks. No messages, tokens, dictionary objects, or application state are exposed on `window`.

- [x] **Step 5: Write the failing restart, error, and session tests**

In `restart-and-errors.spec.mjs`, cover:

- restart with no in-flight request proceeds without a dialog;
- restart with public `inFlight > 0` opens one keyboard-operable confirmation;
- provider compatibility failure `PROVIDER_TEST_AUTH` renders localized cause and next action without treating it as session expiry;
- an Admin 401 after session establishment renders the read-only `Session expired` screen;
- the expired screen has no mutation controls and tells the user to run `crp ui` again;
- the URL fragment disappears and no token, CSRF value, credential, or credential reference appears in DOM, storage, screenshot names, console output, or captured network bodies beyond the intended write-only request.

- [x] **Step 6: Run RED and confirm the failure reason**

Chromium must already be installed in the execution environment. One-time environment preparation, when network access is explicitly available, is `npx playwright install chromium`; it is not part of the offline Task 11 gate.

Run:

```bash
cd node
npm run test:e2e
```

Expected: Playwright discovers all three specs and fails because `node/ui/index.html`, `node/ui/styles.css`, and `node/ui/app.js` do not exist or the required semantic roles are absent. Infrastructure failures, leaked processes, and timeouts are not acceptable RED evidence.

### Task 2: Implement the Semantic Shell, Auth, i18n, and Onboarding

**Files:**
- Create: `node/ui/index.html`
- Create: `node/ui/styles.css`
- Create: `node/ui/app.js`
- Test: `node/test/e2e/onboarding.spec.mjs`

- [x] **Step 1: Build the static semantic shell**

`index.html` must contain one skip link, header, primary navigation landmark, `main` target, onboarding root, application root, polite live region, and a no-script message. Load only `styles.css` and `app.js`; scripts are external modules and no inline handler is allowed:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Remote Proxy</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a class="skip-link" href="#main-content" data-i18n="a11y.skip">Skip to content</a>
  <div id="shell" hidden></div>
  <main id="main-content" tabindex="-1">
    <section id="onboarding-root" hidden></section>
    <section id="app-root" hidden></section>
  <section id="session-root" hidden></section>
  </main>
  <p id="live-region" class="sr-only" aria-live="polite" aria-atomic="true"></p>
  <noscript>JavaScript is required to manage CRP locally. / CRP 本地管理界面需要启用 JavaScript。</noscript>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [x] **Step 2: Define complete locale dictionaries and locale utilities**

In `app.js`, define frozen `MESSAGES.en` and `MESSAGES["zh-CN"]` objects with identical keys. Implement `resolveLocale`, `setLocale`, `t`, `formatDate`, and `formatNumber`. `resolveLocale` uses exactly `crp.locale` -> first supported `navigator.languages` entry -> `en`; it skips unsupported entries before inspecting later entries, maps any `zh*` tag to `zh-CN`, maps any `en*` tag to `en`, and removes an invalid stored value. Browser-derived/default selection does not write storage.

The language menu is a native `<select>` with `English` and `简体中文`. Its explicit change handler writes only `crp.locale`, updates `html.lang` and dictionary-owned `document.title`, rebuilds `Intl` formatters, and re-renders from current in-memory state without issuing an API call. E2E covers unsupported-first/supported-second browser languages, all-unsupported English fallback with no storage write, invalid stored-value removal, explicit selector persistence, and title changes in both locales.

- [x] **Step 3: Implement memory-only session establishment**

On startup, parse any `token` fragment into a narrow local variable, remove the fragment immediately with `history.replaceState`, perform one `POST /api/v1/session` bearer exchange, and clear the token variable after the exchange. Store the returned CSRF value only in module memory. All later reads use the HttpOnly cookie; mutations add `X-CRP-CSRF`.

Wrap fetch in `apiRequest(method, path, body)` that sets JSON only when a body is allowed, parses the stable public error shape, and never logs response bodies or headers. A present fragment with any failed session exchange is terminal. A missing fragment with a valid cookie may load GET endpoints in read-only mode, but must disable every mutation and instruct the user to reopen with `crp ui`; a missing fragment without a valid cookie is terminal. A later Admin session or CSRF authentication failure calls `enterSessionExpired()` instead of retrying. A provider compatibility response with `PROVIDER_TEST_AUTH` remains a provider error.

- [x] **Step 4: Implement create -> test -> activate -> bootstrap onboarding**

Historical Task 11 step, superseded by `210cb71`: render a labelled form for provider name, base URL, API key, test model, advanced auth/model fields, and the unchecked explicit file-fallback checkbox. The then-current primary flow performs:

```text
POST /api/v1/providers
POST /api/v1/providers/:id/test
POST /api/v1/providers/:id/activate
POST /api/v1/codex/bootstrap
GET  /api/v1/status
```

Historical Task 11 behavior, superseded by `210cb71`: send `fallbackConsent` directly from the checkbox. After the create request settles, clear the credential input in success and failure paths. When test fails after create, retain the public provider, render localized cause/action, keep activation disabled, and allow edit/replacement. Disable every flow button while its mutation is pending and announce each transition through the polite live region. Current public requests must omit `fallbackConsent`.

- [x] **Step 5: Implement the approved guided-console CSS foundation**

Use system fonts, neutral page/surface/border/text tokens, blue primary actions, green/amber/red semantic states, 8px spacing increments, radii no greater than 8px, 44px controls, visible `:focus-visible`, restrained shadow, and `prefers-reduced-motion`. Use wrapping grids with `minmax(0, 1fr)` and `overflow-wrap: anywhere` for technical values; do not set fixed text-container heights.

At 1440x900 use a stable compact sidebar and a constrained work area. At narrower desktop widths collapse the grid without turning the UI into a mobile product. Status must pair an icon with localized text.

- [x] **Step 6: Run the onboarding slice green**

Run:

```bash
cd node
npx playwright test test/e2e/onboarding.spec.mjs --project=chromium
npm run lint
```

Expected: English and Simplified Chinese onboarding pass, `html.lang` changes correctly, the injected bootstrap is called exactly once, subsequent status still reports `OpenAI` and `http://127.0.0.1:15100`, locale-storage rules pass, and source syntax passes.

### Task 3: Implement Providers and the Daily Pages

**Files:**
- Modify: `node/ui/app.js`
- Modify: `node/ui/styles.css`
- Test: `node/test/e2e/provider-switch.spec.mjs`

- [x] **Step 1: Render stable navigation and Overview**

Render Overview, Providers, Activity, and Settings from one state object. Overview shows supervisor/worker text-plus-icon state, active provider, fixed proxy URL, recent error, provider switch control, and start/stop/restart commands. Preserve the active page and form values when language changes.

- [x] **Step 2: Implement complete provider management**

Providers must support list, create, edit metadata, blank credential replacement, test with a model, activate after a passing test, and confirmed deletion of inactive profiles. Editing base URL, authentication, headers, model policy, or credential must immediately render the returned `untested` state; a display-name-only edit preserves test state. Never place a credential, credential reference, or masked key into an input.

Use an actual dialog or `<dialog>` for deletion confirmation with focus return. Active providers have no enabled delete command and explain why in localized text.

- [x] **Step 3: Implement Activity and diagnostics**

Load activity newest-first with bounded `limit` and `offset`, render localized category/action/result labels plus literal stable IDs/codes, and provide next/previous pagination only when available. Diagnostics export is one explicit mutation and presents only the API's redacted result. Do not display capture request/response bodies.

- [x] **Step 4: Implement read-only Settings**

Show fixed proxy/admin addresses, credential backend status, capture state, and Codex bootstrap state as definition lists or read-only status rows. Do not render a port editor, capture toggle, backend selector, or `PATCH /settings` request.

- [x] **Step 5: Run the daily-flow slice green**

Run:

```bash
cd node
npx playwright test test/e2e/provider-switch.spec.mjs --project=chromium
npm run lint
```

Expected: A -> B switching, all four pages, provider CRUD/test behavior, diagnostics, read-only Settings, both locales, and secret-input assertions pass.

### Task 4: Implement Restart, Localized Errors, and Session Expiry

**Files:**
- Modify: `node/ui/app.js`
- Modify: `node/ui/styles.css`
- Test: `node/test/e2e/restart-and-errors.spec.mjs`

- [x] **Step 1: Implement lifecycle controls and bounded confirmation**

Start, stop, and restart use the existing lifecycle routes and disable duplicate mutation controls until the operation settles. Restart reads public in-flight state: zero proceeds directly; a positive value opens exactly one localized confirmation dialog that names the interruption risk. Return focus to the invoking control and announce the resulting worker state.

- [x] **Step 2: Implement the localized stable-error catalog**

Map known stable codes, including `PROVIDER_TEST_AUTH`, DNS, TLS, timeout, 404/incompatibility, provider-not-ready, active-provider deletion, port conflict, settings-read-only, and lifecycle failure, to dictionary-owned cause/action pairs. Render request ID, stable code, and allowlisted details only inside an expandable technical section. Unknown failures use localized generic guidance and never interpolate an Error object, stack, raw response, header, or body.

- [x] **Step 3: Implement session-expired fail-closed state**

A failed session exchange, a missing launch token without a valid cookie, or a later Admin session/CSRF authentication failure clears the in-memory CSRF token, pending mutation state, secret fields, and app roots. Show only the localized terminal re-entry screen instructing the user to close the tab and run `crp ui` again. A missing token with a valid cookie instead keeps GET-only workspace reads available, disables all mutation controls, and shows the reopen banner. Do not call `/session` again, retain the control token, or offer mutation buttons in either read-only branch.

- [x] **Step 4: Run the lifecycle/error slice green**

Run:

```bash
cd node
npx playwright test test/e2e/restart-and-errors.spec.mjs --project=chromium
npm run lint
```

Expected: lifecycle confirmation, `PROVIDER_TEST_AUTH`, Admin-session expiry, keyboard dialog behavior, URL-fragment removal, localized error guidance, and sensitive-value scans pass.

### Task 5: Complete Visual, Accessibility, and Secret Verification

**Files:**
- Modify: `node/test/e2e/onboarding.spec.mjs`
- Modify: `node/test/e2e/provider-switch.spec.mjs`
- Modify: `node/test/e2e/restart-and-errors.spec.mjs`
- Modify: `node/ui/styles.css`
- Modify: `node/ui/app.js`

- [x] **Step 1: Add deterministic Overview screenshot evidence**

After fixture-created data reaches a stable healthy Overview, clear secret inputs, remove the fragment, discard the control-token variable after session exchange, and settle the live region. Then capture only `overview-en.png` and `overview-zh-CN.png` through `testInfo.outputPath` at exactly 1440x900. Disable animations through reduced-motion emulation. Screenshots must not contain the launch fragment, API keys, credential references, CSRF values, or control/session tokens; automatic screenshots, traces, and videos remain off.

- [x] **Step 2: Add semantic and keyboard checks without axe**

Use Playwright roles to require one banner, one navigation, one main landmark, one visible H1, labelled forms, named buttons, a polite live region, and keyboard-complete navigation. Test skip-link focus, sidebar traversal, language menu, onboarding submission, provider activation, restart confirmation, dialog cancel/confirm, focus return, and session-expired read-only state.

- [x] **Step 3: Add bilingual overflow checks**

For every visible text-bearing navigation item, button, field message, status row, dialog, and error panel in both locales, compare its bounding box to the containing box and fail on horizontal or vertical clipping. Run at 1440x900 and 1024x768. Allow intentional page scrolling; prohibit element overlap and clipped control labels.

- [x] **Step 4: Add browser storage and full-secret scans**

After each major flow, assert:

```js
const storage = await page.evaluate(async () => ({
  local: { ...localStorage },
  session: { ...sessionStorage },
  databases: typeof indexedDB.databases === "function" ? await indexedDB.databases() : []
}));
expect(Object.keys(storage.local).sort()).toEqual(expectedLocaleWasExplicitlySelected ? ["crp.locale"] : []);
expect(storage.session).toEqual({});
expect(JSON.stringify(storage)).not.toContain(crp.secret);
expect(await page.locator("input").evaluateAll(nodes => nodes.map(node => node.value))).not.toContain(crp.secret);
```

Add separate assertions that browser-language/default locale resolution leaves local storage empty, explicit selector use writes exactly `crp.locale`, and an invalid stored locale is removed before fallback. Also scan page text, HTML, console messages, explicit Playwright attachments, mock-upstream logs, Admin responses captured by the fixture, activity, diagnostics, and sanitized screenshot bytes or OCR-visible text for every complete generated secret.

- [x] **Step 5: Run the complete browser gate**

Run:

```bash
cd node
npm run test:e2e
```

Expected: every Task 11 browser flow passes in Chromium; both Overview artifacts are written; no keyboard, semantic, bilingual layout, storage, or secret-scan finding remains.

### Task 6: Regression, Documentation Handoff, Review, and Commit

**Files:**
- Review only: `docs/superpowers/specs/2026-07-13-crp-ui-i18n-design.md`
- Review only: `docs/UIUX.md`
- Review only: `docs/API.md`
- Review only: `docs/DATA_MODEL.md`
- Review only: `docs/PERMISSIONS.md`
- Review only: `docs/TESTING.md`
- Commit only the eight authorized implementation files listed in Scope Guard

- [x] **Step 1: Run deterministic regression and dependency gates**

Run:

```bash
cd node
npm run lint
npm run test:e2e
npm test
npm audit --omit=dev
```

Expected: syntax, browser, core unit/integration, and runtime audit gates pass with zero failures and zero runtime vulnerabilities.

- [x] **Step 2: Run diff and static sensitive-value checks**

Run `git diff --check`. Search the authorized diff and generated E2E artifacts for the complete generated test secrets, bearer fragments, CSRF values, credential references, raw causes, and stacks. Expected: no whitespace error, unrelated file, or sensitive value.

- [x] **Step 3: Request requirements review**

Ask a read-only reviewer to compare the implementation and evidence against the 2026-07-13 i18n design, Task 11 section of the approved V1 plan, `docs/UIUX.md`, and the Scope Guard. Resolve every requirements finding before quality review.

- [x] **Step 4: Request code-quality, security, and accessibility review**

Ask a second read-only reviewer to inspect session/token lifetime, storage writes, DOM secret exposure, CSRF use, duplicate mutations, focus/dialog behavior, translation parity, error rendering, cleanup, and screenshot layout. Resolve every actionable finding and rerun the affected focused test plus the complete gate.

- [x] **Step 5: Return exact evidence for docs sync**

The UI writer must report test counts, commands, screenshot artifact paths, Chromium version, locales/viewports checked, secret-scan result, files changed, and remaining platform risks. The main coordinator, not the UI writer, then updates `docs/STATUS.md`, `docs/AI_HANDOFF.md`, `docs/ROADMAP.md`, `docs/TESTING.md`, `docs/UIUX.md`, and `docs/AGENT_COORDINATION.md` from verified facts. Do not claim Task 11 implemented before that evidence exists.

- [x] **Step 6: Commit the bounded implementation**

After both reviews and all gates pass, stage exact paths only:

```bash
git add node/ui/index.html node/ui/styles.css node/ui/app.js \
  node/playwright.config.mjs \
  node/test/e2e/crp-ui-fixture.mjs \
  node/test/e2e/onboarding.spec.mjs \
  node/test/e2e/provider-switch.spec.mjs \
  node/test/e2e/restart-and-errors.spec.mjs
git commit -m "feat: add guided local management UI"
```

Actual: `d114061` (`feat: add guided local management UI`) contains exactly the eight authorized files and 5973 insertions. Package manifests, backend code, existing tests, contracts, and `output/` artifacts were not committed.

## Completion Evidence

On 2026-07-14 the implementation passed 40/40 Chromium E2E tests, the 16/16 session/Admin focused regression, the exact 233/233 `npm test` gate, syntax checks across 28 source files, and `npm audit --omit=dev` with zero vulnerabilities. The suite generated sanitized `en` and `zh-CN` Overview images at 1440x900, exercised automatic layout at 390x844, and completed deep secret scans. Requirements review and the subsequent code-quality/security/accessibility reviews ended `APPROVED` with no unresolved finding after their fixes were reverified. The exact eight-file implementation is committed as `d114061`, and the completed closeout is included in this documentation commit. This closes the historical Task 11 scope only; it does not resolve the current frozen Web issues or Task 12's pending cross-platform and L3 release gates.

## Final Acceptance Checklist

- [x] English and Simplified Chinese contain identical translation keys and behavior.
- [x] Locale priority, selector persistence, `html.lang`, and `Intl` formatting pass.
- [x] Only `crp.locale` is persisted by client JavaScript.
- [x] Create -> test -> activate -> bootstrap passes in both locales.
- [x] Historical Task 11 evidence: file fallback consent was explicit, unchecked, and unpersisted. Superseded by native-only public behavior in `210cb71`; do not reimplement.
- [x] Overview, Providers, Activity, and read-only Settings pass.
- [x] A -> B switching passes; bootstrap is called exactly once and subsequent status reports `OpenAI` plus `http://127.0.0.1:15100`, while existing backend tests retain byte-level Codex-config coverage.
- [x] Restart confirmation appears only for positive in-flight state.
- [x] Provider 401 and Admin-session expiry follow different localized paths.
- [x] Valid-cookie re-entry without a fragment is GET-only; failed exchange and later session/CSRF failures are terminal and require reopening with `crp ui`; no refresh occurs.
- [x] Keyboard, landmark, label, live-region, focus-return, and reduced-motion checks pass.
- [x] English and Chinese screenshots at 1440x900 have no clipping, overlap, or secret.
- [x] `npm run lint`, `npm run test:e2e`, `npm test`, and `npm audit --omit=dev` pass.
- [x] `git diff --check`, scope review, and sensitive-value scans pass.
- [x] Requirements and quality/security/accessibility reviews have no unresolved finding.
- [x] The main coordinator receives evidence for living-doc synchronization and L3 expert review.
