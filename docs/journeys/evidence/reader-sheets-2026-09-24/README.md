# Reader sheets survive recreation — evidence, 2026-09-24 (#97)

`KS_SEMANTIC_JOURNEY=sheets python3 scripts/android-semantic-journey.py` on a disposable
database with the editorial substrate, the real API and worker, and the separate `.journey` app.
`ReaderSheetRecreationTest` opens each reader sheet — Sources, Why this appeared, Connections —
calls `ActivityScenario.recreate()` and waits for the same sheet on the same reading session.

Result from the clean commit named in `receipt.json` (`git describe --dirty`): `OK (3 tests)`
(`instrumentation.txt`); all three sheets restored after recreation; each test proves the reading
session and exposure are unchanged across it, and that exposure is recorded in the database. The
three tests reuse the reading session the first one opened (`hopsToReachContinuations: 0`), so the
Connections sheet was reached on the Scroll the first test entered through "Enter Scroll". The
owner's `.journey` preview was backed up, restored and verified (`preview-restored.json`).
Screenshots are after recreation.

Review (PR #144): the restore also has to survive process death, where a new ViewModel starts in
Loading and the screen composes without the Scroll first; `ReaderSheetProcessRestoreTest`
(Robolectric `StateRestorationTester`) failed on the first fix and passes now. The runner no longer
reads receipts left by an earlier run.

First run on the device: 2 of 3 failed — not the product. The tests share one install, so a later
test launched straight back into the reading session the first one persisted and waited for the
"Enter Scroll" entry that a restored reader never shows. `openReaderFresh` now accepts either
starting point. The runner's lineage check then counted exposures per test instead of distinct
exposures; corrected.

Limits: debug API36 emulator, not a physical device; recreation through `ActivityScenario`, not a
physical rotation.
