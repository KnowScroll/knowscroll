# #161 Android: readers never see a source — emulator evidence, 2026-09-24

Owner decision (2026-09-24): readers never see a source. Sources, claims, the validator, corrections
and Relic provenance stay internal and unchanged; only their display on Android goes. API36 emulator,
test app `com.knowscroll.mobile.journeytest`, disposable database `knowscroll_test_hands_b179db6fa304`
(dropped), fixture inquiry transport, no provider call. The owner's preview was unchanged
(`preview-untouched.json`).

## Hands-on pass (coordinator, by hand)

`scripts/android-hands-on.py up` with `inquiries/seed-journey.ts` (The Sun from a supplied account,
fixture inquiry route) and `seed-day-old-history.ts`.

| Surface | What was checked | Screenshot |
| --- | --- | --- |
| Scroll reader | no "N SOURCE" pill, no Sources action or sheet, no attribution block at the end; Keep/Why/Ask only | `hands-on-03-reader-end.png` |
| Why this appeared | reason, truth state, origin and what led here; no source note | `hands-on-04-why.png` |
| How these connect | the connection, prerequisites, limits and evidence claims; no source titles | `hands-on-05-connections.png` |
| Atlas | places only (no Places/Sources toggle, no world markers); "While you were away" | `hands-on-06-atlas.png` |
| Found connection | consent turned on in Privacy & account; the fixture inquiry found The Sun–Gravity; evidence claims only; kept as a Relic | `hands-on-07-found.png` |
| Place sheet | Gravity's description, days, Scrolls read, the formation line and its evidence; no source | `hands-on-09-place-info.png`, `hands-on-10-place-evidence.png` |
| Keep / Relic | Relic "Current", checked by bridge-validator-v1, evidence claims; no source | `hands-on-11-keep.png`, `hands-on-12-relic.png` |
| Trace revisit | the saved Scroll reopens with no source | `hands-on-13-revisit.png` |

The fixture inquiry's sentence ("Fixture: …") is the labelled fixture transport's, not model text.

## Device journeys (regression guards, rebased head)

Run on the API36 emulator as `.journeytest`, each with its own disposable stack; preview unchanged.

| Runner | Result |
| --- | --- |
| `android-ui-refinement.py` (SystemViewJourneyTest) | passed |
| `android-reader-journey.py` | passed alone; once timed out opening the first Scroll (15 s) while the host was loaded — a timing budget, not a fix, recorded in #177 |
| `android-reader-explain-journey.py` | passed |
| `android-trace-revisit-journey.py` | **failed on main too**: stale since #130 moved saved Traces to the Keep tab and audit A4 labelled cards by title. The journey now opens a Trace from Keep by its title, reaching the universe first; passed |
| `android-semantic-journey.py` `sheets`, `branch`, `why`, `places`, `foundation`, `inquiry`, `return` | passed (7/7) |
| `android-native-journey.py` (port 4344, an authorized MP4) | passed |

Not run: `android-living-preview.py` (it replaces the owner's preview) and `android-native-profile.py`
(performance profile; #170).

## Also changed by the coordinator

The server's chronicle line for a sighting lost to a correction now reads "… left the horizon: what it
was based on changed." (it said "the source behind it changed"). Wording that asserts provenance
without naming a source ("A sourced connection from …", a decision-reason template in released
migration 0027, and "cited evidence" in the truth-state explanation) is left as it is.

## Limits

- Debug API36 emulator, not a physical device.
- The Reel reader's "Sources & truth" sheet is removed; its generated/test-media label stays. A Reel
  why sheet arrives with #167.
- A startup ANR ("failed to complete startup") appeared once right after install, under heavy host CPU
  load (avg10 59%); "Wait" recovered. Recorded for #170's ANR list.
