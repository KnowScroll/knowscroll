# Folio: the Scroll as an essay

Folio draws a Scroll as an essay in one scrolling column: beats of text, figures set after the beats that change them, and a figure that holds while the beats about it pass (#732, D-423). Status: **implemented** behind a device switch, unit-tested and smoke-tested on the web; the hold is checked on the Android emulator by `apps/client/maestro/folio.yaml`. The Stage reader is still the default.

## How a document becomes a screen

```
scroll-document.v2 ──readingModelOfV2──► ReadingModel ──► FolioReader
```

- `reading-model.ts` is what the reader draws: sections of blocks, each a **beat** (one unit of reading, named by the document's unit id), a **figure** (a picture state, with a control under it when it has one) or a **hold** (one figure and two or three beats, with the figure's state for each). The reader knows no document version.
- `from-v2.ts` makes one from a released `scroll-document.v2`. Every layout choice is made there, from the document alone, so the server sends nothing new. Its doc comment lists the rules.
- **A new document version** (`scroll-document.v3`) needs a new adapter beside `from-v2.ts` and nothing in the reader. The screens that name a unit to the server (Ask, Quick answer, Share a moment, Challenge, Keep, Report and the reading record) send a stop id today; a v3 beat id needs those contracts too.

## The pieces

| File                                                                            | Job                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folio-reader.tsx`                                                              | The column, the opening, the progress rail, keys, the handle a screen uses, what is being read                                                                                                                                                                                                                                                                                           |
| `beat-view.tsx`                                                                 | A beat: subhead, words, "Say it simpler", guide line, play block, side notes, the screen's footer (a Quick answer)                                                                                                                                                                                                                                                                       |
| `figure-view.tsx` | A figure on its plate, its "Text" chip in a strip along the plate's bottom (so it covers no label), the tilt slider under it. As words, the plate grows to fit them. A held figure keeps the height the hold is built on, and its chip turns on the reader's text version, since its words would not fit a pinned plate; with every picture as words, holds lie flat, and the beat being read is kept in place while the essay reflows (`kept-place.ts`) |
| `hold-view.tsx`, `pinned-figure(.web).tsx`, `hold-geometry.ts`                  | The hold. The web pins the figure with `position: sticky`. Native pushes it down its hold from the scroll offset the UI thread drives, because a React Native sticky header lets go only when the next one arrives. Which beat the figure shows is `heldBeatAt`, a pure function of where the beats are                                                                                  |
| `end-plate.tsx`                                                                 | The takeaway, the picture of the whole journey, Small print, then Part 2, Next idea and Close                                                                                                                                                                                                                                                                                            |
| `essay-layout.ts`                                                               | Figure heights, the reading band, and two layout rules: a held figure sits beside its beats only where the reader is at least 900 px wide (`holdsBeside`; Explore's desktop with its thread panel is narrower), and a hold pins only where the figure leaves room to read (`canPinHolds`: a phone held sideways or text at 150 % or more draws each beat followed by its figure instead) |
| `folio-keys.ts`                                                                 | Keys: every reader's command keys, plus scrolling (↓ ↑ a step, Space and Page keys a screen, Home and End)                                                                                                                                                                                                                                                                               |
| `beat-reading(.web).ts`, `places(.web).ts`, `kept-place.ts`, `person-input(.web).ts`, `scroll-offset.ts` | Measuring a beat for reading evidence; where each beat starts (on the web measured from the page when asked, because a layout event does not fire when a box only moves); keeping a beat in place while the page settles (at the opening, a kept place; after the text version is switched, the beat being read), until the person's own input (a wheel, a touch, a key) lets it go; the scroll offset the hold and the rail follow without re-rendering the reader                                        |

Colours come from `usePagePalette()` (`../page/page-palette.tsx`). The page follows the person's appearance with a palette of its own (D-424): on the web `scrollPageSurface()` names the page and every colour inside it is a custom property, so switching appearance repaints the essay at once and keeps the place; native draws the Light page for now (#740). Figures are drawn by role (`../kit/parts.tsx`): a line in ink, a dark body in `SOLID`, a lit side in `LIT`. `/gallery-folio?figures=1` puts every figure state of a document on one page, to look at each kit in both appearances.

## How reading is measured

Each beat's wrapper is measured by the article's hooks (`../reading/`): IntersectionObserver on the web, layout and scroll offset on native. Only a band of the viewport counts (`readingBandOf`: from 42 % down to 12 % above the bottom), so a beat hidden behind a held figure is never visible and only a few beats count at once. The ids reported are stop ids, as the Stage reader's were; nothing a person does with a figure or a play block is reported. The stop being read (for Keep, Ask and Share a moment) is the last beat whose top has passed the top of the band; a kept place or a jump puts its beat there, so the stop opened is the stop being read.

Measured on 18 Nov in Chromium at 390 × 844 over the Seasons CI fixture and judged by the server's own `summariseReading` and `qualifyScrollReading`: a careful read (about 2½ minutes) qualified (coverage 1, q 0.94); a fast one (about a minute) did not (coverage 0.25); a ten-second skim did not (coverage 0).

## Looking at it locally

The gallery build has `/gallery-folio`, which draws the v2 CI fixtures with no backend: `?doc=` one of `seasons`, `tides`, `greenhouse`, `star`, `transit`, `circulation`, `nerve`, `starlight`, `blackHole`, `scaleChart`, `sortFork`; `stop=` to open at a stop; `motion=reduce`; `scale=2`. It records what the reader reports in `window.__ksFolioGallery`.

```
pnpm --filter @knowscroll/client build:gallery
cd apps/client && node e2e/serve-export.mjs dist-gallery 4331   # then open http://127.0.0.1:4331/gallery-folio
```

In the app, turn on Account → Accessibility & playback → "Read Scrolls as an essay (trial)". Tests: `pnpm --filter @knowscroll/ui test` (unit), `e2e/folio-gallery.spec.ts` and `e2e/folio-reader-smoke.spec.ts` (browser).
