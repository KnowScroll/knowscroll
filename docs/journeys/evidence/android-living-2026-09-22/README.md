# Android living universe / Cable evidence — 2026-09-22

Implementation: `9e38146` plus `38bf753` / `cd00057` / `518c0c3` fixes, based on merged PR129 `91e5b72`. Android-only; #72 remains
open. [Architecture and visual audit](../../../design/2026-09-22-android-living-universe.md).
Receipts below distinguish final-source functional tests from diagnostic profiles
and supplied-media playback. No provider, owner database or production deployment.

## Reproduce

Source `scripts/env.sh` in the SSD worktree. Run Android commands serially: one
API36 emulator and one `.journey` package are shared. The original owner preview on
4320 is preserved; set `KS_NATIVE_PORT=4322` for the legacy native runner. Set
`KS_NATIVE_VIDEO`, `KS_NATIVE_VIDEO2`, `KS_NATIVE_VIDEO3` to the three authorized MP4s
in the owner's `Google-Drive/Apply product demos/` directory. Never commit them.

```sh
source scripts/env.sh
pnpm typecheck
python3 scripts/android-ui-refinement.py
python3 scripts/android-reader-journey.py
KS_NATIVE_PORT=4322 python3 scripts/android-native-journey.py
python3 scripts/android-living-preview.py
python3 scripts/android-living-preview.py --compact
python3 scripts/android-living-preview.py --scenario PreviewAuthorityJourneyTest
python3 scripts/android-living-preview.py --scenario LivingAtlasJourneyTest --record
adb shell am instrument -w -e class com.knowscroll.mobile.SkyClockLifecycleTest com.knowscroll.mobile.journey.test/androidx.test.runner.AndroidJUnitRunner
python3 scripts/android-native-profile.py
python3 scripts/android-living-preview.py --keep
```

The world/reader/profile runners include `:app:assembleDebug`, `assembleDebugAndroidTest`,
`lintDebug`, `testDebugUnitTest`. Journey runners create/drop guarded disposable DBs,
launch real API/worker processes, and install only `.journey`. `--keep` leaves its
own runtime and recorded database alive after actual visible exposure/Keep setup.
Fixture SQL labels synthetic publication lineage; actual MP4 bytes prove playback.

## Completed checks

[Exact check receipt](checks.json) records source boundaries, log paths, counts,
retained preview lifecycle and the validated 30.64-second native H.264 recording.

| Check | Final result |
| --- | --- |
| TypeScript typecheck | Pass |
| Android debug + instrumentation assemble, lint | Pass |
| Android units | 92 passed; 0 failures, errors or skipped |
| Existing worlds / readers / native scenarios | 3 / 4 / 4 passed |
| Cable / privacy / hierarchy / motion lifecycle | 1 each passed |
| Compact Cable at 840×1680, font scale 1.35 | 1 passed |
| Total emulator scenario/configuration runs | 16 passed |
| Visible owner preview exposure/Keep setup | 1 additional test passed |

Functional runs after the compact fix use `cd00057`; the final atlas rerun and
retained owner preview use `518c0c3`, whose only change is the fixture socket
preflight correction. The earlier lifecycle test's clock implementation is unchanged.
The preview is restored to 1080×2400/font1 and both APIs report healthy. Backend CI
results belong to the final PR head and are reported there, separately from these
local Android receipts.

## Emulator profiling boundary

A fresh baseline was measured from the merged-equivalent pre-squash source, before
editing, using the same 12-cycle world-entry/Back accessibility runner. Host GPU,
API36 arm64 debug app, 1080×2400, font1, motion1. Wall-clock `FrameMetrics` include
draw/GPU/queue; this is not a Compose virtual-clock benchmark. Source hashes are
retained beside every receipt. Run1/run2 precede final content-only restoration and
formatting fixes; their spatial renderer is the delivered renderer. The final spatial run is at
`38bf753`; subsequent `cd00057` changes compact Reel layout, the preview label,
empty-Universe note placement and evidence export. The measured system renderer
and 12-cycle interaction are unchanged. These revisions are not hidden.

