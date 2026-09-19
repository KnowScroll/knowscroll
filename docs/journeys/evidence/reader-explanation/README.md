# "Why this appeared" and "Sign out this device" — issue #91, review repair round

Superseding the prior evidence at `8eec469`/`c8435b6`. This is a bounded fix-and-reverify
round against an independent accept-with-fixes review of five findings; see "Findings
fixed" below. Verified at clean **`68a30dbc745420396abcfbb97718c39b158f7773`** (worktree
`91-reader-explain`, branch `claude/91-reader-explain`). No `apps/api`, `apps/worker`,
`packages/**`, migration, `docs/decisions` or `docs/contracts` file was touched.

Every piece of evidence in this directory (screenshots, per-scenario JSON, `am instrument`
text logs, `release.json`) was produced by this session actually driving the build and a
real, booted `KnowScroll_API36` (API 36) emulator end-to-end, against disposable
API/worker/PostgreSQL processes this session started and stopped and the separate
`.journey` Android package. Nothing here is a hash-based re-assertion of a previous run.

## Findings fixed

1. **Sequential sign-out retry on cold start.** `AppViewModel.kt` `init()` used to launch
   `beginSignOut()` (`POST /v1/session/revoke`) and `reconcilePrivacy(true)`
   (`GET /v1/universe`) as two independently launched coroutines whenever a restored,
   unresolved ("ambiguous") pending sign-out existed -- racing the same possibly-dead
   token. `reconcilePrivacy` now takes a `retrySignOutFirst` flag; when set, its own
   coroutine calls the new `continueReconcilingAfterSignOutRetry(...)`, which awaits the
   sign-out retry (`attemptSignOutRevoke()`, factored out of `beginSignOut()`) to
   completion **in the same coroutine**, before the universe fetch ever runs, and skips
   the universe fetch entirely if the retry already resolved to signed-out. This mirrors
   the existing pending-Clear-History pattern (dispatched from inside `reconcilePrivacy`).
   New `SignOutColdStartOrderingTest.kt` (JVM, 4 cases) exercises the shipped gate
   function with fake suspend "clients" recording call order, including a documentation
   case reproducing the previous two-independent-`launch` shape to show why it raced.
2. **Missing `explain-recreate.png`.** The instrumentation always wrote it
   (`ReaderExplainJourneyTest.explainSheetPrepareForRotationAndProcessDeath`) and the
   script always pulled it (`android-reader-explain-journey.py`); the gap was in what a
   prior session copied into `docs/`. It is captured for real this time; see
   [`explain/explain-recreate.png`](explain/explain-recreate.png).
3. **The 1029.116s duration outlier.** Investigated and not reproduced. See "Duration
   outlier investigation" below.
4. **Grammar.** `reader_explain_documented_sources_note`: "Sources below shows this
   evidence." -> "Sources below **show** this evidence." (`strings.xml`; the one
   instrumentation assertion quoting it was updated to match.)
5. **Touch targets.** `UniverseScreen.kt`'s "Sign out this device" control and both
   `SignOutConfirmation` dialog buttons now carry an explicit `heightIn(min = 48.dp)`,
   matching the reader explain control's existing pattern.
   `SignOutJourneyTest.openSignOutConfirmation()` now asserts all three
   `assertHeightIsAtLeast(48.dp)`, the same way `ReaderExplainJourneyTest` already
   asserts the explain control.

## What shipped (unchanged from the original issue #91 delivery, restated for context)

**A. Why this appeared.** An accessible ("Why this Scroll appeared", now assertively
≥48dp) control on the reader opens a bottom sheet (`ExplainSheet` in `ScrollScreen.kt`)
that states only fields the API actually returned: the feed item's `reason` verbatim
(blank/missing shows "No explanation was recorded for this Scroll."), the truth state
plus its fixed meaning from definition §12, and the origin (deliberate discovery, or a
saved Trace with the exact `keptAt` the trace-revisit contract returns). No interest,
learning, profile or evidence path is invented (Laws 4, 11, 13).

