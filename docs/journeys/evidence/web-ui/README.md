# #107 web UI fidelity evidence

Spec: `docs/product/ui-system.md` (extraction of `docs/product/references/cosmos.html` and
`docs/product/references/living-observatory.html`, already accepted by the owner). Every artefact
below was produced against the real disposable API/worker/PostgreSQL provisioned by
`pnpm tsx scripts/run-web-reader-journey.ts` — never a mock — using the owner's single test
account and the three-item editorial library in `content/editorial-scrolls.json`.

## How to reproduce

```
pnpm --filter web typecheck
pnpm typecheck
pnpm --filter web test
pnpm test
pnpm tsx scripts/run-web-reader-journey.ts
```

The last command provisions everything, runs every spec in `apps/web/e2e/` (numbered so ordering
is deterministic: `00-` runs first, `90-` runs last), and writes every file listed below. Two spec
files were added for this issue and are otherwise unmodified journey infrastructure:
`apps/web/e2e/00-ui-system-evidence-empty.spec.ts` and `apps/web/e2e/90-ui-system-evidence.spec.ts`.

## Screenshots (`screenshots/`)

All at 1440×900 and 1024×768 unless noted. Produced by the two spec files above.

| File | State |
|---|---|
| `universe-empty-{size}.png` | Universe, honest empty state. Captured by the first spec file in the run, before any Keep exists anywhere in the disposable database (there is no un-Keep in this slice). |
| `universe-traces-{size}.png` | Universe with saved Traces (cream cards). |
| `reader-{size}.png` | Scroll reader: head band, context rail, reading column, truth pill adjacent to the claim. |
| `reader-sources-{size}.png` | Sources panel open (cream sheet flanking the stage). |
| `reader-why-{size}.png` | Why this appeared open (cream sheet under its context-rail trigger). |
| `reader-exhausted-{size}.png` | Finite-library rest: the three-asset editorial pool exhausted. |
| `universe-unavailable-{size}.png` | Universe unavailable (real outage via the fault-injecting proxy, then restored). |
| `universe-reduced-motion-1440x900.png`, `reader-reduced-motion-1440x900.png` | `prefers-reduced-motion: reduce` emulated; one representative size (see deviation below). |
| `universe-keyboard-focus-1440x900.png`, `reader-keyboard-focus-1440x900.png` | Keyboard-only pass: tabbed through every control on each screen; each stop verified visibly focused before the screenshot. |

## Accessibility (`axe-universe.json`, `axe-reader.json`)

`@axe-core/playwright` scans of the Universe `<main>` and the Scroll reader `<main>` (with the
sources panel open, the densest state). **Zero violations of any impact** in both reports (not
just zero serious/critical — the required bar).

## Deviations from `docs/product/ui-system.md`, and why

1. **Orange pill text is ink, not white.** Cosmos's literal `.btn.orange`/`.pill.red` recipes pair
   orange with white text. At this UI's actual sizes (13px weight-800 pill labels, 10px truth
   pills) that pairs to roughly 2.9:1, below WCAG AA (4.5:1). Ink-on-orange measures ~4.9:1. Used
   for the Retry pill and the `disputed` truth-pill tint. Every other pill/truth-pill colour pair
   was checked the same way and already cleared 4.5:1 with the literal foreground the reference
   uses.
2. **Seven truth-state tints are a smallest-necessary extension.** Neither reference enumerates
   all seven states from definition.md §12; only Cosmos's five generic pill tints (`green`,
   `red`/orange, `yellow`, `teal`, `dash`) exist as literal recipes. Mapping: `documented`→green
   (literally "verified" per the palette comment), `synthesis`→teal, `disputed`→orange,
   `fictional`→yellow, `counterfactual`→pink (the palette explicitly marks pink "reserved; unused
   until a surface needs it" — this is that surface), `interpretation`→sea, `modelled`→teal-2 (a
   distinct, still-Cosmos, still-contrast-safe tint since dashed/transparent failed contrast on a
   cream sheet — see point 1's method). No hue outside the documented Cosmos palette was used.
3. **A fifth "cream" pill variant for navigation controls on the dark ground.** ui-system.md names
   four pill variants (ink default, teal, yellow, orange); Cosmos's own reference CSS also defines
   a near-opaque cream pill (`.back` / `.pillbtn` / `.crumb`) for exactly this context (a control
   floating on the dark canvas, not inside a cream sheet). Used for the head-band back pill and
   the context-rail's Sources/Why-this triggers. `.pill.ghost` (Cosmos's literal ink-on-cream-8%
   recipe) is kept for controls that sit *inside* a cream sheet (e.g. the source panel's own Close
   button), where it was clearly designed to be used.
