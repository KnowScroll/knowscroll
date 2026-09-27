# #170 Android acceptance matrix — emulator, 2026-09-25

The personal journeys, frame timing, startup, memory and accessibility were checked on final main `bb86ad9`, together with this PR's fixes. Every run used the test app `com.knowscroll.mobile.journeytest` on the API36 emulator (host GPU, 1080×2400). After each run, PreviewWatch confirmed the owner's `.journey` preview was unchanged.

- **Stack.** `scripts/android-hands-on.py up`, with:
  - the day-old Ask seed and the inquiry seed;
  - one authorized test Reel minted over a library Scroll;
  - the labelled fixture transports for inquiries and answers;
  - the correction catch-up every 3 s.
- **Database.** `knowscroll_test_hands_7835e59c339c`, dropped afterwards.
- **No screenshots are committed.** The test Reel shows the owner's own footage, so they stay in the ignored `artifacts/`.

## Journeys (by hand)

| Journey | What was done | Result |
| --- | --- | --- |
| **A** — replace a doomscroll reflex | Universe → Cable (Reel) → watched the Reel → swiped up twice (the Reel library ends honestly: "You have reached the end of this library") → Scroll mode, two vertical steps → kept "Closest to the Sun in January" → Home | Effortless, and one trace remains ("2 kept so far"). **There is no prediction input.** The Scroll poses its question, and Ask is the nearest reader act. |
| **B** — a good rabbit hole | Reel → "Continue →" → "Explains Orbit" → from that Scroll, "Explains Star formation". Disagreed with a passage ("seems wrong") and with an answer. Kept the other passage. The Gravity place holds an Idea room. | Two horizontal steps, with the way back kept. The disagreements were recorded privately. Keep lists the passage and the connection Relics as Current. |
| **D** — a world emerges | Turned on "Look for connections", then read until Gravity formed (next to the seeded Sun). The background inquiry (fixture) found The Sun ↔ Gravity. | The Atlas return says "Found a connection: The Sun and Gravity." It opens with its sentence and its evidence claims, never a source. Kept. |
| **E** — a world changes while away | With the Gravity room open, pressed Home and withdrew the doubter's source (`correct-source.ts`). | The worker's catch-up unseated the doubter (`inhabitant_unseated`, `source_correction`). The open room re-read on return: "One reading so far". Its chronicle says "The doubter left: what its claims were based on changed", and the evidence names the claim the doubter held. The return list says the same. |
| **G** — correct without authoring | "Why this appeared" on a connection Scroll → "Wrong connection" | "This connection is hidden for you. Nothing shared changed." The Reel's chooser later no longer offered it. No profile editor exists. |
| **H** — something about yourself | Asked about gravity on day two (the day-one Ask is seeded) | The carried question opened a room under the reader's own words ("A question you keep asking opened a room on Gravity"). **Predictions and their revision are not built.** |
| **I** — reset or leave | Pause → the line reads "Recording is paused since Sep 25, 2026". Resume. Export through the **real system picker** (215,842 bytes to Downloads, deleted afterwards). Clear (confirmed). Reset (confirmed). | Each step explained its consequence and asked for confirmation. Reset signed out with "Your personal history was reset". |

