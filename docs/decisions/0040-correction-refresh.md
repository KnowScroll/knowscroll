# ADR-0040 — A source correction reaches the reader's places while they are away

Date: 2026-09-24. Status: **accepted** (built for [#160](https://github.com/KnowScroll/knowscroll/issues/160)),
parent #134 under #72. Builds on ADR-0031 (corrections revoke dependent bridges), ADR-0032 (the personal model),
ADR-0036/0037 (places, foundations, deltas and their causes) and ADR-0039 (the return).

## Context

A source correction (`scripts/substrate/correct-source.ts`, `correctSourceSnapshot`) changes shared
knowledge at once: claims lose support, and dependent relations and bridges are revoked. The reader's
places do not follow until their next personal-model refresh (`refreshPersonalModel`), and a refresh
runs only after something the reader does (an exposure, a keep, a branch, an Ask, feedback). So a
correction never reaches a reader who is away. When they come back, their first action produces the
change, and "While you were away" (ADR-0039) cannot show it on return.

The target design calls for a deterministic away-time pass (`07-UNIVERSE-EVOLUTION.md` §5,
`10-CORE-AGENT.md`'s night session, `18-IMPLEMENTATION-PHASES.md`: "deterministic idle checks; no
obligatory idle model call").

## Decision

1. **What a refresh has seen is recorded.** `semantic_correction` is append-only (immutable trigger),
   so its row count only grows. At its start, every `refreshPersonalModel` that is not paused reads
   that count and records it for the universe (`correction_catch_up.corrections_seen`, one row per
   universe). This includes the refreshes a reader's own actions trigger.
2. **A universe is behind** when it is not paused, has at least one live place, and the current
   correction count is greater than the count it last recorded (or it has no record yet).
3. **The worker catches it up.** On a fixed interval (default 60 s,
   `KS_CORRECTION_REFRESH_INTERVAL_MS`), it takes up to a bounded number of behind universes
   (default 8, `KS_CORRECTION_REFRESH_BATCH`), longest-behind first. For each one, in its own
   transaction, it takes that universe's lock (`lockUniverse`) and checks again under the lock that
   the universe is still behind and not paused. It then runs exactly the refresh the reader's next
   action would have run. No model is called, and nothing is recomputed while paused (ADR-0032).
4. **Causes are unchanged.** The Cartographer records each change with its own causal class. A
   sighting or foundation lost to the correction is `source_correction`, so it is away news
   (ADR-0039). Anything else the same refresh records keeps its usual cause.
5. **It is idempotent.** After a refresh the recorded count equals the count that refresh saw, so a
   second pass does nothing until another correction is committed.
6. **The record is part of the personal model.** Clear, Reset and account deletion erase it
   (`erasePersonalModel`; ADR-0035 keeps the universe row, so nothing cascades). It is bookkeeping,
   not history, so export leaves it out.
7. **A failure holds no one back** (review, same day). A universe whose refresh fails is rolled back,
   records nothing and so stays longest-behind; the worker passes that pass's failures to the next
   one, which takes them after everyone else. The log names the universe and the error's code or
   name, never its message.

### Why a count and not timestamps

A correction's `status_changed_at` is taken inside its transaction, before it commits. Take a
refresh that runs between that moment and the commit: it cannot see the correction, yet it stamps
a later time. A rule like "behind = a correction newer than the last refresh" would then treat the
reader as caught up, and they never would be. A count is read from committed rows only. A
correction that commits after the refresh read the count is still unseen, and the next pass picks
it up. The tests include this interleaving.

## Consequences

- Migration `0034_correction_catch_up.sql`: `correction_catch_up(universe_id uuid PRIMARY KEY
  REFERENCES universe(id), corrections_seen integer NOT NULL CHECK (corrections_seen
  >= 0), refreshed_at timestamptz NOT NULL)`.
- `packages/db/src/semantic/correction-refresh.ts`: `findBehindUniverses(client, limit)`,
  `catchUpUniverse(client, universeId)` (lock, re-check, refresh) and `runCorrectionRefreshPass(pool, opts)`
  (one transaction per universe).
- `refreshPersonalModel` records the count it saw. `erasePersonalModel` deletes the row.
- `apps/worker/src/main.ts`: an interval in the existing loop, logging ids and counts only.
- Tests:
  - a correction reaches a reader's places with no action of theirs and appears as a
    `place_changed` away item;
  - a paused reader is left alone, then caught up after resuming;
  - a second pass does nothing;
  - a correction that commits after a refresh read the count is still caught up;
  - Clear and Reset erase the record.

  Testing gotcha: universes that the test helper `formPlaces` builds have places but no real
  attention evidence, so a real refresh would retire their places for another reason. Build real
  accounts by reading and keeping through the API (the `anchorGravity` pattern in
  `tests/atlas-places.test.ts`). Otherwise, correct the shared editorial substrate inside a
  transaction that is rolled back.
- Device: the `return` journey corrects a source that supports one of the reader's sightings, so
  a place change appears on the device on return, in addition to the corrected Relic.
