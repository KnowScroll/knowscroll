# Foundation Stars — evidence, 2026-09-24 (#131, #134, ADR-0037)

A live planet or region is a foundation when its anchor explains, or comes before, at least three
things across at least two of the reader's other live places, each connection sourced by an active
claim or an admitted bridge. Attention plays no part. Recognition and withdrawal are deltas like
every other change to a place (`cartographer-v2`); the atlas returns `foundation: {holdsUp,
relations}` per place.

## What was proven

| Proof | How | Result |
| --- | --- | --- |
| Pure Cartographer | `tests/foundation-stars-core.test.ts` (7; a mutant that lets `applies_to` count is killed) | recognised at three sourced connections across two places, not at two; a claim and a bridge for the same connection count once; only explains/prerequisite_for, in the foundation's direction, and never a sighting; withdrawn as `source_correction` when a connection is revoked and `reader_correction` when a held-up place is set aside; re-recorded with its cause when its connections change while it stands (it grows, a held-up place is set aside, a source changes); the foundation step alone is what a rejection re-plans; a foundation set aside is withdrawn first. The v1 tests (`cartographer-core`, `atlas-places`) pass with only the expected policy version renamed |
| Database + API | `tests/foundation-stars.test.ts` (5) | Gravity holds up Tides, Orbit and Star formation with the claims that say so; setting Tides aside withdraws it in the same request and changes nothing else (a stored account with no place is left alone); a foundation set aside is withdrawn first and export carries the flag; the latest recognition is what is shown; the schema refuses the flag on a sighting, a flag change without a delta, and a flag change with any delta but a foundation one; every response parsed by the strict contract |
| Android | 194 unit + Robolectric tests, lint | strict parsing (a place must say whether it is a foundation; never on a sighting; never holding nothing up or citing nothing); the two new chronicle kinds; the marker's glow and spoken "Foundation"; the list's "· Foundation"; the sheet's Foundation section; evidence wording for both deltas and for a re-recorded foundation; a connection is listed once; the selected planet says Foundation |
| Emulator | `KS_SEMANTIC_JOURNEY=foundation` (`receipt.json`, `instrumentation.txt`, screenshots) | see below |

## The device journey

The one simulated step comes first, and is labelled. Tides, Orbit and Star formation are made
places by the real Cartographer from accounts the runner supplies (zero readings, zero days, no
episode). The editorial library cannot anchor Orbit or Star formation from reading, because each
has Scrolls from a single source family. The runner then seeds yesterday through the real API
(keep "One force, many jobs", rows moved back 24 hours), exactly as in the places journey.

On the emulator the reader walks ordinary discovery and keeps "The pull you can't see" and "A
rhythm the ocean keeps". The refresh that forms Gravity from that reading also recognises it as a
foundation, in the same transaction (checked in SQL). The System reports four places; on this
run's overview Gravity carries its ring beside Star formation, while Tides and Orbit sit under
other markers by the layout's collision policy (`foundation-system.png`; the list always has all
four). Gravity's sheet reads "Foundation — Holds up Orbit, Star formation and Tides", each
connection with its claim and source (`foundation-sheet.png`). The chronicle line "Gravity holds
up Orbit, Star formation and Tides." opens its evidence: "Recognised from 3 sourced connections to
3 of your places." (`foundation-evidence.png`). Back on the map with Gravity selected, it is drawn
with its glow and ring and says "Foundation" to accessibility services, which the test asserts
without condition (`foundation-marker.png`). The reader sets
Tides aside from the list; Gravity is no longer a foundation, and the list's recent changes say
"Gravity no longer holds up the places around it.", whose evidence reads "After you set a place
aside, it no longer has enough sourced connections to your places." (`foundation-withdrawn.png`).

SQL lineage afterwards (`receipt.json`): Gravity's `place_formed` is `personal_exploration` from
at least 3 episodes over 2 days; one `foundation_recognised` (`substrate_neighbourhood`, 3
connections) in the same transaction as that formation (same `txid`); Tides' `place_rejected`
(`reader_correction`); one `foundation_withdrawn` (`reader_correction`); `load_bearing` false now;
exactly 3 places formed from supplied accounts. The owner's preview was restored and verified
(`preview-restored.json`). No provider call.

First device run, retained: it passed, but its screenshots showed every connection twice on
Gravity's sheet — under Foundation with its claim, and again under Connections with the bridge's
mechanism. Fixed test-first (a connection its foundation lists is not repeated); the run here is
after that fix. That run's same-refresh check compared timestamps, which differ per row; it now
compares the inserting transaction.

Both runs are from `d51af5b`, after the review fixes below: the places journey (whose reader walk
now lives in a shared `AtlasJourneySupport`) passed again unchanged, and the foundation journey
above. Gates on that head: backend 13 + 844, Android 194 + lint (web 87 on `6f8a910`; web is
untouched since).

A fresh-context review (PR #148) found that a standing foundation's connections could go stale
(showing a set-aside place or a revoked claim, or an empty `holdsUp` that would blank Android's
Places), that setting a place aside re-ran the whole Cartographer, and that this README claimed a
brighter marker the screenshot did not show. All were fixed test-first, with the minor findings
listed on the PR.

## Limits

- Bench thresholds (three connections, two places); no model-written explanation; no galaxies.
- Three of the four places were formed from supplied accounts, as above. The fix is inventory:
  a second-family Scroll each for Orbit and Star formation (recorded on #134).
- Debug API36 emulator, not a physical device. One day of history simulated, as in the places
  journey.
