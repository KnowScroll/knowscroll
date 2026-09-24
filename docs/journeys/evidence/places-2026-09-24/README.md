# The reader's places — evidence, 2026-09-24 (#134, ADR-0036)

A place is not authored. It forms from the reader's own attention on the editorial substrate:
a concept becomes `anchored` (attention-v1: 3+ episodes, voluntary acts on 2 days, 2 source families,
mass ≥ 4), and the Cartographer makes it a free planet, or a region of the nearest anchored
ancestor within two parent hops. Each planet or region offers up to five sightings. A sighting is
a concept one active, claim-backed typed relation (or admitted bridge) away that the reader has
never been shown. Every change is an immutable delta with a causal class and evidence; the schema
refuses a place change without one.

## What was proven

| Proof | How | Result |
| --- | --- | --- |
| Pure Cartographer | `tests/cartographer-core.test.ts` (11, 4 mutants killed) | planet vs region within two hops, shallow first; only anchored accounts; rejected anchors never return; sightings capped per place (existing ones count), ranked by distinct neighbours, claim before bridge, never already shown; a sighting the reader then reads retires ("You reached …"); promotion; a revoked relation retires its sighting; deterministic |
| Database + API | `tests/atlas-places.test.ts` (6) | gravity anchored over two days forms a planet with its account as evidence and a claim-backed sighting; another universe sees nothing; setting a place aside retires its sightings, never re-forms, is refused while paused or on a stale epoch; a source correction retires a sighting (`source_correction`); Clear erases and export carries places and deltas; the schema refuses a place without a delta, an edited delta, and a change to a settled place. Every response is parsed by the strict contract (`packages/contracts/src/atlas.ts`) |
| Android | 178 unit + Robolectric tests, lint | strict parsing, presentation, Places/Sources choice (and Sources' selection surviving a return), place sheet with its sightings' lines, a list of every live place at any depth plus recent changes, set-aside confirmation, ≥48 dp targets |
| Emulator | `KS_SEMANTIC_JOURNEY=places` (`receipt.json`, `instrumentation.txt`, screenshots) | see below |

## The device journey

A disposable database with the editorial substrate. The runner seeds yesterday through the real
API: keep "One force, many jobs", then move that day's rows back 24 hours. That is the one
simulated part, and it is labelled. On the emulator the reader then enters Cable and walks ordinary
discovery, keeping "The pull you can't see" and "A rhythm the ocean keeps" whenever the Composer
offers them. They open the System and Places is already chosen, showing a **Gravity** planet
(`places-system.png`). Its sheet reads "Read on 2 days · 2 sources", "3 of 3 Scrolls read", and
"A place formed around Gravity." (`places-sheet.png`). The chronicle line opens its evidence: the
account's numbers and the episodes behind them (`places-evidence.png`). "Set aside" asks for
confirmation, and the place is gone (`places-setaside.png`).

SQL lineage afterwards: one `place_formed` delta with causal class `personal_exploration` whose
evidence cites 5 episodes, 3 marks and 2 active days (the seeded day and the device's), one
`place_rejected` with `reader_correction`, and the place's state `rejected`. The owner's `.journey` preview was restored and verified (`preview-restored.json`).

No sighting appeared on this run: the walk had already shown every one of Gravity's neighbours
(tides, orbits, star birth). A sighting is by definition something the reader has not been shown,
so that is correct, and the sighting sentence and its support are covered by the HTTP test and the
Robolectric tests. Real output from the HTTP test: "Star formation appeared near Gravity: Gravity
explains Star formation."

A fresh-context review (PR #146) found that reading a sighting's own subject made the Android
Places layer disappear (the server kept the sighting live with attention, which the strict parser
rightly refused), plus a per-refresh sighting cap, missing chronicle lines, invisible nested regions
and a selection reset; all were fixed test-first before merge.

First device runs, retained: (1) the test scrolled the content for Keep, which lives in the fixed
toolbar; (2) it walked past one target while looking for the other, and a trip never re-offers what
it showed; (3) it demanded a sighting that the walk had legitimately consumed. Each was a test
defect, fixed in the test.

## Limits

- Bench thresholds (`cartographer-v1`); no hysteresis, naming, foundation stars, rooms, relics or
  away-time work yet (ADR-0036 "Not in v1").
- 23 editorial Scrolls and 32 concepts: few places can form, and the hierarchy is shallow.
- Debug API36 emulator, not a physical device. One day of history is simulated, as labelled above.
