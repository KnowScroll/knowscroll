# "Why this appeared" and "Sign out this device" — issue #91

Verified at clean `8eec469da7f9bf149faca39ffe51286a5999d751` (worktree
`91-reader-explain`, branch `claude/91-reader-explain`, from main `ab258ed`). No
`apps/api`, `apps/worker`, `packages/**`, migration, `docs/decisions` or
`docs/contracts` file was touched; `apps/api/src/app.ts` is unchanged.

## What shipped

**A. Why this appeared.** An accessible ("Why this Scroll appeared", ≥48dp)
control on the reader opens a bottom sheet (`ExplainSheet` in
`ScrollScreen.kt`, same `ModalBottomSheet` + `rememberSaveable` pattern as the
existing `SourceSheet`) that states only fields the API actually returned:

- the feed item's `reason` verbatim (`explainReasonText`; blank/missing shows
  "No explanation was recorded for this Scroll." instead of guessing),
- the truth state plus its fixed meaning from
  [definition §12](../../product/definition.md) (`truthStateMeaning`; an
  unrecognized state shows no invented meaning), with a note that the Sources
  control shows the evidence when the state is `documented`,
  and
- the origin: deliberate discovery, or a saved Trace with the exact `keptAt`
  the [trace-revisit contract](../../contracts/trace-revisit.md) returns
  (`ReaderOrigin.SavedTrace.keptAt`, from `GET /v1/traces/:eventId`).

No interest, learning, profile or evidence path is invented (Laws 4, 11, 13).
Sheet open state is `rememberSaveable`, exactly like the existing Sources
sheet, so it survives Activity recreation (rotation) the same way; see
"Limits" below for what real process death does and does not restore.

**B. Sign out this device.** `SignOutControls`/`SignOutConfirmation` in
`UniverseScreen.kt`, next to Clear History, confirm then call
`POST /v1/session/revoke {}` (already specified in
[bootstrap-http.md](../../contracts/bootstrap-http.md) and implemented at
`apps/api/src/app.ts:57`, both unchanged). The confirmation copy states: this
device's session ends now; Scroll history is not erased (Clear History is
separate); other devices are unaffected; using KnowScroll here again needs a
new operator-issued device session. A 204 purges this device's private state
through the existing `purgeForScope` machinery and shows `SignedOutScreen`
(terminal — no retry, no token entry, no new auth flow). Only an actual 401
(`isSignOutAmbiguous`) resolves an in-flight attempt as signed-out; every other
outcome (timeout, dropped socket, 5xx, malformed response, missing token) is
ambiguous, keeps local state, and offers an explicit retry of the identical
request. A pending/ambiguous sign-out is persisted (`StateStore.pendingSignOut`)
and a durable terminal sign-out (`StateStore.signedOut`) is restored on cold
start (`signOutRestoreState`) the same way pending Clear History already is.

## Tests

- **JVM unit** (`apps/mobile/app/src/test/kotlin/com/knowscroll/mobile/ui/`):
  `ReaderExplainTest.kt` (7 cases: blank/verbatim reason, every truth-state
  meaning from §12, the documented-only sources note, discovery vs
  saved-Trace origin text never mentioning "interest") and
  `SignOutStateTest.kt` (6 cases: only-401-resolves-ambiguity, every other
  transport outcome stays ambiguous, idle/retryable/terminal restoration,
  the durable terminal marker always wins over a stale pending flag).
- **Instrumentation** (`ReaderExplainJourneyTest.kt`, `SignOutJourneyTest.kt`):
  see `explain/` below.
- **Regression**: the existing `ReaderJourneyTest`, `ReaderAuthorityJourneyTest`,
  `ReaderPrivacyJourneyTest`/history, `TraceRevisitJourneyTest` and
  `RealJourneyTest` suites, unmodified, rerun end-to-end; see `regression/`
  below.

## Evidence layout

- [`explain/`](explain/) — the new-feature instrumentation: per-scenario JSON
  receipts, `am instrument` text logs, 9 real-emulator screenshots and the
  script's own [`release.json`](explain/release.json).
