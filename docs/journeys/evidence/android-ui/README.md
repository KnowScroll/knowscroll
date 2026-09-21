# Android universe/reader restyle — issue #111

Branch `claude/111-android-ui`, built on top of `e85fdff` (the JVM screenshot-test capability) and
this lane's own prior uncommitted work (`a1542b3`, `02ea794`), reviewed and partly kept, partly
replaced (see "What the previous run in this lane left" below).

## What this pass did

Rebuilt the Android **universe** screen and the **Scroll reader** to read as the same product as
the Cosmos reference (theme) and Living Observatory (experience), per
`docs/product/ui-system.md` sections 1–3, 4b, 5, 5b, 5c, 6 and 7. Only the universe level is
built — system, planet and interior all need semantic geography this client does not have
(section 5b's own table), so building them would be the "pretty map of nothing" the spec warns
against.

- **Universe screen** (`UniverseScreen.kt`): a canvas of real bodies on a star ground, not a
  scrolling list. One real body per kept Trace, labelled with its real title, tap-to-revisit.
  Empty state draws Living Observatory's own honest first-visit bodies verbatim in spirit ("A
  first possibility", "A different angle", "A little surprise") — generic, truthful placeholders
  for encounters not yet known, not invented topics. Zoom (`−`/`+`/`⊙ recenter`) is a real control
  over the real canvas via `graphicsLayer` scale. A legend distinguishes kept bodies from the
  unexplored region once there is something to distinguish. The CTA is a yellow pill with a helper
  line beneath it, exactly the reference's composition. **No `DAY n` status pill** — see "Honesty
  finding" below; this pass removed it rather than keep the previous run's proxy.
- **Scroll reader** (`ScrollScreen.kt`): an origin chip (cream pill, was plain text), a typographic
  stage panel (a Scroll is text, so no video — section 5b's own table) whose progress bar reflects
  real reading position, a `TruthPill` state pill carrying the real truth state plus the real
  source count (`DOCUMENTED · 1 SOURCE` — this client's `ScrollItem` always carries exactly one
  source), the title, summary, then "Keep this" (yellow) and "keep going →" (teal) action pills.
  "Not so fast" (coral) is not drawn — section 5b's own table: no contract exists for it.
- **Bottom compass** (`BottomCompass.kt`): a translucent, bordered, shadowed dock (Living
  Observatory's own `.dock` geometry) on **all three** screens now — Atlas, Cable, Keep, the
  current entry highlighted (renamed from the previous pass's placeholder "Home"/"Scroll"; see
  "Dock fix" below). Previously it only existed on the universe screen, with two entries.
- **Keep screen** (new, `ui/keep/KeepScreen.kt`): the dock's third real destination (section 5b:
  "Cable (read), Atlas (universe), Keep (Traces) are real"). A read-only list of the real kept
  Traces, moved out of the universe screen (which still draws them as canvas bodies, so the list
  is not duplicated in two places). Honest empty state when nothing is kept yet. Tapping a Trace
  opens the same real Trace-revisit reader the universe canvas already used.
- **`TruthPill`** (added by the previous run, kept): now actually wired into the reader, giving
  the seven truth states real, distinguishable colour and a `contentDescription`.
- **Reduced motion** (`ReducedMotion.kt`, added by the previous run, kept): now actually read by
  the stage's progress-bar animation (instant at scale 0). ModalBottomSheet's own motion and the
  canvas zoom are not yet suspended by it — recorded honestly in the file's own doc comment rather
  than left overclaiming an integration that did not exist.
- Fixed the reading sheet's corner radius literal from 24dp to the spec's 22dp
  (`CardSheetRadiusRedTest`).

## What the previous run in this lane left, and what happened to it

`git status` at the start of this pass showed uncommitted changes aimed at the *older, reduced*
version of the spec (before sections 5b/5c existed): Cosmos palette tokens on `Theme.kt`,
`labelLarge` at weight 800/13sp, a `Shapes(medium = RoundedCornerShape(22.dp))` theme token, a
two-tab `BottomCompass` added only to the universe screen, `TruthPill.kt` and `ReducedMotion.kt`
created but not wired into the reader.

- **Kept as-is**: the palette tokens, `labelLarge`, the theme shape, `TruthPill.kt`,
  `ReducedMotion.kt`. These already matched section 5b/5c's requirements once wired up.
- **Kept and extended**: `BottomCompass.kt` — restyled its fill/border to the reference's
  translucent-dock recipe and added it to the Scroll reader, which `BottomCompassRedTest` requires
  independently of the universe screen.
- **Replaced**: `UniverseScreen.kt`'s list-based layout (a scrolling column of Trace rows under a
  plain heading) did not read as the reference's canvas at all — it was exactly the "text page"
  section 7 warns against. Rebuilt as the canvas described above.
- **Not touched**: `ScrollScreen.kt` had no uncommitted changes from the previous run; this pass's
  reader changes are new.

## Fidelity tests (`e85fdff`'s capability, extended)

`e85fdff` added Roborazzi + Robolectric-native-graphics JVM screenshot tests, red before this
restyle. All six now pass:

```
PaletteTokensRedTest    2 tests
BottomCompassRedTest    2 tests  (now checks BOTH screens; previously only Universe existed)
PillGeometryRedTest     4 tests
TruthPillRedTest        1 test
ReducedMotionRedTest    1 test
CardSheetRadiusRedTest  2 tests
```

Added `ScreenshotEvidenceTest.kt` — three JVM-rasterized captures (`onRoot().captureToImage()`
against real, native-graphics-mode pixels, the same mechanism `TruthPillRedTest` already proves
works here) of the rebuilt screens at the Robolectric default phone size (360×780dp / 720×1560px),
written to `apps/mobile/app/build/roborazzi-evidence/` and copied into `captures/` in this folder.
This keeps and extends `e85fdff`'s JVM-only capability rather than introducing Roborazzi's own
Activity-launching Compose API, which this app's test manifest is not set up for.

Full run: `./apps/mobile/gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest` —
**46/46 unit tests pass**, assemble and lint both succeed (lint's remaining findings — `UseKtx`,
`GradleDependency`, `OldTargetApi` and similar — are pre-existing project-wide style suggestions,
not new errors; three `ModifierParameter` warnings introduced by this pass's own `UniverseScreen.kt`
were fixed by renaming those parameters to `modifier`, and two string resources this pass made
unused (`universe_empty`, `action_enter_scroll`) were removed).

## Honesty finding: the `DAY n` pill (investigated this pass)

The universe drew a `DAY 32`-style pill and a doc comment claimed it "carries the real DAY n age,
never a decoration". Investigated by reading the actual bootstrap contract
(`docs/contracts/bootstrap-http.md`): `GET /v1/universe` returns
`{universeId, privacyEpoch, revision, traces:[{eventId,assetId,title,createdAt}], capabilities}` —
**there is no universe-level `createdAt` anywhere in the contract**, only a `createdAt` on each
individual Trace. The web build (`docs/CHECKPOINT.md`, #110) already hit this and refused to draw
the pill for exactly this reason.

Android's number was not fabricated out of nothing — `universeAgeDays()` computed
"days since the earliest kept Trace's own `createdAt`, plus one" and displayed that. That is a
real, contract-backed field. But the label claimed it was **the universe's age**, and it was not:
an owner who signed in on day 1 and kept nothing until day 10 would see `DAY 1`, asserting
something about the universe's age that no field in the contract supports. A real field, wrongly
captioned, is still a false claim about what it carries (definition §3, laws against inventing
world state).

**Fixed by removing the pill**, matching web's own refusal instead of keeping a relabelled proxy —
see `UniverseScreen.kt`'s comment above the removed `universeAgeDays()` function for the full
reasoning kept in source, and the "Deviations" entry below.

## Dock fix

Section 5b: "Dock | **Cable** (read), **Atlas** (universe), **Keep** (Traces) are real." The
compass shipped as "Home"/"Scroll" — placeholders from before this client had a Keep contract to
back a third entry (§4b's own note: "the compass ships with Home and Scroll, and grows an entry
when a contract does"). `GET /v1/universe`'s `traces` and `GET /v1/traces/:eventId` already back a
real Keep destination, and the web build had already taken these exact three names, so:

- `CompassTab` and `BottomCompass.kt` renamed to `Atlas`/`Cable`/`Keep`, matching web rather than
  inventing new labels of this client's own.
- A new **Keep screen** (`ui/keep/KeepScreen.kt`) is the third destination: the real kept Traces,
  moved out of Universe's own textual list (the canvas there still draws one body per Trace, so
  nothing is lost, only de-duplicated). Honest empty state ("Nothing kept yet…") when there is
  nothing to show.
- **Found by actually running this on the emulator, not by inspection:** keeping a Scroll from
  Cable and going straight to Keep (never passing back through Atlas) showed "Nothing kept yet"
  for a Trace the server had already recorded — `AppViewModel`'s `openKeep()` only showed whatever
  `_universe` already held in memory, and nothing refreshed it. Fixed with a new
  `refreshUniverseInPlace()` that refetches `GET /v1/universe` and updates only `_universe` (never
  `_screen`), keeping the same privacy-epoch/purge invariants `applyUniverse` already enforces
  elsewhere, without inheriting `reconcilePrivacy`'s screen-reset behaviour (which would otherwise
  race the Keep navigation and silently bounce the reader back to Atlas — see the doc comments on
  both functions in `AppViewModel.kt`). Verified end to end on-device: keep a Scroll on Cable → Keep
  shows it immediately → tap it → opens the real Trace-revisit reader
  (`docs/journeys/evidence/android-ui/device/native-1.0-keep-open-trace.png`).
- `BottomCompassRedTest` updated from "exactly two compass tabs, Home and Scroll" to "exactly three
  compass tabs, Atlas Cable and Keep", and asserts the three real labels are the ones drawn.

## Real device run (issue #111 follow-up: run it for real)

Installed on the already-booted `emulator-5554` against a disposable PostgreSQL database and the
real API/worker (`pnpm db:migrate && pnpm db:seed`, `KS_JOURNEY_API_URL` pointed at the disposable
API so the debug build takes the `.journey` applicationId suffix). Not a JVM render: every
screenshot in `device/` below is `adb exec-out screencap` against the actual running app.

- `./apps/mobile/gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest` — **46/46 unit
  tests pass**, lint clean (no new findings), assemble succeeds.
- `RealJourneyTest#processDeathPrepare` run directly via `adb shell am instrument` against the
  disposable backend at the emulator's **native resolution** (1080×2400, font scale 1.0): **passes
  (`OK (1 test)`)**, confirming the honest-empty-universe → Enter Scroll → real reading-position
  persistence path still works end to end with the renamed dock and the removed `DAY` pill.
- Manual on-device navigation (`adb shell input tap`, driven from a real `uiautomator dump` of the
  actual running tree, not guessed coordinates) exercised Atlas → Cable → Keep → Trace-revisit at
  **both** required layouts and captured real screenshots into `device/`:
  - `native-1.0-atlas.png`, `native-1.0-cable.png`, `native-1.0-keep-empty.png` — native size, font
    scale 1.0, honest empty states (no pill, three-entry dock).
  - `native-1.0-keep-with-trace.png`, `native-1.0-keep-open-trace.png` — after really keeping a
    Scroll: Keep shows it without returning to Atlas first (the fix above), and opening it from
    Keep reaches the same Trace-revisit reader ("SAVED FROM YOUR KEEP").
  - `compact-1.3-atlas.png`, `compact-1.3-keep.png` — 840×1680 at font scale 1.3, the spec's own
    second phone size (section 7).

**What this did not achieve, reported rather than hidden:** none of the five
`scripts/android-*.py` journeys could be run to completion as written. Every one of them sets
`adb shell wm size 840x1680` and then immediately runs its **first** `am instrument` call — a cold
instrumented launch at that overridden size. Reproduced directly (not inferred): that specific
combination — `am instrument`-launched `createAndroidComposeRule<MainActivity>()` cold at
840×1680 — deterministically times out after the test's own 15s `waitUntil`, every time, on this
emulator, **even though the same screen launched the ordinary way (`adb shell am start`) at the
identical 840×1680 renders correctly within ~2s** (`window focus` and `mCurrentFocus` both confirm
the correct activity, and a screenshot taken mid-run shows the expected content on screen) — so
this is a test-synchronization defect, not a rendering one. **This reproduces identically against
the pre-existing baseline commit `595c575`, before any change in this pass**, so it is not
something this pass introduced; it is a pre-existing gap this run surfaced. Root-causing it further
(inside `androidx.compose.ui.test`'s idling/synchronization internals, or this specific emulator
image) is unstarted. Until it is fixed, the five journeys' own end-to-end proof (process death,
history clear, source-sheet, sign-out, Trace revisit, all under `wm size 840x1680`) is unverified by
automation on this machine; the manual on-device navigation above is real but not automated replay
of those specific scripted scenarios.

