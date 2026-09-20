# #112 web Cosmos/Living Observatory fidelity evidence

Spec: `docs/product/ui-system.md` sections 1–3, 5, **5b**, **5c** (new in this issue), 6, 7 —
extraction of `docs/product/references/cosmos.html` (theme) and
`docs/product/references/living-observatory.html` (journey behaviour/narration), both driven with
Playwright/Chromium rather than only read, per sec.7's own instruction.

## What changed

- `apps/web/src/components/UniverseScreen.tsx` — rebuilt from "a heading, a sentence, a button and
  scattered dots" into Cosmos's own frame: a title HUD, a star ground of labelled bodies, a hint
  line, a yellow/teal call-to-action with a helper line, a legend, and the three-entry dock.
- `apps/web/src/components/ScrollScreen.tsx` — the head band is now Cosmos's own floating cream
  pills over the canvas rather than a bordered bar; added the reader's headline state pill
  (`DOCUMENTED · 1 SOURCE`, sec.5b); relabelled the action row "Keep this" / "keep going →"
  (labels only — every accessible name below is unchanged).
- `apps/web/src/styles.css` — new rules for the bodies, dock, legend, hint, CTA block, and the
  restyled head band; the existing truth-pill/pill/sheet rules are untouched.
- `docs/product/ui-system.md` — new section **5c**, extracting Living Observatory's frame and its
  stage-selection rule (chosen from the reader's real history, never a date), and recording which
  of its literal words are reused and which are not, with reasons.
- `apps/web/test/unit/ScrollScreen.test.tsx` — one assertion changed from `getByText` to
  `getAllByText(...).length > 0`, because the truth state now legitimately appears twice (the
  existing in-article pill adjacent to the claim, law 13; the new head-band state pill). No
  accessible name changed; see "Accessible names" below.

## Accessible names: unchanged

Every accessible name an existing test or journey depends on is byte-for-byte unchanged —
`Your universe`, `Enter Scroll`, `Saved Traces`, `Revisit the saved Trace: …`, `Return to
Universe`, `Keep this Scroll` / `Keeping…` / `Kept`, `Next discovery`, `Open sources panel` /
`Close sources panel`, `Open source`, `Retry loading the universe`, `The universe is unavailable`.
Where the reference's own words differ from these (e.g. Cosmos/Living Observatory's "Keep this" and
"keep going →" for the reader's action row, or the first-visit "Show me something ↗" CTA), the
**visible label** changed but the **`aria-label`** did not, so no test or journey needed to change
to keep passing — confirmed by the unit suite (below). The one exception is documented above
(`ScrollScreen.test.tsx`), and it changes an assertion's query, not any name it queries for.

## Methodology

1. Both reference files were opened with Playwright/Chromium (`apps/web/node_modules/.bin`'s
   `playwright` package, already a devDependency) and *driven*, not just read:
   - `cosmos.html`: the stage chips were clicked `day 1 · one planet` → `day 6` → `day 12` →
     `day 30 · a system`, and the `reel` flow chip; the product UI element (`[class*=phone]`) was
     screenshotted directly, never the page around it.
   - `living-observatory.html`: the scenario chips were clicked `First visit` → `Day 6` → `Day 30`
     → `Six months`; full-viewport screenshots at 1440×900.
2. The rebuilt components were screenshotted through a temporary, uncommitted Vite entry
   (`apps/web/.scratch-harness.{html,tsx}`, deleted before this commit) that mounts
   `UniverseScreen`/`ScrollScreen` directly with fixture props and the real `styles.css` — no
   `ReaderStore`, no `ApiClient`, no network. This was necessary because the live journey below
   could not be run in this session (see "What could not be run" — a real infrastructure blocker,
   not a substitute chosen for convenience). The fixture data is the **real** three-title editorial
   library from `content/editorial-scrolls.json` ("An orbit is not a perfect circle", "A star is a
   balancing act", "Farther out, a longer year"), never invented titles.

## Screenshots (`screenshots/`)

| File | What it shows |
|---|---|
| `reference-cosmos-universe-day1.png` | Cosmos's own universe level, day 1 (one planet, so far) |
| `reference-cosmos-universe-day30.png` | Cosmos's own universe level, day 30 (a system exists; the universe level still shows the free planet, the black hole, the nebula) |
| `reference-cosmos-reel.png` | Cosmos's own reader/reel composition: origin chip, stage, green state pill, title, summary, three-pill action row |
| `reference-living-observatory-first-visit.png` | Living Observatory's first-visit state: no topics, the seed + two dust invitation bodies, yellow CTA + helper line |
| `reference-living-observatory-day30.png` | Living Observatory's returning state: real-content-shaped bodies, legend, "Watch something" CTA |
| `build-universe-empty-1440x900.png` | This build, honest empty universe (no kept Traces) |
| `build-universe-traces-1440x900.png` | This build, universe with two real kept Traces + the uncounted "Still unexplored" body |
| `build-reader-1440x900.png` | This build, the reader with the restyled floating head band and state pill |

Put `build-universe-empty` beside `reference-living-observatory-first-visit` and
`build-universe-traces` beside `reference-living-observatory-day30`: same frame shape (title/intro
top-left, bodies scattered across the ground, CTA + helper bottom-left, legend bottom-right once
there is something to key, dock bottom-centre), same colour language as `reference-cosmos-*`
(space/cream/yellow/teal). Put `build-reader` beside `reference-cosmos-reel`: floating chips over
the canvas, a green state pill, the same three-pill row shape (ours has two pills, not three — see
deviations).

## What could not be run, and why

`pnpm tsx scripts/run-web-reader-journey.ts` (and therefore the numbered specs in `apps/web/e2e/`
that produce the full-journey screenshots/axe reports the earlier `web-reader`/`web-ui` evidence
folders hold) **could not be run in this session**. The script provisions a disposable
`knowscroll_test_*` PostgreSQL database using the lane's own `DATABASE_URL`
(role `knowscroll_lane_112`), and that role does not exist in this Mac's local PostgreSQL cluster —
every connection attempt fails with `password authentication failed for user
"knowscroll_lane_112"` (PostgreSQL code `28P01`; confirmed the role is absent from `pg_roles`, not
merely locked out). Creating or resetting that role requires writing a password into the local
PostgreSQL role store, which this session's own permission system refuses to a worker agent
("Secret-Store Writes") — correctly, since a worker should not be provisioning database
credentials unsupervised. This is recorded, not worked around: the failed run's own honest receipt
is at `docs/journeys/evidence/web-reader/last-run-receipt.json`
(`error: password authentication failed for user "knowscroll_lane_112"`, `databaseDropped: false`
because nothing was ever created).

**What was run instead**, against the real committed source:

```
pnpm --filter web typecheck   # clean
pnpm --filter web test        # 38/38 pass (6 files)
```

**What remains unproved as a result**: the live keyboard/focus walk over the new dock and body
buttons, a fresh axe scan of the rebuilt Universe screen, and end-to-end Keep/Next/Trace-revisit
through the new composition against a real API. The component-level fixture renders above show the
real component tree and real CSS rendering correctly, and the unit suite (`ScrollScreen.test.tsx`,
`ScrollScreen.layout.test.tsx`) continues to assert the keyboard contract (`↓`/`Escape`/`Home`),
the two-column grid, and truth-pill adjacency against the real component code — but none of that
substitutes for the real-API journey. Provisioning `knowscroll_lane_112` (or pointing the lane at
an already-provisioned disposable database) and re-running
`pnpm tsx scripts/run-web-reader-journey.ts` is the next action, and it is an owner/coordinator
action, not one this session could complete.

## Deviations from the two references' literal frames, and why

Recorded per sec.5b/7's own instruction ("Differences are recorded with a reason, not discovered
later"). Every one below is a case where the literal reference asserts or needs something this
product does not have real data for.

1. **No day-pill age.** Cosmos's `DAY n ▸` needs a universe creation date; the bootstrap contract
   (`docs/contracts/bootstrap-http.md`) does not return one. Not drawn.
2. **No status pill ("Lately").** Needs a real recency signal this contract does not expose. Not
   drawn (sec.5b already allows "a real recency or state, **or omitted**").
3. **No zoom controls, no system/planet/interior levels.** These need semantic geography, which
   sec.5b/6 already say does not exist. Not drawn.
4. **The unread remainder is shown, but not counted.** The feed endpoint returns up to three bounded
   candidates and never a total library size, so there is no real number to put on the "Still
   unexplored" body. It is drawn (sec.5b: emptiness/rest is a state of the design, not an excuse to
   omit it) but honestly uncounted, rather than inventing a figure.
5. **The returning-state CTA says "Enter Scroll", not "Watch something".** Living Observatory's own
   word fits a reel-watching product; this surface reads text. Reusing "Watch" would misdescribe
   the action. The *role* (one primary CTA, prominent, with a helper line) is kept; the verb is our
   own product's honest one.
6. **The Idea Room invitation card, and the growth caption, are never drawn.** Both need a
   specific fabricated claim (a fictional room and two fictional agents; a specific "you tried a
   route from X to Y" claim) that nothing in this reader's real history supports. Sec.6/law 9
   already forbid this regardless of how prominently the reference frames it.
7. **Cosmos's reader action row has two pills, not three.** "Not so fast" has no contract
   (sec.5b's own table already says so); the row is "Keep this" (yellow) and "keep going →" (teal)
   only.
8. **Body dates are formatted, not raw ISO.** The real `createdAt` timestamp is presented as
   `SEP 12` (Cosmos's own mono sub-label convention, e.g. "3 STOPS") rather than the raw
   `2026-09-12T10:00:00Z` string — same data, legible presentation.

## Self-check against section 7's first test

Side by side at the same size: `build-universe-empty-1440x900.png` next to
`reference-living-observatory-first-visit.png`, and `build-reader-1440x900.png` next to
`reference-cosmos-reel.png`. Both now read as the same *kind* of screen — a canvas with floating
labelled bodies/pills over a star ground, not a document with a heading and a paragraph — which is
the failure sec.7 names explicitly ("matches every token and still looks like a text page"). What
still differs, honestly: this build has no illustrated planet texture (no continents/atmosphere
shading — Cosmos's canvas-drawn sprites are a level of rendering effort out of scope here), and the
body count/scatter is sparser than Cosmos's because this product's real data (two kept Traces in
the fixture) is smaller than Cosmos's authored day-30 scene. Both are content differences, not
structural ones.