C (a generated series) waits for Cutroom (#9). F (Social) is deferred (#137).

## Frame timing (matched and interleaved)

`AtlasProfileTest`, run through `scripts/android-native-profile.py`: 12 cycles into and out of the authored Atlas's Orbits planet, with every frame phase recorded. All numbers are in `frame-profile-summary.json`.

- **Baseline.** `b77a971`, the first main with this scenario (#161 removed the live world view that the PR130 profile used).
- **After.** `dc0c5f9`: final main `bb86ad9` plus this PR's export and fixture fixes. The later reader fix does not touch the Atlas.
- **Order.** Baseline runs 1–4, then after/baseline interleaved on a quiet host.

| Median, interleaved runs | p50 | p95 | animation p95 | draw p95 | swap p95 | PSS |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline `b77a971` (runs 5–8) | 30.54 ms | 50.64 ms | 8.38 | 8.82 | 15.14 | 130,240 KiB |
| After (runs 1, 3, 4) | 30.42 ms | 50.86 ms | 8.99 | 9.33 | 14.59 | 130,185 KiB |

- **No regression from this session's work.** p95 is within 0.3 ms and p50 is 0.1 ms faster. Animation and draw are about 0.5 ms higher at p95.
- **The earlier baseline could not be re-run.** PR130's `81431cc` builds only the owner's `.journey` preview package, and its live world view no longer exists after #161. Its 47.40 ms came from a different host state; yesterday's series measured about 67 ms on both sides.
- **Smoothness is not accepted.** Nearly every frame is over 16.67 ms on this emulator.
- **Coverage gap.** The live Places system (rooms, demand lines) has no profile scenario yet.
- **Run failures.**
  - The first three after runs failed their build step on `PrivacyScreenTest`. Built as `.journeytest`, the export took a journey-only path; fixed in this PR.
  - After-run 2 failed on an `AccountViewModelTest` 5 s wait. In the same build, the Gradle daemon logged "Did not receive connection preamble within 10s": the host was starved. Recorded, not repaired by re-running.

## Startup, memory, ANR

- **Cold start** (`am start -W`, five runs): 2,414–2,521 ms, median 2,466 ms. Debug build on the emulator.
- **PSS.** 81 MB on the Universe screen after a cold start; 106 MB after the journeys above.
- **No ANR or crash** from `.journeytest` in this run (logcat and the system dropbox). An earlier startup ANR under host load (2026-09-24) is in #177.

## Text size, motion, accessibility

- **Labels and targets.** The audit (`uiautomator` dump) checks that every clickable node has a label and a 48 dp target. It ran on the Universe, the reader, the place sheet, the room sheet, the connection sheet, the Why sheet and the Passages sheet, at font scales 0.85, 1.0, 1.3 and 2.0. **0 unlabelled, 0 under 48 dp.**
- **Compact and large text.** 0.85, 1.3 and 2.0 were read on the key screens.
  - At 2.0× the reader's action bar wraps to two rows, and the reading window is small but scrolls.
  - **Found and fixed in this PR:** the way back along a followed connection was cut to "…" at 2.0×, and a long title was cut even at 1.0×. It now has its own line. `ReaderLargeTextTest` failed first.
- **Reduced motion.** With animator, transition and window scales at 0, the Atlas selection, the place sheet and the reader all work. The settings were restored afterwards.
- **TalkBack** was enabled. Focus lands on the first control ("‹ Universe") with its label.
  - A full traversal and gesture input could not be driven by `adb`. Swipes sent before TalkBack took over panned the map, which is expected behaviour.
  - The emulator's Accessibility Suite asked for notifications on first enable, and that was declined.
  - TalkBack was turned off, and every setting was restored.

## Also in this PR (found while running the matrix)

- **The export has no journey-only path.** Every build uses the system picker, and the owner journey (`OwnerAccountJourneyTest`) answers the picker with Espresso-Intents. The owner journey passed on the emulator.
- **Raw-HTTP test fixtures read a request body whole.** One read could stop at the first segment, and closing the socket then reset the connection ("Connection reset" in `RelicsTest`). The test reproduced exactly that before the fix.
- **Per-file databases (#188) retire the cross-file workarounds.** Test comments now say what is still true.

## Not proven here (physical-device and owner items)

- A physical phone: frame timing, startup, memory, video playback and TalkBack gestures (#136, owner's phone).
- Release signing with the owner's keystore, App Links verification on the owner's domain, and real mail delivery (#72, owner inputs).
- Usefulness: whether these journeys are good, and whether `composer-semantic-v4` should become the default (the owner's review).
- A MiniMax-written Scroll served through the inventory loop: the one live request (#164) was refused by the checks. The live continuation step (#166) was not triggered in three live runs; each first proposal was either admitted or refused for its shape. The third run (one request, ledger 73 → 74) is `live-inquiry-run.json`: statuses, counts and hashes only.
