# Reader sheets survive recreation — evidence, 2026-09-24 (#97)

`KS_SEMANTIC_JOURNEY=sheets python3 scripts/android-semantic-journey.py` on a disposable
database with the editorial substrate, the real API and worker, and the separate `.journey` app.
`ReaderSheetRecreationTest` opens each reader sheet — Sources, Why this appeared, Connections —
calls `ActivityScenario.recreate()` and waits for the same sheet on the same reading session.

Result: `OK (3 tests)`; all three sheets restored; the Connections sheet was reached through real
discovery; the reading session's exposure is recorded in the database (`receipt.json`). Screenshots
are after recreation. The owner's `.journey` preview was backed up, restored and verified.

First run on the device: 2 of 3 failed — not the product. The tests share one install, so a later
test launched straight back into the reading session the first one persisted and waited for the
"Enter Scroll" entry that a restored reader never shows. `openReaderFresh` now accepts either
starting point. The runner's lineage check then counted exposures per test instead of distinct
exposures; corrected.

Limits: debug API36 emulator, not a physical device; recreation through `ActivityScenario`, not a
physical rotation.