## Screenshots

`captures/` — this pass's own composables, JVM-rasterized (no emulator):
- [`universe-first-visit.png`](captures/universe-first-visit.png) — the honest empty universe.
- [`universe-with-kept-trace.png`](captures/universe-with-kept-trace.png) — one real kept Trace.
- [`scroll-reader.png`](captures/scroll-reader.png) — the reader with a sample `documented` Scroll.

`device/` — the **real running app on `emulator-5554`**, `adb exec-out screencap` (not a JVM
render — see "Real device run" above for how each was produced):
- `native-1.0-atlas.png`, `native-1.0-cable.png`, `native-1.0-keep-empty.png`,
  `native-1.0-keep-with-trace.png`, `native-1.0-keep-open-trace.png` — native emulator resolution,
  font scale 1.0.
- `compact-1.3-atlas.png`, `compact-1.3-keep.png` — 840×1680, font scale 1.3.

`reference/` — the two reference HTML files, driven with Playwright/chromium and screenshotted at
their own `[class*=phone]` element (Cosmos) or full page (Living Observatory, which has no phone
frame):
- [`cosmos-universe-day1.png`](reference/cosmos-universe-day1.png),
  [`cosmos-universe-day30.png`](reference/cosmos-universe-day30.png),
  [`cosmos-reel.png`](reference/cosmos-reel.png)