4. **The article, not the outer grid, owns the reading-column scroll.** Living Observatory's
   literal `.scroll-layout` CSS puts `overflow:auto` on the grid container. This app's reading
   position is persisted from `node.scrollTop` on the reading `<article>` itself
   (`ScrollScreen.tsx`); moving the scroll container up a level would silently break that existing,
   tested contract. The article keeps its own bounded height and scrollbar instead.
5. **Context-rail carries no invented narrative copy.** Living Observatory's `.scroll-aside` also
   contains a blurb assuming a Reel surface ("You came from the flock Reel..."), which does not
   exist in this product yet (out of scope per the brief's "what may not be drawn" list). The rail
   here holds only its two real, functional triggers (Sources, Why this appeared); inventing
   origin narrative would violate law 4/6 (never fabricate).
6. **No separate always-visible "actions rail".** ui-system.md's general desktop-layout bullet
   mentions a source rail *and* an actions rail flanking the stage, but Living Observatory's own
   Scroll surface (as opposed to its separate Reel/"watch" surface, out of scope here) has only one
   flanking rail; its Keep/Next-equivalent actions sit in a `.continue` row at the foot of the
   reading column. This app follows that literal Scroll structure: Keep and Next discovery sit in
   the reading column's continue row; the pre-existing toggle Source panel is the one flanking rail,
   restyled as a cream sheet, narrowing at ≤1050px and collapsing at ≤700px per spec.
7. **Universe heading size is chosen, not given.** No desktop number exists in ui-system.md for
   "Your universe" (only the reading `h2` and Reel-title sizes are specified, and Cosmos's own
   literal in-app sample of that exact heading is sized for a 360px-wide phone mock). The reading
   `h2` scale (40px, capped down at small viewports) is reused for one consistent heading rhythm.
8. **Reduced-motion and keyboard-only passes captured at one representative size (1440×900).**
   The seven required states are captured at both sizes; these two additional passes are about
   *behaviour* (motion suspended, focus visible), which does not change between the two sizes, so
   one size avoids doubling an already-large evidence set without losing anything the acceptance
   check asks for.
9. **"Reader with sources/why/truth pill" screenshots use a saved-Trace revisit, not a fresh
   discovery.** The finite three-asset editorial pool is shared for the whole disposable-database
   run across every spec file; by the time this evidence spec runs (deliberately last, "90-"), the
   pool may already be fully spent by earlier specs' own real Keep actions (there is no un-Keep).
   Trace revisit is a real, separate, already-tested read-only path
   (`docs/contracts/trace-revisit.md`) that does not compete for that pool, so these screenshots
   stay reproducible regardless of run order. The dedicated "end-of-library rest" test still opens
   a fresh discovery to demonstrate the exhaustion path itself, and tolerates either landing
   outcome (some room left, or already exhausted) since both are honest results of the same feed.

## What remains unproved

- Fidelity was judged by eye against the two reference files and the extracted numbers in
  ui-system.md; no automated pixel-diff against the references was run (none exists in this repo
  and the brief asks for eye/side-by-side judgement, not a diff tool).
- The intermediate ≤1050px/≤700px rail-collapse breakpoints are implemented per the literal
  Living Observatory CSS values but are not separately screenshotted (only 1440×900 and 1024×768,
  both above 1050px, are required and captured).
- One pre-existing, unmodified test (`apps/web/e2e/03-keyboard-and-a11y.spec.ts`'s "completes
  Universe -> Scroll -> Keep -> Next -> Home using only the keyboard") was observed to fail
  intermittently (~2 of 9 full-suite runs during this work) on its own hard-coded 5000ms wait for
  "Kept" once this issue's two additional spec files lengthened the whole run. It reproduced with
  those two files removed 0 of 3 times, and passed with them present in the final recorded run
  above. This is a latent timing tightness in a test file this slice was not permitted to touch,
  not a behaviour change in `readerStore.ts` or the reader flow; it is reported here rather than
  hidden.
