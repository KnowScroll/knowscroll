# #165 typed Relics — emulator evidence, 2026-09-25

ADR-0044. Setup:

- Stack: `scripts/android-hands-on.py up --seed scripts/atlas/seed-day-old-history.ts`, with the
  fixture answer route and the correction catch-up every 3 s.
- Database: `knowscroll_test_hands_d9ec6f464d51`, dropped afterwards.
- App: the test app `com.knowscroll.mobile.journeytest` on the API36 emulator. The owner's preview
  was unchanged (`preview-untouched.json`).
- The answer text in `hands-on-03-answer.png` is the labelled fixture's, not a model's.

## By hand

1. **A passage.** In "The pull you can't see", the new Passages control lists what the Scroll says,
   one claim at a time (`hands-on-01-passages.png`). Two passages were kept.
2. **An answer.** Asked "What does gravity depend on?" and got the fixture answer. Kept it, then said
   "Seems wrong": "You marked this as seeming wrong" (`hands-on-03-answer.png`).
3. **A place.** The Gravity place sheet: "Keep this place" → "Kept in your Relics"
   (`hands-on-04-place-kept.png`).
4. **Keep.** All three kinds are listed, each with its state: the place and both passages "Current",
   the answer doubted (`hands-on-05-keep-before.png`).
5. **A correction.** An operator withdrew `nasa.gravity`, the source of the kept passages' claims.
   - Both passages now read "Corrected — what it was based on changed after you kept it".
   - The answer also reads "Corrected", even though it had been doubted: corrected beats doubted.
   - The place stays "Current": its formation does not rest on that claim
     (`hands-on-06-keep-corrected.png`).
   - A passage Relic still opens, with its kept sentence and "What this was based on was withdrawn."
     Its source is never named (`hands-on-07-passage-relic.png`).
6. **Let go.** Letting one passage go removed its row (SQL: answer 1, passage 1, place 1;
   `hands-on-08-after-let-go.png`).
7. **Pause.** With recording paused, the Passages sheet says "Recording is paused, so nothing new is
   kept." (`hands-on-09-paused.png`).
8. **Clear.** After resuming, Clear Scroll history left 0 Relics and 0 ledger rows.

Coordinator fix in this PR: the Relic sheet's back pill read "Close this connection" to TalkBack for
every kind. It now says "Close this Relic" for the new kinds; the Robolectric test failed first.

## Limits

- Debug API36 emulator, not a physical device.
- The fixture answer transport stands in for a live answer.
