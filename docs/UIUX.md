# UI/UX

## M2E/V8 Current Direction

V8 completely replaces the previous Web implementation while using the rendered v0 prototype only as its visual target. The application uses a neutral near-white canvas, white operational surfaces, deep forest-green primary actions, restrained amber/green/red state accents, an icon sidebar, a compact top bar, and bilingual local-console copy. It does not reuse the prototype's Next.js shell, remote Geist font, Analytics, mock state, fake delayed mutations, authority toggle, wrong ports, masked credential previews, or oversized dependency set.

The authored source is a React + TypeScript SPA under `node/ui-src/`, built by Vite. Production serves exactly `node/ui/index.html`, `node/ui/app.js`, and `node/ui/styles.css` from the existing same-origin Admin server. There is no frontend runtime server, CDN, remote font, telemetry, source map, inline script/style, or dynamic chunk.

## Information Architecture

Permanent navigation is:

- Overview
- Providers
- Forwarding Records, disabled with `Coming soon / 即将上线`
- Activity
- System

Setup is conditional and resume-safe rather than a permanent destination. Forwarding Records is not a link and has no route, request, mock records, payload view, export, purge, or Capture control.

## Conditional Setup

Setup derives its phase from authoritative Provider, Codex, and Worker facts. It never stores setup progress or secret drafts.

1. Save a Provider with a blank write-only credential field.
2. Choose or manually enter a model, optionally refresh the independent model catalog, and run the Responses compatibility test.
3. On the first success, request `activateIfNone: true`; the first-wins compare-and-set selects the Provider while the Worker remains stopped. A previously tested but unselected Provider is tested once more to perform the same selection.
4. Confirm and run Codex bootstrap/history repair against fixed `OpenAI` and `http://127.0.0.1:15100`.
5. Start the Worker explicitly, then open Overview.

Setup never calls explicit Provider activation. Ordinary Provider-page tests also omit `activateIfNone` unless the user selects a switch action.

The Setup model-refresh action aligns with the model input/select control rather than the catalog-count help row; narrow single-column layouts remove the desktop alignment offset.

## Overview

Overview begins with one compact readiness/action band and separate management, Worker, active-Provider, and Codex facts. Anonymous Metrics follows and supports 24-hour and 7-day windows independently from Capture; permanent lifecycle controls live in the sidebar runtime block.

The Metrics presentation contains:

- request volume, success rate, observed Token total and coverage, and P95 response-start upper-bound KPIs;
- request-result and observed-Token trends;
- model request distribution, with bounded remainder grouped as Other;
- a Provider performance table with request count, success rate, and P95 duration upper bound;
- explicit empty, unavailable, degraded, and data-quality states.

Token or latency values without observations display `-`, never a fabricated zero. A histogram overflow displays greater than the final 300-second bound. Charts include equivalent visually hidden tables, and color or hover is never the only information channel. Metrics never implies cost, billing, exact latency, or per-request inspection.

Start, Stop, and Restart remain explicit. Stop leaves the Supervisor and Web available. Restart confirms only when the latest status reports in-flight requests. Lifecycle controls appear after Metrics rather than competing with the readiness summary.

## Providers

Provider cards show name, safe Base URL, test state, model policy, credential-configured state, last test, active state, and legal actions. IDs remain technical detail rather than the primary human label.

Cards expose direct `Switch`, `Test and switch`, and stopped-Worker variants whose labels explicitly include `and start`. Production explicit activation applies the new snapshot to a running Worker or starts a stopped Worker; it is never described as selection-only. The previous Provider remains current until the Admin response and authoritative refresh confirm success.

Create, edit, model refresh, compatibility test, activation, credential replacement, and deletion remain separate operations. Active Provider edit, credential replacement, and deletion are unavailable with a reason. A delete confirmation names the Provider and explains that its credential and model catalog are removed.