**B. Sign out this device.** `SignOutControls`/`SignOutConfirmation` in
`UniverseScreen.kt`, next to Clear History, confirm then call
`POST /v1/session/revoke {}`. A 204 purges this device's private state and shows
`SignedOutScreen` (terminal, no retry). Only an actual 401 resolves an in-flight attempt
as signed-out; every other outcome (timeout, dropped socket, 5xx, malformed response,
missing token) is ambiguous, keeps local state, and offers an explicit retry. A
pending/ambiguous sign-out persists across process death and, per fix 1 above, its
cold-start retry is now sequenced with privacy reconciliation instead of racing it.

## Tests

- **JVM unit** (`apps/mobile/app/src/test/kotlin/com/knowscroll/mobile/ui/`): 26 tests, 0
  failures -- `ReaderDiscoveryTest`(5), `ReaderExplainTest`(7), `SignOutStateTest`(6),
  **`SignOutColdStartOrderingTest`(4, new)**, `TraceRevisitStateTest`(4).
- **Instrumentation** (`ReaderExplainJourneyTest.kt`, `SignOutJourneyTest.kt`): see
  `explain/` below, 9 scenarios.
- **Regression**: the existing `ReaderJourneyTest`, `ReaderAuthorityJourneyTest`,
  `ReaderPrivacyJourneyTest`, `RealJourneyTest` (history + real-journey scenarios) and
  `TraceRevisitJourneyTest` suites, unmodified, rerun end-to-end; 23 scenarios; see
  `regression/` below.

## Evidence layout

- [`explain/`](explain/) -- the new-feature instrumentation: per-scenario JSON receipts,
  `am instrument` text logs, 9 real-emulator screenshots (including the now-present
  `explain-recreate.png`) and the script's own [`release.json`](explain/release.json).
- [`regression/reader/`](regression/reader/), [`regression/history/`](regression/history/),
  [`regression/trace-revisit/`](regression/trace-revisit/),
  [`regression/journey/`](regression/journey/) -- receipts and screenshots from rerunning
  every other existing Android instrumentation script (`android-reader-journey.py`,
  `android-history-journey.py`, `android-trace-revisit-journey.py`,
  `android-journey.py`), unmodified.
- [`incidents/`](incidents/) -- the two transient first-attempt failures this session hit
  while regenerating this evidence, kept rather than discarded once retried clean, plus
  the direct `systemui` ANR observation that explains them (see below).
- [`release.json`](release.json) -- this session's own aggregate receipt: all 32
  scenarios, their real measured durations and pass/fail, the two first-attempt failures
  and their retries, and the duration-outlier investigation.

## Commands and how this was actually verified

After `. ./scripts/env.sh` (confirmed `node --version` -> `v22.23.0`):

```
apps/mobile/gradlew -p apps/mobile :app:assembleDebug :app:lintDebug :app:testDebugUnitTest --console plain
```
`BUILD SUCCESSFUL`. 26 JVM unit tests, 0 failures. `lintDebug`: 0 errors, only
pre-existing dependency-version-style warnings.

Then, with the `KnowScroll_API36` AVD booted fresh for this task (`adb devices` ->
`emulator-5554 device`, `ro.build.version.sdk` -> `36`), each script below was run to
completion, in order, on the one emulator, each creating and dropping its own disposable
PostgreSQL database and starting/stopping its own disposable API/worker processes:

```
python3 scripts/android-reader-explain-journey.py   # new: explain + sign-out, 9 scenarios
python3 scripts/android-reader-journey.py           # regression: reader/authority/privacy, 4
python3 scripts/android-history-journey.py          # regression: clear-history, 6
python3 scripts/android-trace-revisit-journey.py    # regression: trace revisit, 8
python3 scripts/android-journey.py                  # regression: real journey (J001), 5
```

All 32 scenarios across all 5 scripts passed, all at revision `68a30dbc7454...`,
`dirty: false`. Two of them failed on their first attempt and passed on an immediate,
code-unchanged retry; see "First-attempt failures" below -- they are not papered over.

## Per-phase expected vs observed (`explain/release.json` and its JSON receipts)

