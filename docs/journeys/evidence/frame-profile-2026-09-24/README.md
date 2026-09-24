# Matched Atlas frame profiles — 2026-09-24 (#136)

The handoff recorded PR130's matched profile as a regression: baseline `81431cc` p95 **47.40 ms**,
after **52.29–66.56 ms**. This pass re-measured it with the same test on both sides, now recording
every frame phase (`AtlasProfileTest`: input, animation/recomposition, layout, draw, sync, command
issue, swap, GPU, queue) and one row per frame.

## Method

- The profile runner's 12 world-entry/source/Back cycles (`scripts/android-native-profile.py`),
  on a disposable demo database. The owner's `.journey` preview was preserved and restored,
  verified after every run (`scripts/android_preview.py`).
- **Baseline:** `81431cc` (PR130's implementation before the direct-Atlas continuation), with this
  branch's `AtlasProfileTest`, runner and preview guard copied in. The test differs from the
  baseline's own only by the 17 lines that record the added phases, so both sides drive the same
  interactions. Its `source.json` is therefore `81431cc…-dirty`.
- **After:** this branch at `6cfbbad`, which is main `a9b5e1c` plus the profiling tooling.
- **Host:** the same API36 host-GPU emulator and nothing else running (no Gradle, tests or
  workers). Two baseline runs came first; then after/baseline were interleaved three times.
- Every number is in `summary.json`; per-frame rows stay in ignored `artifacts/`.

## Results

| | p50 | p95 | animation p95 | draw p95 | swap p95 | GPU p95 | queue p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (median of runs 2–5) | 33.83 | 67.61 | 10.07 | 10.77 | 11.67 | 21.20 | 26.11 |
| After (median of runs 3–5) | 29.53 | 67.35 | 19.66 | 13.61 | 15.39 | 23.52 | 24.17 |

All values are in ms. Baseline run 1 was an outlier (p95 44.15 ms, p50 25.89 ms); it is kept in
`summary.json` but not in the medians. On this host the baseline's p95 is about 67 ms, so the
recorded 47.40 ms is not reproducible today.

## What this says

- **The matched p95 regression does not reproduce.** Both sides sit at about 67 ms at p95, and the
  current code is faster at p50.
- **The current code does spend more per frame on recomposition and drawing.** At p95, animation
  (recomposition) takes about twice as long, draw about +3 ms and swap about +4 ms. The total
  stays level because the frames are dominated by GPU and queue time on the emulator. These phases
  are where the direct-Atlas continuation (the `LivingSky` canvas, `SpatialAtlas` state read
  during composition) adds work. They are the first thing to reduce.
- **Smoothness is not accepted.** In every run on both sides almost every frame is over 16.67 ms.
  The API36 emulator with host GPU cannot show 60 fps for this scene. The comparison is valid only
  as matched and relative; it is not physical-device proof.

## Next

1. Remove per-frame recomposition from the Atlas: read the animated values only inside draw and
   layout lambdas, keep `LivingSky`'s paint and paths allocation-free per frame, and check with the
   animation phase.
2. Repeat this matched pair after each change, interleaved and on a quiet host.
3. Profile a physical device when one is available, labelled separately.