Credential fields are blank write-only inputs. They are never prefilled, hinted, partially revealed, displayed as masked saved values, or retained after submission begins. Only `Configured` or `Not configured` is readable.

## Activity And System

Activity is sanitized control-plane history, not traffic analytics. It uses a dense paginated table, newest first, and shows only timestamp, allowlisted action/category/result, resolvable Provider identity, stable error code, and bounded safe details. There are no request/response bodies, raw logs, Capture contents, search, filters, or traffic charts.

System shows immutable local facts for fixed proxy/Admin addresses, Codex identity and readiness, Worker state, and the required native credential backend. Its two writable actions are Prepare Codex and Generate diagnostic summary. The diagnostic result is memory-only `{ created, generatedAt, eventCount }`, not a file or download. Capture settings and controls are omitted.

## Responsive And Accessibility

Desktop uses a roughly 256px sidebar, compact top bar, constrained content width, 16px component gaps, 24px section gaps, and surfaces no rounder than 8px. Narrow layouts use a focus-trapped drawer, 16px page padding, one-column content, stable chart dimensions, wrapping technical values, and full-width primary actions where needed.

The application is responsive rather than desktop-only. The required narrow viewport is 390x844. Closed off-canvas navigation is hidden from pointer, focus, and accessibility traversal; stale asynchronous focus restoration is cancelled. Long English/Chinese names, URLs, model IDs, and errors must not create page-level horizontal scrolling or overlap.

Interactive targets are at least 44px. Visible focus, skip navigation, semantic landmarks/forms/tables, reduced-motion support, text-plus-icon status, and WCAG 2.2 AA contrast are required.

## Access And Internationalization

The full interface ships equal `en` and `zh-CN` dictionaries inside `app.js`. Locale priority is stored explicit `crp.locale`, then English; browser language is never inferred. Only explicit selection writes storage, so a Chinese selection is retained on subsequent launches. Dates and numbers use `Intl`; stable IDs, URLs, ports, request IDs, and error codes remain literal.

The launch fragment is exchanged once, removed, and cleared from memory. A valid cookie without a launch fragment opens a GET-only workspace whose mutation controls are disabled before interaction. A visible recovery action may restore management while the session remains valid; recovery rotates cookie/CSRF values, preserves the original expiry, and never re-reads the control token. A failed launch exchange, expired recovery, or later business-session/CSRF authentication failure is terminal for the tab. Credentials, tokens, drafts, responses, and errors never enter browser storage.

The sidebar runtime block is the permanent fast-control surface: it shows the stable `OpenAI · :15100` route, Worker state and in-flight count, a Provider selector, and icon-only start/stop/restart controls with hover labels. Overview retains readiness and metrics but has no duplicate bottom lifecycle/route panels. Global success/error feedback is a fixed, closable overlay and must not move page content.

Model testing uses a real select when a catalog exists and always provides an explicit manual-model option. Provider cards expose an icon-only duplicate action; duplication pre-fills non-secret routing configuration, generates a unique editable name, and requires a new blank API key.

## Current Acceptance Status

V8 local acceptance passes Chromium 33/33, including English and Simplified Chinese at 1440, 1024, and 390 widths. The matched 1272x716 v0/implementation side-by-side comparison, desktop Provider capture, narrow Overview capture, overflow checks, and final findings are recorded under `output/web-v8/` and in `design-qa.md`; no unresolved P0/P1/P2 remains. Historical Task 11 or V7 41/41 results remain evidence only for their earlier trees.

## Historical Evidence

The user approved the original Task 11 Overview direction and bilingual requirement on 2026-07-13. Task 11 later generated sanitized 1440x900 English and Chinese Overview artifacts and exercised 390x844, and M2D/V7 passed a request-order-only Chromium regression. Those results belong to their exact historical trees. V8 supersedes the old blue-primary guided-utility implementation and its parked field-alignment/stale-step defects; the old screenshots remain historical references, not current release evidence.
