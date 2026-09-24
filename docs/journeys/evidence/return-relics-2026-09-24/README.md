# The return and connection Relics — evidence, 2026-09-24 (#134, ADR-0039)

KnowScroll does real work while the reader is away (ADR-0038's background inquiries, and source
corrections). This slice lets the reader see that work when they come back, inspect it, doubt it,
and keep what matters as a Relic that never hides a later correction.

- `GET /v1/away` lists only what the reader did not cause since their marker in this epoch:
  - inquiry outcomes (found, nothing found, did not hold up with the validator's reasons);
  - place changes caused by a source correction, with the chronicle's own line;
  - corrections to a connection they were shown or kept.
  Nothing in it is model text except a found connection's validated sentence.
- `POST /v1/away/acknowledge` moves the marker to the newest item displayed. It only moves forward
  and is refused while recording is paused.
- A **connection Relic** points to one admitted bridge. It records its provenance (the inquiry that
  found it, the validator version, the cited claim keys), is immutable, and is private to the
  universe and epoch. Its state is derived each time it is read: `current`, `corrected` (revoked or
  superseded since) or `doubted` (the reader marked it "seems wrong"). "Let go" removes it.

## What was proven

| Proof | How | Result |
| --- | --- | --- |
| Pure | `tests/return-relics-core.test.ts` (8) | newest-first order with deterministic ties; the marker exclusive; the cap and the count of the rest; the marker only forward; the strict contracts (items after the marker and newest first; a Relic `corrected` exactly when its connection is no longer admitted); a too-long chronicle line shortened at a word, never dropped |
| Database, API, worker | `tests/return-relics.test.ts` (9; fixture inquiry transport) | a fresh reader has nothing; a found connection is away news and the reader's own place formations are not; keep with provenance; acknowledge; a real source correction then appears as away news and turns the Relic `corrected`, its kept sentence readable; release; nothing-found and did-not-hold-up items; the marker's rules (stale epoch, future, paused, replay, key reuse, behind); keep's rules (unknown, stale, paused, one per connection, another universe's personal connection, doubted then refused); another reader sees none of it; the marker covers an item at its millisecond, so the count of the rest is exact on a full list (a mutant without it fails); Clear, Reset and account deletion (even while paused) erase both, export carries both; SQL guards (current epoch, immutable, never while paused, marker forward only, only an admitted connection) |
| Android | 429 unit and Robolectric tests, lint | strict parsers for every contract refinement; the view model's retry-the-same-request versus definitive refusal; each item's wording; the section absent when nothing is waiting; "Mark as seen" replaced while paused, and no Keep while paused; a keep the Relic list confirms is settled, so a later retry never brings back a Relic the reader let go; Keep / Seems wrong / Let go and the Relic states |
| Device | `KS_SEMANTIC_JOURNEY=return` (below) | passed, with the SQL lineage verified |

## The device journey

On the API36 emulator, against a disposable stack, as the separate test app
`com.knowscroll.mobile.journeytest` (#157). The labelled fixture inquiry route and The Sun (placed
from a supplied account) are seeded as in the `inquiry` journey.

1. The reader turns on "Look for connections between my places" and reads their way to Gravity.
2. **They leave.** The app goes to the background while the inquiry is still `waiting`. The worker,
   on its own, runs the inquiry that Gravity's formation mailed, and `bridge-validator-v1` admits the
   fixture's proposal.
3. **They return.** The Atlas says "While you were away: Found a connection: The Sun and Gravity."
   (`return-away.png`).
4. The connection opens with its sentence (labelled "Fixture:") and the three sources it was admitted
   on (`return-evidence.png`).
5. **Keep**: "Kept in your Relics" (`return-relic.png`).
6. **Seems wrong**. Keep shows the Relic "You marked this as seeming wrong" (`return-doubted.png`).
   They mark what changed as seen, and the section goes.
7. **They leave again.** Only after the device writes, from the background, that it has left does the
   runner revoke the kept connection's mechanism source (`nasa.gravity`), through the real operator
   tool (`scripts/substrate/correct-source.ts`), in the disposable database.
8. **They return.** The Atlas says "A source correction withdrew the connection between The Sun and
   Gravity." (`return-corrected-away.png`). Keep shows the Relic "Corrected — a source changed after
   you kept it", with its kept sentence still readable (`return-corrected-relic.png`).

SQL lineage (`receipt.json`; each value is 1 unless stated):
- the inquiry admitted, found this bridge, through a completed `background_inquiry` / `dirty` Job;
- the inquiry was `waiting` on the device when it left, and found when it came back;
- the Relic's states as the device observed them, in order: current, doubted, corrected;
- the Relic kept with its provenance: the bridge, the inquiry, `bridge-validator-v1`, ≥ 3 cited claims;
- one "seems wrong" on that bridge;
- the bridge revoked by the correction;
- one marker, covering the found item.

The owner's preview was never touched: its APKs were the same before and after
(`preview-untouched.json`).

## Found while proving it

- The first device run failed on the journey's own navigation (a `performScrollTo` on a button
  outside any scroll). The second passed every UI step but failed two SQL lineage checks:
  - The marker is the item's time at the wire's millisecond precision, while PostgreSQL keeps
    microseconds. The server's counts now compare at millisecond precision everywhere (the list
    itself already did).
  - The check "closed while away" compared the device's clock with the database's. It now uses
    what the device saw: the inquiry still `waiting` when it left.
- The dock covered the connection sheet's second button; the sheet now scrolls it clear.
- The fresh review (PR #158) found, and this branch fixes:
  - a too-long chronicle line would have made the whole list unreadable to the strict client;
  - the millisecond fix had no test that failed without it;
  - no tests for other readers, Reset or account deletion;
  - a keep racing a source correction answered 500;
  - a stale retry could bring back a Relic that had been let go;
  - Keep was offered while paused;
  - the journey applied the correction on a timer rather than after the device left.
  Deferred items are in #159.

## Limits

- The fixture inquiry transport (labelled): the proposal is the fixture's; the admission is the
  validator's. No provider call in this run.
- "Away" means the app in the background (Home) for seconds while the worker and the correction
  run, not days. The inquiry's coalescing delay is 20 s so that it runs after the app has left.
- The source correction is an operator action in the disposable database.
- No place changed from this correction (the reader's places did not depend on that source's
  claims alone), so no `place_changed` item appears on the device. The DB test covers one.
- Rooms, inhabitants and other kinds of Relic are not in this slice, and neither is the web client.
- Debug API36 emulator, not a physical device.
