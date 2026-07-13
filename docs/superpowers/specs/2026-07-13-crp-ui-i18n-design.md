# CRP Task 11 UI Internationalization Design

Date: 2026-07-13

Status: Approved by user

Mode: Cluic Harness Builder `iterate`

Base: `7a87466`

## Approved Context

Task 11 delivers the static guided utility Web UI against the existing loopback Admin API. On 2026-07-13 the user approved the Overview visual direction and required the first implementation to support at least English and Simplified Chinese. This addendum narrows those decisions into an implementation contract; it does not change the Admin API, provider schema, credential boundary, or lifecycle behavior.

The approved experience remains a light, low-density guided utility console for ordinary Codex Desktop users. It uses a persistent sidebar for daily navigation, a short first-run onboarding flow, restrained neutral surfaces, blue primary actions, textual status with icons, compact operational detail, and no decorative or marketing-style composition.

## Decision Drivers

- The Admin server may serve only `index.html`, `styles.css`, and `app.js`.
- The UI must remain vanilla HTML, CSS, and JavaScript with no runtime dependency or asset download.
- English and Simplified Chinese must cover the same behavior and information.
- Credentials, the control token, session identifiers, and the CSRF token must not enter browser storage.
- The language choice must survive a browser restart.
- Changing language must not reload the supervisor or interrupt an in-flight UI operation.

## Considered Approaches

### A. Runtime dictionaries inside `app.js` - selected

Keep complete `en` and `zh-CN` dictionaries in `app.js`. Semantic markup uses stable translation keys, while one renderer applies translated text, accessible names, placeholders, status messages, confirmation copy, and error guidance. This works within the three-file static allowlist, makes locale changes immediate, and gives tests one place to assert key parity.

### B. Separate locale files - rejected for Task 11

Files such as `locales/en.json` and `locales/zh-CN.json` would improve physical separation, but the current static server rejects every asset outside the three approved filenames. Supporting them would require an Admin static-serving contract and security-test change, which is outside the Task 11 UI-only scope.

### C. Separate English and Chinese pages - rejected

Duplicated HTML or route trees would repeat auth, navigation, form, error, and accessibility logic. The copies would drift and would also require new static paths. One semantic application with runtime copy is the smaller and safer design.

## Locale Contract

The only locale identifiers are `en` and `zh-CN`.

Locale selection uses this exact priority:

1. A valid `localStorage["crp.locale"]` value.
2. The first supported entry in `navigator.languages`; unsupported entries are skipped while later entries are inspected, any language tag beginning with `zh` maps to `zh-CN`, and an entry beginning with `en` maps to `en`.
3. `en`.

An invalid stored value is ignored and removed. Browser-language or English fallback selection does not write a preference. The global language selector is a native menu with values `en` and `zh-CN`, visible labels `English` and `简体中文`, a localized accessible name, and a minimum 44px target. Explicit user selection immediately:

1. writes only the locale identifier to `localStorage["crp.locale"]`;
2. updates `document.documentElement.lang`;
3. recreates locale-sensitive `Intl.DateTimeFormat` and `Intl.NumberFormat` instances;
4. re-renders the current page without repeating API mutations or discarding in-memory form values.

Dates and numbers use `Intl` with the active locale. Stable IDs, ports, URLs, error codes, and request IDs remain literal technical values. Translation lookup first uses the active dictionary and then English. Automated parity tests require both dictionaries to contain the same keys, so English fallback is a resilience path rather than normal output.

## Copy Coverage

Every JavaScript-rendered user-facing string is dictionary-owned, including:

- product and page titles, sidebar items, breadcrumbs, section headings, labels, help text, placeholders, and button text;
- skip-link text, landmark labels, icon accessible names, live-region announcements, dialog names, and confirmation copy;
- loading, empty, pending, success, warning, disabled, and read-only states;
- provider test, activation, deletion, lifecycle, Codex bootstrap, activity, and diagnostics copy;
- validation messages and the cause/action pair for stable API errors;
- session establishment, missing launch token, expired session, unavailable supervisor, and unknown-error copy.

`index.html` contains one short bilingual `<noscript>` message so a JavaScript-disabled browser still explains the requirement. It is the only visible bilingual static-copy exception. The document title is dictionary-owned after startup and updates with the selected locale.

Known API error codes map to localized cause/action entries. The UI does not use an English server message as its primary explanation. Unknown codes use a localized generic cause and next action; an expandable technical section may show the sanitized stable code, request ID, and allowlisted details. It never renders a raw cause, stack, credential reference, header, body, or secret.

The English dictionary is the layout stress reference because its action and warning phrases are generally longest. Both languages may wrap within content areas and buttons where necessary. Text containers must not use fixed heights, and Chinese text must not overflow navigation, controls, status rows, dialogs, or error panels.

## Browser Storage Boundary

Only `crp.locale` may be written to `localStorage`. The application must not write any other local-storage key and must not use `sessionStorage` or IndexedDB.

The control token is read once from the URL fragment into memory, the fragment is removed with `history.replaceState`, and the token is used for a single `/api/v1/session` exchange. The returned CSRF token remains in memory. API credentials are held only in the active secret input until submission and are cleared after the request settles. Provider drafts, test models, API responses, activity, error details, control/session tokens, CSRF tokens, and credentials are never persisted by client code.

The server-owned HttpOnly session cookie is outside JavaScript access and remains governed by the existing Admin API contract.

## Session Expiry and Re-entry