| Phase | Expected | Observed |
|---|---|---|
| `explainSheetShowsDiscoveryReasonTruthAndSourcesNote` | Sheet shows the real composer reason, `DOCUMENTED`, its §12 meaning, the (now corrected) sources note, and the discovery origin sentence; control ≥48dp | Matched, 9.494s; [json](explain/explain-discovery.json), [screenshot](explain/explain-discovery.png) |
| `explainSheetReportsNoRecordedExplanationForABlankReason` | A feed item with `reason` blanked (proxy-only fixture) shows "No explanation was recorded for this Scroll." | Matched, `feedReasonsBlanked: 1`, **7.452s** (see duration-outlier investigation); [json](explain/explain-blank-reason.json), [screenshot](explain/explain-blank-reason.png) |
| `explainSheetShowsSavedTraceOriginWithKeptDateAndNoReason` | Reopening a real saved Trace (real Keep -> real worker projection -> real `GET /v1/traces/:eventId`) shows the exact `keptAt` and no fabricated reason | Matched, 67.371s (expected: this scenario polls real worker projection up to 15s and waits for the reconciliation UI up to 15s more; it has run 67-77s across every recorded attempt of this scenario, unlike the outlier); [json](explain/explain-saved-trace.json), [screenshot](explain/explain-saved-trace.png) |
| `explainSheetPrepareForRotationAndProcessDeath` + `explainSheetRestoresReadingAfterProcessDeath` | Reading session survives Activity recreation and real `am force-stop` + relaunch (different PID); the recreate screenshot exists | Matched, 6.692s / 3.117s; [prepare](explain/explain-prepare.json), [after death](explain/explain-process-death.json), [recreate screenshot](explain/explain-recreate.png), [after-death screenshot](explain/explain-process-death.png) |
| `signOutConfirmationCancelIsHarmless` | Cancel leaves the session live, touches no domain rows; control and both dialog buttons ≥48dp | Matched, 6.151s, domain counts unchanged; [json](explain/signout-confirm.json) |
| `signOutConfirmedRevokeEndsSessionHonestly` | Confirm -> real 204 -> `SignedOutScreen`, no retry control, a subsequent real call gets a real 401 | Matched, 5.81s, `revokeSucceeded: 2` (this run plus the prior cancel-then-live check), `sessionVerifiedDeadAfter401: true`; [json](explain/signout-success.json) |
| `signOutNetworkDroppedRevokeThenRetrySucceeds` | A dropped socket keeps local state and offers retry; the identical retry then succeeds | Matched, 7.821s, `revokeSocketsDropped: 2`; [json](explain/signout-network-drop.json) |
| `signOutAlreadyRevokedSessionResolvesAsSignedOut` | A session revoked out-of-band resolves the app's own first attempt as signed-out via a real 401 | Matched, 5.219s, `revokeUnauthorized: 1`; [json](explain/signout-401.json) |
| Regression: reader/reader-authority/privacy (4), clear-history (6), trace-revisit (8), real journey (5) -- 23 scenarios | All previously accepted behavior unchanged | All `passed`; two needed one retry each (see below), the rest passed on the first attempt; durations 3.0-24.2s, see `release.json.scenarios` for every value |

## First-attempt failures (kept, not discarded)

Two of the 32 scenarios failed once during this session and passed on an immediate,
code-unchanged retry:

- **`readerSourcesThresholdAndRest`** (`android-reader-journey.py`, pre-existing,
  unmodified `ReaderJourneyTest.kt`): `ComposeTimeoutException` after 15000ms waiting for
  the journey app's window to regain foreground focus before opening a browser intent.
  Full first-attempt log: [`incidents/readerSourcesThresholdAndRest-first-attempt.txt`](incidents/readerSourcesThresholdAndRest-first-attempt.txt).
  Retried clean at 24.171s: [`regression/reader/readerSourcesThresholdAndRest.txt`](regression/reader/readerSourcesThresholdAndRest.txt).
