# Semantic substrate and live continuations — evidence, 2026-09-24

Issue [#131](https://github.com/KnowScroll/knowscroll/issues/131) (with the first #133/#134 thread), parent #72.
Decision: [ADR-0031](../../../decisions/0031-semantic-substrate-and-validated-bridges.md).
Implementation revision for the Android journey below: `cb2ac30` (receipt `source`), after the
independent review's fix pass. The first run, at `5dd71a5`, is described under *Failures found*.

## Outcome

A reader reaches a sourced Scroll through ordinary discovery. They see a continuation drawn from an
**admitted, source-backed bridge**, inspect why it connects (mechanism, where it stops, cited
evidence), follow it, and return with Back to exactly where they were. They can also hide a
connection that seems wrong to them, without retracting the shared knowledge. A plausible but
unsupported connection is refused and never offered.

## Evidence levels

| Level | What ran | Result |
|---|---|---|
| Source verification | `scripts/substrate/verify-substrate.ts --require-snapshots` against hashed snapshots of 9 public pages (NASA, NOAA, OpenStax), retrieved 2026-09-24 | 71/71 quotes are exact passages; 9/9 hashes match ([substrate-verification.json](substrate-verification.json)) |
| Pure validator | `tests/semantic-bridge-validator.test.ts` | 18/18 pass, including the five admissions the review showed were wrong (upward generalisation, a refuting claim cited as support, contradiction order, loose direction, one claim serving every role). First-slice mutation checks: disabling the mechanism rule turns 4 tests red; disabling the direction rule turns 1 red |
| Real PostgreSQL / HTTP | `tests/semantic-substrate.test.ts`, `semantic-editorial.test.ts`, `semantic-migration.test.ts` | 18 + 4 + 1 pass. Real editorial seed: 6/6 bridges admitted, 4/4 tempting bridges refused. Populated 0025→0026 upgrade preserves every prior row and checksum. Mutation checks: removing the semantic erasure or the suppression filter turns 3 tests red |
| Android units | `./gradlew :app:testDebugUnitTest` | 102/102 (new: `BranchesTest` 6, `ReadingRestoreTest` 2 — red before their fixes: expected 4079, was 3929; a paused receipt parsed its null decision as the string `"null"`) |
| Real emulator journey | `scripts/android-semantic-journey.py` → `SemanticBranchJourneyTest` on emulator-5554 (API36), separate `.journey` app, disposable API/worker/PostgreSQL on 4333 | `OK (1 test)`; DB lineage below |
| Live provider | none | No model or provider call. Every bridge is editorial, decided by the deterministic validator |

## Real journey

[receipt.json](receipt.json), [instrumentation.txt](instrumentation.txt):

1. The reader enters the Cable. The first Scroll ("An orbit is not a perfect circle") offers
   **"Is explained by Gravity"**, traveling the admitted `physics.gravity explains astro.orbit`
   bridge in reverse. ([semantic-connections.png](semantic-connections.png) shows the mechanism,
   what helps to know first, where it stops, and three cited quotes with their sources.)
2. The reader follows it and lands on "The pull you can't see" as `FOLLOWED A CONNECTION`, with a
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

## Independent review fix pass

A fresh-context review of `563253d` found one blocking and six important defects. All were fixed
with a failing test first:

- **Paused branches were recorded** (a decision row was stored). Now nothing is stored and
  `decisionId` is null; Android never tries to expose such a target.
- **Session expiry during the substrate lock wait** now refuses the branch.
- **Validator admissions** listed above.
- **Guards that direct SQL could bypass:** bridge evidence is immutable; a snapshot status change
  without its correction propagation is refused at commit; an admitted proposal's stored decision
  must agree with its status and validator version.
- **The runner could lose the owner's preview data** — see *Owner preview* below.
- **Clear/Reset of a universe's own bridge** is now exercised end to end.
- **Proposal replay** is scoped per universe.

Also fixed from the minors: a later seed can no longer extend existing claims or annotations, and
it re-validates admitted bridges (a newly added contradiction revokes them with the seed named as
the cause); the restore guard no longer treats the unmeasured `Int.MAX_VALUE` document as ready.

## Owner preview

The `.journey` app is also the owner's preview on 4322. Each run pulls the installed APK and
archives its app data into a per-run timestamped backup, and refuses to replace anything unless
that archive is readable and holds the preferences. Afterwards it reinstalls that exact APK,
restores the data, compares the restored files (names and sizes) with the backup, and relaunches
it ([preview-restored.json](preview-restored.json): APK sha256, file count, `dataVerified: true`).
Owner database `knowscroll` was never touched.

## Limits

- Bridges are editorial. Model-proposed bridges arrive with #132 through the same validator.
- Continuations are Scroll-only; Reels carry no concept annotations yet.
- The substrate is small (32 concepts, 60 claims, 6 bridges), so most Scrolls honestly say that
  no connection leads on yet.
- Emulator only (API36, debug build), not a physical device. Frame timing is not measured here.
- Activity recreation is exercised; process death is not (the persisted return trail is proven by
  `StateStore` unit tests only).
- The paused-branch path is proven in SQL/HTTP and Android unit tests, not on the emulator: Android
  has no pause control until #135.
- Usefulness is not established by these checks. Owner review of whether these connections help is
  separate.
