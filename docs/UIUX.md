# UI/UX

## Audience and Tone

Primary users may not understand providers, processes, ports, or configuration files. Use calm, direct language, show one recommended action, and place technical details behind expandable areas.

## Device Priorities

1. Desktop browsers on macOS and Windows.
2. Keyboard-complete desktop interaction.
3. Linux browser compatibility after CLI parity is stable.

The admin UI is not designed for mobile or remote access.

## Page Map

- Onboarding: provider details → compatibility test → activate → Codex bootstrap result.
- Overview: supervisor/worker health, active provider, fixed proxy address, recent error, switch and restart actions.
- Providers: list, create, edit, test, activate, delete, and replace credential.
- Activity: sanitized lifecycle events and diagnostic export.
- Settings: read-only ports, credential backend status, capture state, and Codex bootstrap state.

## Core Interaction Rules

- A provider cannot be activated until its compatibility test passes.
- Activation shows progress and completes only after the worker acknowledges the new generation.
- Restart uses one explicit confirmation only when in-flight requests may be interrupted.
- Destructive profile deletion requires confirmation and is unavailable for the active profile.
- Secret inputs are blank on edit; masked previews are informational, never form values.
- Every error includes a plain-language cause and a next action.
- First-run provider setup persists the provider before testing it, then permits activation only after a passing test.
- Permission-restricted file credential fallback requires a dedicated, unchecked consent checkbox.
- Settings is read-only in V1; fixed ports, capture state, credential backend, and Codex bootstrap state are informational.
- An expired browser session becomes a read-only instruction to close the tab and run `crp ui` again; Task 11 does not refresh sessions.

## Visual Direction

Approved direction: **guided utility console**.

- First run uses a short step-by-step flow.
- Daily use uses a light, low-density sidebar layout.
- Status uses text plus icons, never color alone.
- Advanced process and HTTP details remain collapsed by default.

## Initial Design Tokens

- System UI font stack for native familiarity and zero font downloads.
- Neutral gray surfaces, blue primary actions, green healthy status, amber warning, red destructive/error.
- Minimum 44px interactive targets and visible keyboard focus.
- Eight-point spacing scale and restrained shadows.

## Internationalization

- Task 11 ships complete `en` and `zh-CN` runtime dictionaries inside `app.js`; separate locale assets are outside the static-file allowlist.
- Locale priority is `localStorage["crp.locale"]`, then the first supported `navigator.languages` entry after skipping unsupported entries, then English. Browser-derived/default selection does not write storage; explicit selector use writes the preference, and invalid stored values are removed.
- The language menu offers `English` and `简体中文`, has a minimum 44px target, and updates `document.documentElement.lang` immediately.
- Dates and numbers use `Intl` with the active locale. Stable IDs, ports, URLs, request IDs, and error codes remain literal.
- Every JavaScript-rendered visible string and accessible name, including validation, empty, loading, success, confirmation, live-region, session-expiry, and error cause/action copy, comes from the dictionaries. A short static bilingual `<noscript>` explanation is the only exception, and `document.title` updates with the active locale.
- English longest-form actions and warnings define layout stress cases. English and Chinese may wrap, but neither may clip, overflow, or overlap controls and adjacent content.
- Only the locale preference may enter browser storage. Control/session tokens, CSRF tokens, credentials, provider drafts, responses, and errors remain memory-only.

The full decision is recorded in `docs/superpowers/specs/2026-07-13-crp-ui-i18n-design.md`.

## Accessibility

- Meet WCAG 2.2 AA contrast.
- Preserve full keyboard navigation and semantic form labels.
- Announce asynchronous test, activation, and restart state changes.
- Respect reduced-motion preferences.

## Visual Evidence

Low-fidelity architecture, provider flow, UI direction, and dashboard/error-state screens were reviewed and approved in the local visual companion on 2026-07-10. The user approved the Task 11 Overview visual and bilingual direction on 2026-07-13. The reviewed prototype lived under `/tmp`, so it is intentionally described rather than linked as durable evidence: a light guided utility console with a compact sidebar, restrained neutral surfaces, strong operational hierarchy, clear blue primary actions, and text-plus-icon status.

Implementation acceptance must clear token and credential state before explicitly generating fresh English and Simplified Chinese Overview screenshots at 1440x900. Automatic Playwright trace, video, and failure screenshots stay disabled. Those sanitized screenshots, keyboard checks, and browser inspection become the durable visual evidence; the temporary prototype is not a repository dependency.
