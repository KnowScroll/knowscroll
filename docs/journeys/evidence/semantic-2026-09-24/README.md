# Semantic substrate and live continuations — evidence, 2026-09-24

Issue [#131](https://github.com/KnowScroll/knowscroll/issues/131) (with the first #133/#134 thread), parent #72.
Decision: [ADR-0031](../../../decisions/0031-semantic-substrate-and-validated-bridges.md).
Implementation revision for the Android journey below: `5dd71a5` (receipt `source`).

## Outcome

A reader reaches a sourced Scroll through ordinary discovery. They see a continuation drawn from an
**admitted, source-backed bridge**, inspect why it connects (mechanism, where it stops, cited
evidence), follow it, and return with Back to exactly where they were. They can also hide a
connection that seems wrong to them, without retracting the shared knowledge. A plausible but
unsupported connection is refused and never offered.

## Evidence levels

| Level | What ran | Result |
|---|---|---|
| Source verification | `scripts/substrate/verify-substrate.ts --require-snapshots` against hashed snapshots of 9 public pages (NASA, NOAA, OpenStax), retrieved 2026-09-24 | 70/70 quotes are exact passages; 9/9 hashes match ([substrate-verification.json](substrate-verification.json)) |
| Pure validator | `tests/semantic-bridge-validator.test.ts` | 13/13 pass. Mutation checks: disabling the mechanism rule turns 4 tests red; disabling the direction rule turns 1 red |
| Real PostgreSQL / HTTP | `tests/semantic-substrate.test.ts`, `semantic-editorial.test.ts`, `semantic-migration.test.ts` | 13 + 4 + 1 pass. Real editorial seed: 6/6 bridges admitted, 4/4 tempting bridges refused. Populated 0025→0026 upgrade preserves every prior row and checksum. Mutation checks: removing the semantic erasure or the suppression filter turns 3 tests red |
| Android units | `./gradlew :app:testDebugUnitTest` | 100/100 (new: `BranchesTest` 5, `ReadingRestoreTest` 1 — red before its fix: expected 4079, was 3929) |
| Real emulator journey | `scripts/android-semantic-journey.py` → `SemanticBranchJourneyTest` on emulator-5554 (API36), separate `.journey` app, disposable API/worker/PostgreSQL on 4333 | `OK (1 test)`; DB lineage below |
| Live provider | none | No model or provider call. Every bridge is editorial, decided by the deterministic validator |

## Real journey

[receipt.json](receipt.json), [instrumentation.txt](instrumentation.txt):

1. The reader enters the Cable. The first Scroll ("An orbit is not a perfect circle") offers
   **"Is explained by Gravity"**, traveling the admitted `physics.gravity explains astro.orbit`
   bridge in reverse. ([semantic-connections.png](semantic-connections.png) shows the mechanism,
   where it stops, and the evidence with its source.)
2. The reader follows it and lands on "One force, many jobs" as `FOLLOWED A CONNECTION`, with a
   visible `← An orbit is not a perfect …` back affordance
   ([semantic-branch-target.png](semantic-branch-target.png)).
3. Activity recreation keeps the target, its origin and the way back.
4. System Back returns to the origin at its **exact stored and on-screen reading position**
   (the reader's semantics state description is asserted, not just the stored number)
   ([semantic-branch-return.png](semantic-branch-return.png)).
5. "Seems wrong" hides that connection for this reader only. The rail then says so honestly, and
   the toast states that the sources are unchanged ([semantic-hidden.png](semantic-hidden.png)).

Database lineage, verified in SQL after the run: exactly one `branch` Ledger event, caused by the
origin's exposure event; one `branch_open` naming the bridge, the origin exposure, the target and
the branch decision; the target's exposure admitted through that branch decision; one
`seems_wrong` feedback row; all 6 shared bridges still admitted; 0 personal proposals.

## Failures found by running it (kept, not smoothed over)

- **Reading position lost on return** (observed 1419 → 1083). The continuation rail loads after
  first layout, so the document was briefly shorter, ScrollState clamped, and the clamped value was
  persisted. This is a regression the live rail introduced. Fixed with a bounded restore guard, and
  proven red then green by `ReadingRestoreTest`.
- **Tenuous continuation.** An orbit Scroll that merely involves the Sun was offered "the Sun's
  energy output explains Earth's energy budget". Matching now requires the encounter to be about
  the bridge side or a narrower part of it.
- **Visual.** Evidence repeated once per role; the back affordance was cream on cream. Both fixed.
- **Test defects (not product):** a helper that shadowed Compose's `hasText`, and a button below
  the sheet's fold that was clicked without scrolling to it.
- **Verifier false pass.** The editorial-content worker found that `verify-substrate.ts` exited 0
  without checking anything when the path contains a space. Fixed with `pathToFileURL`.

## Owner preview

The `.journey` app is also the owner's preview on 4322. Each run pulls the installed APK and
archives its app data, then reinstalls that exact APK, restores the data and relaunches it
([preview-restored.json](preview-restored.json): APK sha256 and restored data size). Owner
database `knowscroll` was never touched.

## Limits

- Bridges are editorial. Model-proposed bridges arrive with #132 through the same validator.
- Continuations are Scroll-only; Reels carry no concept annotations yet.
- The substrate is small (32 concepts, 59 claims, 6 bridges), so most Scrolls honestly say that
  no connection leads on yet.
- Emulator only (API36, debug build), not a physical device. Frame timing is not measured here.
- Usefulness is not established by these checks. Owner review of whether these connections help is
  separate.
