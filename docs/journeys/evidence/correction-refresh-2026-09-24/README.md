# #160 correction refresh (ADR-0040) — emulator evidence, 2026-09-24

A source correction reaches the reader's places while they are away. API36 emulator
(`emulator-5554`), test app `com.knowscroll.mobile.journeytest`, disposable databases only, no
provider call. The owner's preview (`com.knowscroll.mobile.journey`) was checked unchanged after
both runs (`preview-untouched.json`, `journey-preview-untouched.json`).

## Hands-on (coordinator, by hand)

`scripts/android-hands-on.py up --port 4342` with the labelled journey seeds
(`seed-unread-sighting.ts`: Solar wind on The Sun's horizon, supplied journey knowledge;
`inquiries/seed-journey.ts`: The Sun from a supplied account; `seed-day-old-history.ts`: one
day-old keep) and `KS_CORRECTION_REFRESH_INTERVAL_MS=3000`. Database `knowscroll_test_hands_d279741a482a`
(dropped).

1. Read in the Cable and kept "A rhythm the ocean keeps" and "The pull you can't see": Gravity formed.
   The Atlas showed 2 places and 1 sighting, Solar wind near The Sun (`hands-on-01-before-away.png`).
2. Pressed Home. An operator correction withdrew the Solar wind source
   (`scripts/substrate/correct-source.ts … --action revoked`). Within one worker interval the log
   showed `{"correctionRefresh":[…],"placeChanges":1}` and SQL showed `sighting_retired` with cause
   `source_correction` and **no reader event since the correction**.
3. Relaunched: the Atlas opened on "While you were away — Solar wind left the horizon", 0 sightings
   (`hands-on-02-return.png`). "Mark as seen" cleared it.
4. Paused recording in Privacy & account (`hands-on-03-paused.png`), then corrected `nasa.orbits`:
   `corrections_seen` stayed 1 of 2 while paused. Resumed: the next pass caught up (2 of 2), still with
   no reader event.
5. Clear Scroll history: `correction_catch_up` rows 0, places 0, ledger 0 (`hands-on-04-cleared.png`).
6. Earlier in the session the app was force-stopped mid-reading and relaunched: it returned to the
   same Scroll.

## Regression guard

`KS_SEMANTIC_JOURNEY=return python3 scripts/android-semantic-journey.py` passed (`journey-receipt.json`,
source `b57c8bf`): fixture inquiry found while away, Relic kept, doubted, corrected; then
`sightingRetiredByCorrection: 1`, `placeChangedAfterTheCorrections: 1`,
`readerEventsSinceTheCorrections: 0`, `caughtUp: 1` (`journey-return-corrected-away.png`).

## Limits

- "Away" is the app in the background for seconds, not days; the worker interval was shortened.
- Solar wind is supplied journey knowledge on a journey-only source, because a walk through the
  editorial library meets every neighbour of Gravity and The Sun. The correction path is the real one.
- The away line still says "the source behind it changed"; #161 rewords it.
- Debug API36 emulator, not a physical device.