- [`regression/reader/`](regression/reader/), [`regression/history/`](regression/history/),
  [`regression/journey/`](regression/journey/), [`regression/trace-revisit/`](regression/trace-revisit/) —
  JSON/text receipts from rerunning every other existing Android instrumentation
  script (`android-reader-journey.py`, `android-history-journey.py`,
  `android-journey.py`, `android-trace-revisit-journey.py`), unmodified.
- [`release.json`](release.json) — this session's aggregate receipt.

## Commands and how this was actually verified

This worktree already contained a same-branch, same-commit prior attempt at
this issue (git reflog shows one commit, `8eec469`, checked out from main
`ab258ed`; the emulator, `.env` and `apps/mobile/local.properties` provided
for this lane were already in place). That attempt had already run the full
build/test/instrumentation cycle and left real, unpushed evidence in the
gitignored `artifacts/` directory but had not yet written the
`docs/journeys/evidence/reader-explanation/` deliverable this issue requires.
This session:

1. Read every changed source file and cross-checked it against
   `docs/product/definition.md` §12, `docs/contracts/trace-revisit.md` and
   `docs/contracts/bootstrap-http.md`/`apps/api/src/app.ts` (read-only) to
   confirm the client invents nothing the API/contracts do not already say.
2. Independently recomputed the sha256 of every source file listed in each of
   the five phase receipts (`artifacts/android-*-journey/{release,environment}.json`)
   against the files actually on disk at `8eec469`: **210 files checked across
   5 receipts, 0 mismatches**, and each receipt's own recorded commit hash and
   `dirty: false` matches the worktree's current, clean `git status`. This is
   the basis for treating the prior run's pass/fail outcome as trustworthy
   evidence of this exact commit, not a stale or fabricated claim.
3. Ran, fresh in this session (after `. ./scripts/env.sh`, confirmed
   `node --version` → `v22.23.0`, `adb devices` → `emulator-5554 device`,
   AVD `KnowScroll_API36`, `ro.build.version.sdk` → `36`):
   ```
   apps/mobile/gradlew -p apps/mobile :app:assembleDebug :app:lintDebug :app:testDebugUnitTest --console plain
   ```
   Result: `BUILD SUCCESSFUL`. 22 JVM unit tests, 0 failures
   (`ReaderDiscoveryTest` 5, `ReaderExplainTest` 7, `SignOutStateTest` 6,
   `TraceRevisitStateTest` 4). `lintDebug`: 0 errors, only pre-existing
   dependency-version-style warnings.
4. Organized the prior attempt's real instrumentation output (screenshots,
   per-scenario JSON, `am instrument` logs) into this directory and wrote
   this README and `release.json`.

This session did **not** itself re-drive the ~40-60 minute, 5-script,
32-scenario emulator instrumentation suite a second time; it verified the
existing real run's integrity by hash rather than by re-execution, given the
commit is unchanged and the tree is clean. That distinction is recorded
explicitly in `release.json.verificationMethod` and repeated here so it is
never read as this session's own live observation.

## Per-phase expected vs observed (from `explain/release.json` and the JSON
receipts in `explain/`)

