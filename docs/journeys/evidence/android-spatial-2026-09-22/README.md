# Android spatial / real-media verification — #72, PR #129

Branch delivery only. This successor preserves the previous audit and privacy migration. No Web,
shared contract, API, worker or migration implementation was changed in this phase. No owner data
was reset, owner schema migrated, live generation called, PR merged or issue closed.

## Evidence boundaries

The joined native run uses the real app, API, PostgreSQL exposure admission and media route, with
an authorized 1,811,581-byte MP4. Its SHA-256 is in `receipt.json`. A guarded fixture supplies
synthetic test-only generation/publication lineage in a fresh `knowscroll_test_native_*` database;
this proves playback and existing admission, **not Cutroom or source-aligned generation**.
The app displays TEST MEDIA. Raw video and images containing its frames remain in ignored local
`artifacts/android-spatial/native`, rather than being duplicated in Git.

`native-journey.json` records real frame rendering, actual pan/pinch, local world inspection,
source-sheet Back, background/authority refresh, discovery and the restored camera. A real feed
can exhaust. That outcome is recorded explicitly; starting a new local voyage exercises another
vertical discovery without inventing a branch or changing ranking. The related `media-faults.json`
uses real MP4 decoding over a deliberately faulty loopback server: 503/retry, delayed response,
connection refusal, replay, retained pause, refused redirect, rapid URL replacement and no further
requests after disposal. A rendered-frame callback is not a count of decoded video frames.

`rich-preview.json` is an authored **test preview**: native prose, an actual decoded supplied-video
frame through the test image-loader seam, readable image failure, citation, slider, scrolling
diagram, explicit unsupported executable block, long reading content and 20 branches. Embedded
input stays local, rail input branches, Back restores document state, and next discovery requires
an explicit action. It creates no API exposure and proves neither live rich transport nor an
executable-content sandbox. `atlas-stress.json` covers 100 long-titled illustrative markers,
font scale 1.45, pinch, rapid reversals, off-screen accessible selection and recenter with system
animation scale zero. This is programmatic accessibility verification, not manual TalkBack acceptance.

The separate `.journey` package and fresh disposable databases were used throughout. Existing
world and reader receipts include compact/reduced-motion navigation, recreation, privacy epoch
change, transport retry and revoked authority. All runners restore device display/font/motion
settings and stop their own API/worker processes before dropping their disposable database.

## Repeatable commands

From the SSD repository root, source `scripts/env.sh` first:

```sh
. ./scripts/env.sh
pnpm typecheck
# Existing world runner also runs assembleDebug, assembleDebugAndroidTest, lintDebug and units.
python3 scripts/android-ui-refinement.py
python3 scripts/android-reader-journey.py
KS_NATIVE_VIDEO='/path/to/authorized-video.mp4' python3 scripts/android-native-journey.py
python3 scripts/android-native-profile.py
```

Do not overlap runners: they install the same `.journey` package on the one emulator. The initial
baseline privacy run was invalidated by an overlapping install and was rerun serially. Neither
that crash nor failed profiling-harness attempts are counted as passing evidence. Native test
assumptions about first source and remaining supply were corrected to follow the real composer.

## Final verification

Frozen native source passed root `pnpm typecheck`, Android `assembleDebug`,
`assembleDebugAndroidTest`, `lintDebug`, and **86 unit tests (zero failures/errors/skips)**.
The serial run completed four new scenarios, three existing world scenarios and four existing
reader scenarios. The native receipt is dated 2026-09-22 15:59 UTC and the world receipt 16:00 UTC;
reader completion followed in the same serial command. The database recorded six exposures,
including exactly one Reel exposure. Both original and successor 12-cycle profile scenarios passed.

## Captures and inspection

- `before-system.png`: original PR head `c9f699f`, before native implementation.
- `after-universe.png`: full viewport with actual fixture-kept Traces and reachable privacy controls.
- `after-system.png`, `after-world.png`: transformed map and source-backed inspection.
- `after-compact-system.png`: compact/reduced-motion scenario.

The local HTML references were inspected as source plus existing captures. Browser security
policy blocked interactive local-file replay. No observed-motion equivalence is claimed.

## Performance method and limits

`AtlasProfileTest` runs the same 12 world-entry/Back cycles on original `c9f699f` and the successor,
using Android accessibility bounds and real pointer/Back injection. It uses real time, not Compose's
synthetic test animation clock. `Window.FrameMetrics` reports total/layout/draw/sync/GPU/queue
samples; PSS is read while the process is alive. Cold app startup is excluded. No metric reports
were intentionally discarded. A duration over 16.67ms is reported as a threshold count, **not** an
Android deadline-derived jank percentage or a gesture-latency measurement. Window metrics also
do not measure the separate SurfaceView video frame stream.

Conditions: debug API36 arm64 emulator, 1080×2400, font1.0, motion1.0, host GPU (Apple M4 OpenGL ES
translator). Baseline checkout is `/Volumes/Mrigesh SSD/knowscroll-worktrees/72-native-reel-player`;
only the profiling test/script and ignored development links were added there. Original production
source is unchanged. `profile-before-source.json` and `profile-after-source.json` fingerprint all
main sources/resources. The early automatic software-renderer runs are excluded.

| Same 12-cycle scenario | Original `c9f699f` | Native successor |
|---|---:|---:|
| Window samples | 522 | 578 |
| Total duration p50 | 17.88 ms | 23.24 ms |
| Total duration p95 | 64.34 ms | 83.95 ms |
| Maximum | 163.23 ms | 193.29 ms |
| Samples over 16.67 ms | 499 | 556 |
| Draw p95 | 8.75 ms | 20.59 ms |
| GPU p95 | 22.28 ms | 23.81 ms |
| Queue p95 | 12.77 ms | 34.77 ms |
| Live process PSS | 113,660 KiB | 126,570 KiB |
| Dropped metric reports | 0 | 0 |

The successor is slower in this matched diagnostic pair: p95 is about 30% higher and PSS about
11% higher. This is a recorded regression signal, not a smoothness pass. The new map adds animated
frames and more drawing; draw/queue timings warrant a controlled physical-device trace before
attributing cause or accepting performance. The test selects the same Orbits world on each
revision and clears accessibility caches before fresh node lookup. Failed/stale-node harness
attempts are excluded. Earlier exploratory successful runs used a different selector/harness and
are not mixed into this pair. Runs were sequential, with successor measured before original.

This is one sequential before/after run on a shared, memory-constrained host (about 9–10 GiB swap
in use and unrelated active processes). It is diagnostic evidence, not a controlled performance
claim. No physical phone was connected; release variants remain disabled pending production auth.
Recomposition was inspected in source (camera state updates, viewport culling, cached drawing
paths), not counted with a release runtime inspector. Physical gesture latency, thermal behavior,
manual TalkBack, sustained media memory and production smoothness remain unproved.

See the [Android audit and exact integration dependencies](../../../design/2026-09-22-android-spatial.md).
The whole requested journey is **not live end to end**: real native playback and source-world
return are joined; rich blocks and relationship-preserving branches remain controlled native
previews until the listed shared contracts exist. #72 and full v1 acceptance remain open.