- **`processDeathRestoreKeepReturnAndNext`** (`android-journey.py`, pre-existing,
  unmodified `RealJourneyTest.kt`): the same `ComposeTimeoutException`-after-15000ms
  shape, this time waiting for text after `am force-stop` + relaunch.
  Full first-attempt log: [`incidents/processDeathRestoreKeepReturnAndNext-first-attempt.txt`](incidents/processDeathRestoreKeepReturnAndNext-first-attempt.txt).
  Retried clean at 3.741s: [`regression/journey/processDeathRestoreKeepReturnAndNext.txt`](regression/journey/processDeathRestoreKeepReturnAndNext.txt).

Immediately after the first failure, `adb shell dumpsys window` showed
`mCurrentFocus=Window{... Application Not Responding: com.android.systemui}` -- the
Android System UI process itself had hit an ANR. `adb shell input keyevent KEYCODE_HOME`
recovered it. The emulator was then restarted fresh (with more memory, 3584MB instead of
2048MB) before continuing; the *second* failure above still happened on that fresh boot,
and a fresh boot check (six `dumpsys window` reads, 5s apart, immediately after
`sys.boot_completed=1`) showed the identical `systemui` ANR persisting until dismissed the
same way. Full transcript: [`incidents/systemui-anr-observation.txt`](incidents/systemui-anr-observation.txt).
Neither failing test's source (`ReaderJourneyTest.kt`, `RealJourneyTest.kt`) was touched
by this issue's fix, and both passed unmodified on retry, so these are recorded as
environment-level instrumentation flakes, not product or test defects.

## Duration outlier investigation (review finding 3)

The prior evidence recorded `explainSheetReportsNoRecordedExplanationForABlankReason` at
**Time: 1,029.116s** against every sibling scenario's 3-27s (and this new run's own
`explainSheetShowsDiscoveryReasonTruthAndSourcesNote` at 9.494s, an almost identical
sequence of steps). This round:

- **Did not reproduce it.** The identical test, at the identical code path (this fix
  changes only `strings.xml` wording and its one matching assertion in the same file;
  `ReaderExplainJourneyTest.explainSheetReportsNoRecordedExplanationForABlankReason` and
  the `AppViewModel`/`ScrollScreen` code it exercises for this scenario are otherwise
  byte-for-byte the same as at `8eec469`), run fresh against the new commit, completed in
  **7.452s** -- squarely inside the normal range.
- **Ruled out at the code level:**
  - No `compose.waitUntil(...)` or `delay(...)` call anywhere in
    `ReaderExplainJourneyTest.kt` or the AppViewModel/ApiClient code paths it exercises
    for this specific scenario exceeds 15 seconds; none can deterministically produce a
    1029s wall-clock result on its own.
  - `ApiClient.request` retries at most twice, with delays of at most 1.2s between
    attempts and 5s/8s connect/read timeouts; no accumulation on a single scenario's
    handful of calls reaches 1029s.
  - This scenario's own steps (`openReaderFresh`, `openExplainSheet`, three assertions, a
    screenshot, a JSON write) are structurally the same shape and length as the sibling
    `explainSheetShowsDiscoveryReasonTruthAndSourcesNote`, which has never shown this
    anomaly, this run or the prior one.
  - `android-reader-explain-journey.py`'s own `subprocess.check_output(..., timeout=120)`
    bound on every `am instrument` call is, on its face, inconsistent with a genuine
    1029s *local* hang on that specific call still letting the whole script finish and
    write a `passed` `release.json` afterward. This inconsistency in the historical
    receipt is recorded here, not resolved; this session cannot re-interrogate a process
    that no longer exists.
- **What this session can say with direct evidence:** this exact AVD/host environment,
  during this exact session, produced a real, reproducible stall mechanism unrelated to
  any product or test code -- a `com.android.systemui` ANR -- twice, each time causing an
  unrelated, pre-existing, unmodified regression scenario to fail with a
  `ComposeTimeoutException`-after-15000ms and then pass cleanly on immediate retry (see
  "First-attempt failures" above). This is offered as a plausible class of explanation
  for the kind of one-off, order-of-magnitude stall the 1029.116s figure represents, given
  every project script, cache and AVD image lives on the external SSD
  (`docs/operations/development.md`) where I/O contention is a known risk -- **not** as
  proof of what specifically stalled that one, now-gone process. That remains unproved,
  and is recorded as such rather than guessed at further.

## Limits

