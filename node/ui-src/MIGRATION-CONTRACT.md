# CRP UI migration contract

This directory is the production Next.js App Router source for the bundled CRP
console. The exported files remain a same-origin static client of the existing
Admin API; production UI code must never use demo data.

## Runtime and routing

- `CrpApp` in `src/app.tsx` owns the single `CrpApi`, browser session state,
  workspace data, mutation serialization, notices, and terminal states.
- The root layout mounts `CrpApp` once. Navigation uses Next `Link`/router APIs
  so the in-memory CSRF token survives route changes.
- A direct visit or hard reload without `#token=...` starts read-only. Cookie
  possession alone never restores mutation access; the user must invoke the
  existing explicit resume action.
- The supported static routes are `/`, `/overview`, `/providers`,
  `/model-mappings`, `/routing-rules`, `/forwarding`, `/activity`, `/system`,
  and `/setup`.
- Route pages are thin adapters. Business views under `src/views/` keep their current named
  exports and prop contracts while their visual implementation is migrated.

## Shared UI

- Pages may continue importing `Button`, `IconButton`, `Panel`, `PanelHeader`,
  `PageHeader`, `Notice`, `ErrorNotice`, `StatusBadge`, `Modal`,
  `DefinitionList`, `EmptyState`, form fields, and `cx` from
  `src/components/Primitives.tsx`.
- New reusable primitives live in `src/components/ui/` and use shadcn source
  patterns backed by Base UI. Icons come from Lucide.
- Theme colors, type, spacing, borders, and focus treatment come from
  `app/globals.css`; pages must use the shared tokens instead of inventing a
  second palette.
- The visual direction is the approved light, compact, green CRP console in the
  Overview preview: quiet sidebar, dense operational cards, and restrained
  status color.

## Strict CSP

- The root client providers include `<CSPProvider disableStyleElements>`.
- Server-rendered markup must contain no `style` attribute, `<style>` element,
  inline event handler, remote asset URL, or secret-bearing serialized prop.
- Dynamic chart geometry uses SVG attributes or a bounded CSS class, never a
  React `style` prop. A custom `not-found.tsx` replaces Next's inline-styled
  default 404.
- No nonce, `unsafe-inline`, Server Action, Route Handler, `cookies()`,
  `headers()`, runtime rewrite, `next/font`, or default `next/image` loader is
  used by this static export.

## Parallel ownership

- Foundation owns `app/**`, `src/app.tsx`, `Shell.tsx`, `Primitives.tsx`,
  `src/components/ui/**`, `src/lib/**`, and this contract.
- Page agents own only their assigned files under `src/views/` and assigned
  business components. They must request shared changes instead of editing
  foundation files.
- Build/security integration owns package manifests, build scripts, generated
  `node/ui/**`, Admin static serving/CSP, and integration/package fixtures.