Task 11 adds no refresh endpoint and no implicit session renewal. A failed initial session exchange, missing fragment token, or later Admin-session authentication failure transitions the application to a localized read-only re-entry screen. It:

- explains that the local management session ended;
- instructs the user to close the tab and run `crp ui` again;
- preserves only the selected locale;
- clears the in-memory CSRF token, pending mutation state, and secret fields;
- provides no provider or lifecycle mutation controls.

Provider compatibility authentication failures use stable code `PROVIDER_TEST_AUTH`; they are not session expiry. They remain actionable provider errors and direct the user to replace the provider key and test again.

## Onboarding Decisions

The first-run flow uses the existing provider-ID API sequence:

1. Create the provider from name, base URL, authentication/model settings, and the write-only credential.
2. Test that saved provider with a non-empty test model.
3. Activate only after the test passes.
4. Run Codex bootstrap and continue to Overview.

If creation succeeds but testing fails, the untested/failed provider remains saved and editable. Activation remains disabled. The user receives the localized cause/action response and can replace the credential or edit the provider before testing again.

The provider form includes an unchecked explicit-consent checkbox for the permission-restricted file credential fallback. Its copy states that CRP uses it only if the native credential store cannot be constructed. The checkbox maps directly to `fallbackConsent`; it is never preselected and its choice is not persisted in browser storage.

Secret inputs are blank when editing. A credential-configured status may be shown as text, but no masked or partial credential becomes an input value.

## Daily Pages

- **Overview:** supervisor and worker health, active provider, fixed proxy address, recent actionable error, provider switching, and worker lifecycle actions.
- **Providers:** list, create, edit, replace credential, test, activate, and confirmed deletion of inactive providers.
- **Activity:** sanitized lifecycle activity and redacted diagnostic export.
- **Settings:** read-only fixed ports, credential-backend status, capture state, and Codex bootstrap state.

Settings has no capture toggle or port editor in Task 11 because `PATCH /settings` is read-only. Codex bootstrap remains an onboarding or recovery action, not a settings mutation.

Duplicate mutations are disabled while pending. Activation completes only after the existing API reports worker acknowledgement. Restart asks for confirmation only when public worker state reports in-flight requests. Active-provider deletion remains unavailable.

## Visual and Accessibility Constraints

- Preserve the approved light guided-console composition and information hierarchy at the 1440x900 acceptance viewport.
- Use system fonts, an eight-point spacing scale, restrained shadows, card radii no greater than 8px, and stable control dimensions.
- Use icons plus text for state; color is supplementary.
- Maintain a visible focus indicator and 44px minimum interactive targets, including the language selector.
- Provide semantic landmarks, one skip link, explicit form labels, keyboard-complete dialogs and menus, and a polite live region for asynchronous changes.
- Respect `prefers-reduced-motion` and WCAG 2.2 AA contrast.
- Test both locales at 1440x900 and verify that the longest English copy and all Chinese copy wrap without clipping or overlap.

## Deterministic Browser-Test Boundary

Task 11 browser tests do not launch `crp ui`, a supervisor process, a native credential backend, or any external network service. The shared fixture calls `createAdminServer` directly on loopback port `0`, uses the real `SessionAuth` contract, serves a temporary `uiRoot`, and injects in-memory provider, activity, settings, Codex, diagnostics, and worker services. Compatible behavior and `PROVIDER_TEST_AUTH` classification come from deterministic ephemeral loopback mock upstreams.

The fixture supplies a fragment-token URL shaped like the CLI contract without executing the CLI. Chromium is an environment prerequisite. Installing a browser may be documented as environment preparation, but offline Task 11 verification never downloads Chromium.

## Visual Approval Evidence

The user approved the Overview visual on 2026-07-13. The reviewed prototype existed under a temporary `/tmp` path, which is not a durable repository artifact and must not be linked as long-term evidence. The durable decision is the visual description in this document and `docs/UIUX.md`. Task 11 browser verification must generate fresh English and Simplified Chinese Overview screenshots at 1440x900 for review attachment.

## Scope and Non-Goals

This design changes only static UI assets, Playwright configuration, and Task 11 E2E coverage. It does not add locale files, a build step, a translation service, a new API route, server-side locale negotiation, user accounts, remote administration, mobile layout, or a session refresh mechanism.

## Acceptance Criteria

1. English and Simplified Chinese expose the same pages, actions, error guidance, and accessible names.
2. Locale priority is stored preference, browser languages, then English; language changes update `html[lang]` immediately.
3. Only `crp.locale` is persisted by client JavaScript.
4. A clean user completes create -> test -> activate -> bootstrap in either locale.
5. File fallback requires an unchecked, explicit-consent checkbox.
6. Settings is visibly read-only.
7. Session expiry becomes a localized read-only instruction to reopen with `crp ui`; no refresh is attempted.
8. After tokens and credentials are cleared from UI state, explicit English and Simplified Chinese 1440x900 Overview screenshots match the approved guided utility direction without overflow or overlap.
9. Keyboard, semantic-role, live-region, reduced-motion, and secret-storage checks pass.
10. No Admin API, data, permission, CLI, credential, or lifecycle contract changes are required.

## Merge Classification

The documentation addendum is L0. The resulting Task 11 implementation remains L3 because it handles browser-local authentication, credentials, provider mutations, Codex bootstrap, and worker lifecycle. It requires deterministic checks, browser evidence, secret scans, AI review, and expert confirmation before merge.
