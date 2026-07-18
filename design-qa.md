# CRP Web V8 Design QA

Date: 2026-07-16

## Comparison Contract

- Reference: `output/web-v8/reference/v0-overview-default.png`
- Implementation: `output/web-v8/implementation/overview-1272x716.png`
- Combined comparison: `output/web-v8/comparison/overview-1272x716.png`
- Capture surface: the same local in-app browser and matched 1272 x 716 PNG viewport.
- State: Simplified Chinese, Supervisor connected, Worker running, active tested Provider, Codex configured, writable management session.
- Comparison layout: v0 reference on the left; V8 implementation on the right.

## Visual Review

The implementation retains the v0 target's quiet local-operations character: fixed sidebar, compact top bar, restrained white/gray surfaces, dark green runtime band, small radii, dense status facts, Lucide controls, and bilingual navigation. The approved V8 change intentionally replaces the lower first-screen proxy-control cards with anonymous Metrics so request volume, success rate, observed Tokens, model distribution, and Provider performance become immediately scannable.

Issues found and fixed during comparison:

- Removed the page-sized focus outline created by programmatic route focus while retaining focus rings on interactive controls.
- Wrapped visually hidden chart tables in a clipped non-table container so accessibility data cannot create mobile horizontal overflow.
- Kept all model requests visible through Top 7 plus Other aggregation.
- Hid empty Activity pagination rather than rendering an invalid `1-0` range.
- Rendered latency overflow as `> 300 s` instead of presenting it as missing data.

## Additional Evidence

- Provider cards: `output/web-v8/implementation/providers-1280x720.png`
- Mobile Overview: `output/web-v8/implementation/overview-390x844.png`
- Chromium acceptance: 33/33 passed.
- Responsive matrix: English and Simplified Chinese passed at 1440, 1024, and 390 widths.
- Stable mobile state: no document overflow, no visible off-screen controls, and the closed drawer is hidden from interaction and accessibility order.

## Result

PASS. The final comparison has no unresolved P0, P1, or P2 visual defect.