| Phase | Expected | Observed |
|---|---|---|
| `explainSheetShowsDiscoveryReasonTruthAndSourcesNote` | Sheet shows the real composer reason ("An editorial starting encounter. No interests have been inferred."), `DOCUMENTED`, its §12 meaning, the sources note, and the discovery origin sentence; control ≥48dp | Matched; [`explain-discovery.json`](explain/explain-discovery.json), [screenshot](explain/explain-discovery.png) |
| `explainSheetReportsNoRecordedExplanationForABlankReason` | A feed item with `reason` blanked (proxy-only fixture, never the API/composer) shows "No explanation was recorded for this Scroll." | Matched, `feedReasonsBlanked: 1`; [json](explain/explain-blank-reason.json), [screenshot](explain/explain-blank-reason.png) |
| `explainSheetShowsSavedTraceOriginWithKeptDateAndNoReason` | Reopening a real saved Trace (real Keep → real worker projection → real `GET /v1/traces/:eventId`) shows the exact `keptAt` and no fabricated reason | Matched, `keptAt: "2026-09-19T20:28:45.077Z"`; [json](explain/explain-saved-trace.json), [screenshot](explain/explain-saved-trace.png) |
| `explainSheetPrepareForRotationAndProcessDeath` + `explainSheetRestoresReadingAfterProcessDeath` | Reading session (asset/exposure/position) survives Activity recreation and real `am force-stop` + relaunch (different PID) | Matched: same asset/exposure/position across both; recreation may or may not keep the sheet visually open (observed both outcomes are handled, not assumed) — see Limits | [prepare](explain/explain-prepare.json), [after death](explain/explain-process-death.json), [screenshot](explain/explain-process-death.png) |
| `signOutConfirmationCancelIsHarmless` | Cancel leaves the session live, touches no domain rows | Matched, domain counts unchanged; [json](explain/signout-confirm.json) |
| `signOutConfirmedRevokeEndsSessionHonestly` | Confirm → real 204 → `SignedOutScreen`, no retry control, a subsequent real call gets a real 401 | Matched, `revokeSucceeded: ≥1`, `sessionVerifiedDeadAfter401: true`; [json](explain/signout-success.json) |
| `signOutNetworkDroppedRevokeThenRetrySucceeds` | A dropped socket keeps local state and offers retry (not "signed out"); the identical retry then succeeds | Matched, `revokeSocketsDropped: 2` (initial + internal client retry), then resolved; [json](explain/signout-network-drop.json) |
| `signOutAlreadyRevokedSessionResolvesAsSignedOut` | A session revoked out-of-band resolves the app's own first attempt as signed-out via a real 401, not a fabricated one | Matched, `revokeUnauthorized: ≥1`; [json](explain/signout-401.json) |
| Regression: reader/reader-authority, privacy/clear-history, trace-revisit, real journey (32 scenarios total) | All previously accepted behavior unchanged | All `result: "passed"` in `regression/*/`; see hash-verification above |

## Limits

- The explain sheet's transient *open* flag uses the same `rememberSaveable`
  mechanism as the existing Sources sheet: it is restored across an in-process
  Activity recreation (rotation), but — like the existing Sources sheet — it
  is **not** restored across a genuine `am force-stop` + relaunch, because
  that discards the saved-instance-state Bundle rather than replaying it. The
  durable reading session (asset, exposure, reading position) that actually
  matters for continuity is restored correctly in both cases; the test
  documents the sheet's real observed visibility rather than assuming it.
- No manual TalkBack traversal or owner visual acceptance was recorded here;
  content-description presence was exercised indirectly by every
  `onNodeWithContentDescription` lookup in the instrumentation succeeding, and
  the explain control's height was explicitly asserted ≥48dp.
- No desktop, physical device, Reel, branch, world-geography, semantic/living/
  social, or live-provider proof. `providerCalls: 0` throughout.
- Concurrent restore-of-a-pending-sign-out with a still-inflight universe
  reconciliation was not exercised; only sequential ambiguous-then-retry and
  pre-revoked-then-401 are covered.
- This is fixture and source-level proof on a disposable database and the
  separate `.journey` Android package; it is not owner visual acceptance and
  not live production evidence.
- ADR-0016 governs why there is still no Ask control; nothing here adds one.

## Process/database state left behind

- Disposable PostgreSQL databases (`knowscroll_test_reader_explain_*` and each
  other script's own `knowscroll_test_*` database) were created and dropped
  by each script's own `finally` block; none were owner databases and none
  were left behind.
- The disposable API/worker child processes used by each script's `finally`
  block exited before this session began writing evidence (all five receipts'
  `cleanup.childrenExited`/equivalent fields are `true`).
- The `KnowScroll_API36` emulator (`emulator-5554`) was already running,
  headless, from the prior attempt and remained the only Android device
  attached for the rest of this session (used only for `adb devices`/
  `getprop` confirmation, not a fresh instrumentation run). `docs/operations/development.md`
  does not direct leaving it running between sessions, only to stop it before
  ejecting the SSD, so it was shut down (`adb -s emulator-5554 emu kill`) at
  the end of this task; no emulator or `adb`/`qemu` process was left running.
- The owner/dev `com.knowscroll.mobile` package's installed path was checked
  before and after every script run and found unchanged (`ownerPackage` in
  each receipt); only `com.knowscroll.mobile.journey` was installed/cleared.
