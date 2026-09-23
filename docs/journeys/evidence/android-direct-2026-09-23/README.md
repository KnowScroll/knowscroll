# Direct Android Atlas verification — September 23

Continuation of PR130's `81431cc`; #72 stays open. Android only, on the same API36
emulator-5554 with host GPU, 4096 MiB and four cores. The actual owner database
`knowscroll` was inspected read-only (nine migrations), never migrated or reset.
All scenarios use `com.knowscroll.mobile.journey` and disposable databases.

## What changed

A compact Universe system target leads into an uncluttered orbital scene. Planet
selection flies the ship and isolates the selected globe/moon. Tap or a continuous
two-pointer spread enters the matching coastline; direct region/topic taps open a
small context card and rich Scroll or actual supplied MP4. Return restores the
selected topic and camera. The complete semantic graph is explicitly authored,
versioned and preview-only. Source worlds retain honest secondary inspection;
they do not borrow unrelated feed items as topic content.

All six owner reference PNGs and the four original spatial PNGs were inspected.
Cosmos and Living Atlas HTML sources were read; their denied browser replay was
not bypassed. Screenshots and native recordings below are actual Android evidence.

## Checks

Final results are recorded in `checks.json` and the per-scenario receipts. Commands
were run serially after sourcing `scripts/env.sh`; generated caches/logs/media stay
on the SSD. Raw supplied videos and their frames are ignored and not published.

- `python3 scripts/android-ui-refinement.py`: source-world regular, compact/large
  text/reduced motion, and history-Clear privacy checks; assemble/lint/units.
- `KS_NATIVE_PORT=4323 python3 scripts/android-native-journey.py`: native navigation,
  rich authored content/branches, actual Media3 failure recovery, dense-world input.
- `python3 scripts/android-reader-journey.py`: existing reader/large-text/authority
  and gesture regressions.
- `KS_NATIVE_PORT=4323 python3 scripts/android-living-preview.py --scenario CLASS`:
  existing Cable regular/compact, preview authority, live source atlas and sky-clock;
  new direct full route, compact/large text, reduced motion and supplied-media route.
- `--scenario DirectAtlasMotionTest --record`: wall-clock Android MotionEvent route
  with visible arrival and topic-to-Scroll return, without a Compose test clock.
- `python3 scripts/android-native-profile.py`: unchanged wall-clock 12-cycle
  world-entry/Back measurement on before and after code, plus assemble/lint/units.

The direct route checks exact origin after content and recreation, branch/reading
return, real two-pointer input continuing past a level boundary, immediate Back and
retargeting. The Reel route checks Playing, paused resume, exact topic return,
reopening the paused player, then Clear while backgrounded and rejection of old
state after recreation. SQL checks assert zero preview exposures and Keeps.
Existing Cable checks assert exactly its two visible exposures, one of them a Reel.

Initial failures are retained in ignored diagnostics: host Gradle C1/JDK17 crash
before baseline instrumentation; rapid-Back navigation race; missing restored
Saved Traces list; covered-map duplicate semantics; stale Recenter test expectation; over-aggressive landmark culling; a test-only
TouchInjectionScope property compilation error; a later Robolectric/Espresso
idling timeout in the Saved Traces sheet test (reported separately from native ANRs).
Each was corrected or rerun and is distinguished from successful receipts.

## Performance and ANR boundary

`baseline-atlas-profile.json` is an untouched archive of `81431cc` measured on the
same recovered emulator configuration: p50 26.30 ms, p95 47.40 ms, max 84.07 ms,
PSS 129,497 KiB; 437 measured frames, no dropped metric reports. The archive's
tracked source hash is recorded separately. This supersedes cross-configuration
comparisons to the older September22 ~67 ms runs.

The first after profile measures p50 **29.76 ms**, p95 **52.29 ms**,
max **115.03 ms**, and PSS **125,534 KiB**: p95 is 10.3% slower and median
13.2% slower than baseline. A preceding pass measured 71.17 ms p95 before removing
a composition-time camera read from station visibility. This is an observed sequence,
not proof that the small change alone caused the tail improvement. Exact files and
comparison are recorded separately. The final repeat is **30.94 ms p50 / 66.56 ms
p95**, max 101.67 ms and PSS 126,277 KiB. Both after runs regress against the matched
baseline; the repeat is 40.4% slower at p95. Smoothness remains unaccepted. These are debug-emulator
measurements, not physical-device or smoothness acceptance. No ANR during this
run would establish only this observed interval; it does not explain or erase the
owner's September23 ANR or prove all Media3 startup paths are fixed.

## Review and evidence boundaries

Two bounded read-only `pio` reviews used actual MiniMax-M3 workers. Their exit
statuses, exact usage and dispositions are in `reference-review.json` and
`correctness-review.json`. Findings were verified against source; these are not
independent user-journey acceptance. Returning-home ownership, continuous pinch
ownership and inspection pointer interception were corrected. Reopening a topic
intentionally resumes its prior content/branch state; the exact mapped revision is
its initial entry. The ship stays parked in orbital space while the globe/ship
crossfade into the local surface map and return together on Back.

Android two-pointer injection and focus-preserving camera math are verified.
The documented macOS emulator method is **hold Command, then primary-button drag**;
toolbar magnification is separate. The computer-use tool did not expose the emulator
or a modifier-held drag operation, so that desktop input bridge was not manually
verified. Native trackpad pinch is not assumed to reach Android.

No new live semantic relation, inferred mastery, social presence, generated media,
provider run, full-v1 acceptance, physical-device performance or #72 closure is
claimed. The existing preview database and API4322 are preserved for handoff.

## Visual review and owner route

[Before system](../android-living-2026-09-22/living-system.png) and
[before sheet](../android-living-2026-09-22/compact-world-source.png) are preserved
historical captures. [Native motion](native-motion.mp4) is a 14.02-second extract of
the wall-clock recording (source trim 5–18.8 seconds with timestamps rebased; no speed change), covering ship approach,
moon movement, direct map/topic/Scroll and return. Chrome before/after the test is
trimmed out. It contains only authored public-source content, no supplied video frames.
The run's source hash is in the DirectAtlasMotionTest receipt; final globe-rim hit-area
coverage was added afterward and rerun separately. Current authored-route captures:
[Universe](direct-universe.png), [system](direct-system.png),
[planet/ship/moon](direct-planet.png), [continents](direct-continents.png),
[local topics](direct-region.png), [compact card](compact-topic.png), [context card](direct-topic.png),
[preserved Scroll](direct-scroll.png), [exact topic return](direct-return.png).
The authored three-planet system is labelled; it is not a fabricated live source system.

On the preserved journey app: **Universe → Authored Atlas → Orbit laboratory →
Orbits → tap the globe → North coast → a topic → Open**. Back returns to the same
card, then through region/continent/planet/system. **Supplied demos** takes the
same route into the existing three playable test videos. **Cable** remains the
actual filtered feed; **Info** is secondary source inspection on source worlds.


Restoration succeeded with the original session/epoch and two kept Traces. The
preserved preview initially resumed its saved Scroll, so the additional owner check
used its actual Atlas navigation before traversing the complete authored route.
That extra wall-clock route passed on API4322 with the final APK; the app was left
open on Universe. `owner-restored.json` records the exact APK/source hash. Read-only
final database check: owner nine migrations, preserved disposable preview22; two
Traces. `final-last-anr.txt` reports no ANR since the recovered emulator boot.
The prior failed owner-route attempt expected a fresh Universe instead of the
preserved reader; it did not report an app crash or ANR.