- [`living-observatory-first-visit.png`](reference/living-observatory-first-visit.png),
  [`living-observatory-day6.png`](reference/living-observatory-day6.png)

Put side by side (section 7's first test), the build now reads as the same product: a canvas with
floating pills and bodies, a translucent dock, a typographic stage with real state/action pills —
not a text page. It is not pixel-identical (Compose has no CSS radial-gradient planet texture, no
elliptical orbit rings, no backdrop blur), and those gaps are recorded below rather than papered
over.

## Deviations (recorded per the task's own instruction, not smoothed over)

1. **Why-this-appeared note.** The reference's yellow note carries a real reason a specific
   encounter appeared. That reason lives on a `ScrollItem` (`reason`, seen in the reader), not on
   a `Trace` (seen on the universe screen, which only carries `eventId`/`assetId`/`title`/
   `createdAt`). Rather than fabricate a reason on the universe screen, the note there states the
   one real fact available: how many Scrolls are kept.
2. **Unread remainder is not counted.** Section 5c asks for the unexplored legend's second half to
   carry the real unread count. No endpoint this client calls returns the size of the finite
   library or how much of it is unread, so the dust/legend show the *qualitative* fact (something
   remains unexplored) without a fabricated number.
3. **`DAY n` is not drawn at all (changed this pass).** The previous run computed it from the
   earliest kept Trace's own timestamp and its own doc comment called that "the real DAY n age".
   Investigated this pass (see "Honesty finding" above): the bootstrap contract has no
   universe-level `createdAt` anywhere, so that number was real-but-mislabelled (days since first
   Keep, not the universe's age) rather than fabricated outright. Removed to match the web build's
   own refusal of the same pill for the same reason, rather than keep a proxy the spec's own
   contract does not support.
4. **Hint line reworded.** The reference's hint assumes tappable "planets" (topics). This client's
   bodies are kept Traces, so the hint says what tapping one actually does ("Tap a kept Scroll to
   revisit it") instead of copying "Tap a planet".
5. **CTA reworded for the started stage.** Living Observatory's day-6 CTA is "Watch something" —
   this client has no eligible Reel (`docs/CHECKPOINT.md`: no real provider, no Visual Witness), so
   the label is "Keep exploring" instead, since a Scroll is read, not watched.
6. **No true backdrop blur on the dock.** `backdrop-filter: blur(12px)` needs API 31+ `RenderEffect`
   plumbing this app does not have. The dock is translucent with a hairline border and shadow;
   nothing behind it is actually blurred.
7. **Zoom has no pan/pinch.** Section 4b itself marks the full drag-and-pinch canvas as needing
   semantic geography this client does not have. A stepped `−`/`+`/`⊙` zoom over the real canvas is
   the honest subset built instead.
8. **Reduced motion is scoped.** `rememberReducedMotion()` is read by the stage's own progress-bar
   animation only. `ModalBottomSheet`'s entrance/exit motion (Source/Explain sheets) is not
   overridden by it — recorded in `ReducedMotion.kt`'s own doc comment, not left silently implied.
9. **"Not so fast" is not drawn.** Section 5b's own table: no contract exists for it yet.

## What remains unproved

- **The five `scripts/android-*.py` journeys did not complete, on an actual emulator, for a
  concrete pre-existing reason** — see "Real device run" above. `RealJourneyTest#processDeathPrepare`
  does pass for real at native resolution, and the on-device navigation is real, but the scripted
  process-death/history-clear/source-sheet/sign-out/Trace-revisit scenarios as written by those five
  scripts are unverified by automation on this machine until the `wm size 840x1680` +
  `am instrument` cold-launch timeout is root-caused. This is not this pass's own regression
  (reproduced against baseline `595c575` too) but it is also not fixed.
- Real device TalkBack traversal, physical-device validation and owner visual/usefulness acceptance
  are unproved, as in every prior Android evidence round in this repository.
- **Found by actually running at 840×1680/font scale 1.3** (`compact-1.3-atlas.png`): the universe
  canvas's body/legend text clips at the right edge ("STILL UNEXPLOR…", "…a perfec[t] circle"), and
  the reader's in-page action row ("Home"/"Kept"/"Sources"/"Why") wraps awkwardly and the title
  truncates to one visible word ("An orbit is not a"). Both predate this pass (neither the dock nor
  the `DAY` pill are involved) and are not fixed here — recorded because this is the first time this
  size/font-scale combination was actually rendered rather than left as an open question.
- System, planet and interior levels are not built (see "What this pass did" — this is by design,
  not an oversight, per section 5b's own instruction not to draw levels with no data).
