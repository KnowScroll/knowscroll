# Cosmic origin — browser evidence, 2026-10-16 (#220, ADR-0049 proposed)

Observed on branch `claude/220-cosmic-origin` in headless Chromium (ANGLE/Metal) on the owner's
Mac against **disposable** stacks started by `scripts/run-web-cosmos-preview.ts` (fresh, and
`--grow`); each dropped its own `knowscroll_preview_*` database on exit. No owner data was used.

The grown stack's places formed through the real HTTP API (feed → exposures → keeps, asks, one
branch). Places need deliberate acts on two separate days, so the script moved the first day's
reading back 24 hours inside its throwaway database, as the repository's journeys do. With the
editorial library it reaches two stars (Gravity, Tides), a connection, two question worlds and
two possibilities; it cannot honestly reach a region, a foundation or an argued room, so "under
tension" and "lights others" are shown only in the isolated preview, on labelled illustrative
fixtures.

## Recording

`cosmic-origin-walkthrough.mp4` (3 min 3 s, 1440×900, 48 MB, **with sound** on segments 1, 2 and
4) is kept outside Git (`/Volumes/Mrigesh SSD/knowscroll-dev/media/cosmic-origin/` and the owner's
`~/Desktop/knowscroll-cosmic-origin/`). Browser recordings carry no audio, so the score was rendered
offline by `apps/web/scripts/render-origin-score.mjs` (the same builder the live sound uses) and laid
under the picture from the moment each story started; the expansion flash and the hit coincide
within about 50 ms. Segments, each labelled in the video:

| # | Segment | Start |
|---|---|---|
| 1 | First visit, desktop, with its score: the whole opening, the handoff, tapping the first possibility (ship flight), a real Scroll | 0:00 |
| 2 | A browser that has seen it: no opening; "↺ Opening" replays it (with sound until Skip); Skip | 0:38 |
| 3 | Reduced motion: still frames advanced with Next, then the Universe | 0:52 |
| 4 | First visit on a 390×844 phone, with its score: the whole opening, then a real Scroll | 1:09 |
| 5 | Grown universe: approach Gravity, the sheet's reasons, land on its question world, turn the globe, "Read from Gravity" → a Gravity Scroll labelled "From Gravity · read from your sky", back, approach Tides. A browser's first sight of a sky draws no "Just changed": it cannot know what is recent | 1:44 |
| 6 | Grown universe on a phone: star system, landing, read from Gravity | 2:13 |
| 7 | Isolated preview: two recorded changes replayed as they play once (Light starts to light others; Orbit forms inside Gravity), every star condition, and the proposed perspective-world release | 2:27 |

## Stills

`01`–`07` first visit on desktop (before form, expansion, first stars, transformation, new worlds,
the Universe, the first Scroll); `08`–`09` phone; `10`–`13` grown universe, star system, world
landing and the scoped Scroll; `14`–`16` the isolated preview (illustrative fixtures): a replayed
change, an under-tension star, the proposed perspective world.

## Measured

- 61 frames per second in the first-stars act, 1440×900 and 390×844 (headless, Metal), before the
  cinematic pass; the lens treatment adds a half-resolution bloom pyramid and is reduced on small
  or 4-core devices (four levels, no streaks or shafts). Not re-measured on physical devices.
- Score: −18.0 LUFS integrated, −3.1 dBTP true peak; hits at 3.60 s, 11.75 + 0.34·i s, 17.2 s and
  22.0 + 0.45·i s, checked against the picture's timeline in unit tests.
- After the opening: no overlay element, the app shell is no longer `inert`, `ks_origin_v1=seen`.
- A returning reader (kept Traces) never sees the opening or its controls, even in a browser that
  has not seen it (the overlay holds a dark frame until history is known); replay works; Skip and
  Escape end it.

## Journeys (2026-10-16, this branch)

| Suite | Chromium | WebKit |
|---|---|---|
| Cosmos (`scripts/run-web-cosmos-journey.ts --browser all`) | 13/13 | 12 passed, 1 skipped (the separate WebGL-disabled Chromium) |
| Web reader (`scripts/run-web-reader-journey.ts`) | 52 passed, 3 skipped | 52 passed, 3 skipped |
| Web owner, web why | 1/1 each | not run (Chromium-only configs) |

## Not proved here

Physical phones (iPhone Safari, Android Chrome) — touch, rotation, memory and frame timing,
including the cost of the lens treatment; real WebKit GPU behaviour beyond Playwright's WebKit
engine; how the score sounds on real speakers (measured, not listened to in a headless run); the
opening on a real owner universe.