- The explain sheet's transient *open* flag is `rememberSaveable`: restored across an
  in-process Activity recreation (rotation), not across a genuine `am force-stop` +
  relaunch (same as the existing Sources sheet). The durable reading session (asset,
  exposure, reading position) is restored correctly in both cases.
- No manual TalkBack traversal or owner visual acceptance was recorded here;
  content-description presence was exercised indirectly by every
  `onNodeWithContentDescription` lookup succeeding, and every interactive control this
  round's review named (explain control/close, "Sign out this device", both
  `SignOutConfirmation` dialog buttons) was explicitly asserted ≥48dp.
- No desktop, physical device, Reel, branch, world-geography, semantic/living/social, or
  live-provider proof. `providerCalls: 0` throughout.
- The sequential sign-out-retry-then-reconcile ordering (finding 1) is proved at the
  function level by `SignOutColdStartOrderingTest.kt` against the exact gate function
  `AppViewModel.reconcilePrivacy` now calls; it is not separately re-proved by a new
  real-emulator instrumentation scenario driving an actual ambiguous-then-cold-start race,
  because the existing instrumentation suite has no seam to hold a session ambiguous
  across a real process restart without also being the pre-existing
  `signOutNetworkDroppedRevokeThenRetrySucceeds`/cold-restore coverage already exercised.
- This is fixture and source-level proof on a disposable database and the separate
  `.journey` Android package; it is not owner visual acceptance and not live production
  evidence.
- ADR-0016 governs why there is still no Ask control; nothing here adds one.

## Process/database state left behind

- Disposable PostgreSQL databases (`knowscroll_test_reader_explain_*`,
  `knowscroll_test_reader_*`, `knowscroll_test_*` for history/journey/trace-revisit) were
  created and dropped by each script's own `finally` block; a direct check after every
  run (`select datname from pg_database where datname like 'knowscroll_test_%'`) found
  none left behind, including after the two scenarios that failed and were retried.
- The disposable API/worker child processes used by each script's `finally` block exited
  before this session moved to the next script; no stray `tsx apps/api`/`tsx apps/worker`
  process remained at any checkpoint.
- The `KnowScroll_API36` emulator was booted fresh for this task, used for all six
  script runs (five scripts, one retried once), and shut down
  (`adb -s emulator-5554 emu kill`) at the end of this task; no emulator or `adb`/`qemu`
  process was left running (`ps aux | grep -iE "qemu|emulator"` empty afterward).
- The owner/dev `com.knowscroll.mobile` package's installed path was checked before and
  after every script run and found unchanged; only `com.knowscroll.mobile.journey` was
  installed/cleared by these scripts.

## Coordinator reproduction after merging main (2026-09-19/20)

Current `main` (carrying #93 Cutroom and #95 desktop web) was merged into this lane at `e5fb9bfb2cbc326e90cda2b2e798f630f9159ff9`
and the coordinator re-ran the evidence independently on a freshly booted AVD:

- `:app:assembleDebug :app:lintDebug :app:testDebugUnitTest` — build and lint clean, **26 JVM tests**
  across 5 classes, 0 failures (including the new `SignOutColdStartOrderingTest`).
- `scripts/android-reader-explain-journey.py` — **9/9 scenarios passed** at revision
  `e5fb9bf` with a clean tree, first attempt, no retry. Recorded facts include the real composer
  reason text, `documented` plus its §12 meaning, a saved Trace's real `keptAt`, sign-out resolved
  via a real 204, an ambiguous network-dropped revoke retried successfully with the same request, and
  an already-revoked session resolving through a real 401. Domain counts before and after sign-out are
  identical (4 decisions, 4 exposures, 5 ledger rows, 1 job, 1 trace) — **signing out erases no history**.
- `scripts/android-journey.py` — existing J001 regression passed on the same build.

**Known limitation (unchanged by this slice):** an *open* explanation sheet does not reopen after
Activity recreation; the instrumentation records the observed outcome rather than asserting one, and
the reading session, position, exposure identity and retry envelope do survive both recreation and
real process death. This matches the existing Sources sheet. Restoring transient sheet state across
recreation is tracked separately under #3.
