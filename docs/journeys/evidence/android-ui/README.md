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
  for encounters not yet known, not invented topics. A status pill carries the real `DAY n` age
  (computed from the earliest kept Trace's own timestamp — the universe itself has no `createdAt`
  in this client's API surface). A yellow left-ruled note carries the one real fact available (how
  many are kept) rather than a fabricated why-this-appeared reason (see Deviations). Zoom
  (`−`/`+`/`⊙ recenter`) is a real control over the real canvas via `graphicsLayer` scale. A
  legend distinguishes kept bodies from the unexplored region once there is something to
  distinguish. The CTA is a yellow pill with a helper line beneath it, exactly the reference's
  composition.
- **Scroll reader** (`ScrollScreen.kt`): an origin chip (cream pill, was plain text), a typographic
  stage panel (a Scroll is text, so no video — section 5b's own table) whose progress bar reflects
  real reading position, a `TruthPill` state pill carrying the real truth state plus the real
  source count (`DOCUMENTED · 1 SOURCE` — this client's `ScrollItem` always carries exactly one
  source), the title, summary, then "Keep this" (yellow) and "keep going →" (teal) action pills.
  "Not so fast" (coral) is not drawn — section 5b's own table: no contract exists for it.
- **Bottom compass** (`BottomCompass.kt`): a translucent, bordered, shadowed dock (Living
  Observatory's own `.dock` geometry) on **both** screens now, not just the universe — Home and
  Scroll, the current entry highlighted. Previously it only existed on the universe screen.
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

## Screenshots

`captures/` — this pass's own composables, JVM-rasterized (no emulator):
- [`universe-first-visit.png`](captures/universe-first-visit.png) — the honest empty universe.
- [`universe-with-kept-trace.png`](captures/universe-with-kept-trace.png) — one real kept Trace.
- [`scroll-reader.png`](captures/scroll-reader.png) — the reader with a sample `documented` Scroll.

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
3. **`DAY n` is approximated.** The universe itself has no `createdAt` in the API surface this
   client uses. Its age is computed from the earliest kept Trace's own timestamp instead — real
   data, but a proxy, not the universe's actual creation date. When nothing is kept yet, the pill
   is omitted rather than showing a fabricated `DAY 0`.
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

- **No emulator was used.** Every screenshot and every test in this pass ran on the JVM
  (Robolectric, native graphics mode). The five `scripts/android-*.py` journeys, which need a
  booted emulator and the real HTTP/PostgreSQL stack, were **not run** in this pass — this lane's
  `.env` is provider-free and no emulator/device was started or is left running. Their content
  descriptions were preserved by inspection (every one referenced by an instrumented test file was
  grepped and cross-checked against this pass's source) and by the 46 passing JVM tests, but the
  actual instrumented journeys are unverified by this pass.
- Real device TalkBack traversal, physical-device validation and owner visual/usefulness acceptance
  are unproved, as in every prior Android evidence round in this repository.
- The universe canvas's body text can still crowd or clip at extreme font scales or very small
  bodies counts beyond what was sampled here (checked: default phone size and the sample with one
  kept Trace; not checked at 840×1680/font scale 1.3, section 7's second phone size, or with many
  kept Traces).
- System, planet and interior levels are not built (see "What this pass did" — this is by design,
  not an oversight, per section 5b's own instruction not to draw levels with no data).
