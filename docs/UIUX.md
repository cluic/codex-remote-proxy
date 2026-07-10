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
- Settings: ports, credential backend status, capture toggle, Codex bootstrap state.

## Core Interaction Rules

- A provider cannot be activated until its compatibility test passes.
- Activation shows progress and completes only after the worker acknowledges the new generation.
- Restart uses one explicit confirmation only when in-flight requests may be interrupted.
- Destructive profile deletion requires confirmation and is unavailable for the active profile.
- Secret inputs are blank on edit; masked previews are informational, never form values.
- Every error includes a plain-language cause and a next action.

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

## Accessibility

- Meet WCAG 2.2 AA contrast.
- Preserve full keyboard navigation and semantic form labels.
- Announce asynchronous test, activation, and restart state changes.
- Respect reduced-motion preferences.

## Visual Evidence

Low-fidelity architecture, provider flow, UI direction, and dashboard/error-state screens were reviewed and approved in the local visual companion on 2026-07-10. High-fidelity browser screenshots remain a required pre-implementation alignment gate, not a completed artifact.