| Measurement | Fresh baseline | Living run 1 | Living run 2 | Final spatial run |
| --- | ---: | ---: | ---: | ---: |
| Total p50 (ms) | 27.48 | 34.04 | 34.05 | 34.14 |
| Total p95 (ms) | 67.81 | 67.37 | 67.45 | 71.34 |
| Draw p95 (ms) | 18.22 | 10.66 | 11.34 | 12.59 |
| GPU p95 (ms) | 25.33 | 22.16 | 21.88 | 21.16 |
| Queue p95 (ms) | 29.19 | 25.65 | 25.82 | 28.95 |
| PSS (KiB) | 131,278 | 129,338 | 131,685 | 129,164 |
| Metric reports dropped | 0 | 0 | 0 | 0 |

Cached globe paths/brushes/labels, draw-phase motion, culling, a bounded clock and
stopping hidden drawing reduce draw cost. Total tail latency ranges from flat to worse,
median is worse, and memory improvement is not established. Most frames still
exceed 16.67 ms. **Not smoothness acceptance.** The historical 64.34→83.95 ms
regression remains in the prior evidence; it is not substituted for this fresh
baseline. The owner confirmed no physical phone yet. Next performance gate is a
profileable/release-capable build on a physical device, including UI-thread and
RenderThread/queue traces; release auth remains separately gated.

## Review and failure history

[Review receipt](review.json) records exact MiniMax-M3 tokens/cost and coordinator
finding dispositions. The isolated implementation worker and its single retry both
stalled with exit124; neither draft was integrated. Final integration and runtime
fixes were performed by the coordinator. No quota warning/block was bypassed.

Earlier red runs were retained locally, not counted as passing: unsupported
Robolectric API36 setup (changed to supported34); inaccessible/duplicate canvas
labels (native semantics corrected); wrong active mode pointer; a test targeting
the wrong gesture node; a fixture title assumption; camera loss during authority
revalidation; image-placeholder clamping on branch return; a non-Unit JUnit test declaration;
a compact Reel with zero viewport height; and adb exec-out treating missing-file
text as a successful export; and a closed fixture socket in TIME_WAIT falsely
reported as a live port collision (preflight now uses SO_REUSEADDR). The final exporter validates PNG/JSON and isolates
scenario directories; the final motion recording was regenerated and validated with ffprobe. Each real product
failure received a source fix and a rerun. A passing build alone is not the journey.

## Owner route and evidence limits

The final preview receipt is ignored at `artifacts/android-living/preview/runtime.json`.
Open `.journey` → system view → watch the moon → pan/pinch → Worlds → choose a source
world → Explore continents → Regions → North coast → Back through the saved origin.
Open Station for the honest illustrative landmark sheet. Cable → Scroll/Reel tabs
uses the real filtered feed. Open **Authored preview →** for three rich
Scrolls and three supplied videos. Reel: swipe up/down or use Next/Previous; swipe
left/right or use named branches; Back returns to origin. Scroll: read/drag embedded
blocks, branch using the yellow rail, Back restores position, reach the deliberate
Next action at the end. Sources pause playback.

Committed captures contain authored diagrams and disposable source worlds only.
Raw media, personal video frames and API logs remain ignored on SSD. The local
motion recording is a native hierarchy-test capture; no reference-motion equivalence
is claimed. Screenshots and automated semantics are not owner visual acceptance,
manual TalkBack acceptance, live branching/rich transport, semantic world emergence,
Cutroom generation, real social presence or full-v1 completion.


## Comparison captures

Different disposable fixtures are labelled; these are composition comparisons, not
pixel-diff equivalence. Personal Reel frames are deliberately not included in Git.

| Surface | Capture |
| --- | --- |
| Merged spatial implementation before this pass | [Previous system](../android-spatial-2026-09-22/after-system.png) |
| Retained owner preview after visible Keep setup | [Universe](owner-universe.png) |
| Native orbital composition | [System](living-system.png) |
| Replacement for the rejected grey selector | [Worlds sheet](living-worlds.png) |
| Honest station landmark | [Station sheet](living-station.png) |
| Different native levels of detail | [Continents](living-continents.png), [local detail](living-local.png) |
| Poster content and interactive return | [Scroll top](living-scroll-top.png), [retained reading position](living-scroll.png) |
| Content collection | [Keep](keep.png) |
| Compact, larger text source access | [World source above dock](compact-world-source.png) |

Native H.264 motion: ignored `artifacts/android-living/verification/LivingAtlasJourneyTest/living-motion.mp4`.
The earlier recording was decoded and sampled at system/geography phases as an
additional check; the final exported recording is validated separately. Raw supplied
Reel frames remain only in the matching ignored `LivingCableJourneyTest` directories.
