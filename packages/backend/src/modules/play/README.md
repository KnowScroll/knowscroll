# modules/play

The play layer of a Scroll: the calls a person locks, the Final call included, whether they were right, the sparks and
combo they earn, and the landmark the Final call awards (D-063, D-064, D-180 to D-182, D-187, D-188). Rooms and threads
will share it later; today only Scrolls use it.

Status: **implemented** and CI-verified against real PostgreSQL (`tests/integration/modules/play.test.ts`). Calls,
sparks and combo are on dev (S-2). The Final call, the combo bonus and landmarks (S-3) are implemented here; they reach
a person only once the Seasons library is regenerated with a landmark and a Final call that turns the tilt, so they are
not yet run on dev.

## What a person can do

- Pick an option of a Call it, **lock it in**, and see the reveal: "Called it!" with a spark for a right pick, "Plot twist!"
  with the sourced common guess for a wrong one. Two right calls in a row make a combo.
- Lock the **Final call** the same way. A right one after a combo of two or more earns a second spark (D-187).
- Earn the Scroll's **landmark** by locking its Final call: gold for a right answer, plain for any other (D-188). A
  Scroll with no landmark awards none.
- Reload, and see the same calls revealed, the same sparks in the dock and the same landmark.
- With **recording paused**, play on the device and save nothing on the server, landmark included. The screen says
  "Not saved while recording is paused." (D-083)
- Clear, or delete the account, and play is erased. Export, and it is listed in words (D-082).

Sparks and landmarks belong to one Scroll revision. There is no total across Scrolls, no level, no ranking of people
(D-064).

## The wall (D-063)

Which option was picked, whether it was right, sparks and combo are play results. They are shown back to the person and
exported to them, and go nowhere else. The wall is two allow-lists in `.dependency-cruiser.cjs`, so it holds for every
module, named or not, and for a path through one (`planner` imports `supply`, so `planner` to `supply` to `play` is closed too):

- `play-wall-only-roots-import-play`: only this module, the apps' composition roots, tests and the erasure registry import `modules/play/`.
- `play-wall-play-imports-three-public-surfaces`: this module imports only the `public.ts` of `identity`, `content` and
  `experience`, plus infrastructure and contracts. It imports none of `composer` (with Jev), `planner`, `evidence`,
  `personal-context`, `geography`, `scenes`, the reasoning engine, or any other module.
- `wall.test.ts`: no production file outside this module names `play.calls` or `play.scroll_results`, so nothing reads a
  pick from the tables either.

`pnpm boundaries:probe` writes a forbidden import from each walled module, the reasoning engine, `supply`, `social` and
`rooms` into play, and from play into each of their public surfaces (22 probes), then runs the same files with the rules
loosened, and loosened for `supply` alone, and fails if a probe still passes: the probes can fail.

What still counts as engagement is unchanged: the reader reports `revealed` (and the contract allows `locked`) by kind,
through Evidence, with no field for an option or a result. `tests/integration/modules/play.test.ts` reads the same Scroll
twice, one person calling right (a gold landmark) and the other wrong (a plain one), and finds the same qualification,
activity, Personal Context contribution and formed places.

## Entry points

| Operation | Route | Authority, effects, failure |
|---|---|---|
| `lockCall(authority, {commandId, assetId, revision, stopId, option, recordingGeneration})` | `POST /v1/play/calls/lock` | Personal root, then own account. An identical retry answers the stored lock. The recording gate (D-083): paused or a stale generation stores nothing, writes no receipt and answers `recorded: false`. Then the person must have an **activated exposure of that exact revision** (`experience` `HAS_ACTIVATED_EXPOSURE`) and the stop must be a **call of that revision**, a Call it or the Final call (`content` `READ_SCROLL_PLAY_FACTS`, read from the immutable document). The option must be one the call has. Correctness is recomputed here, never taken from the client. One transaction writes the receipt, `play.calls`, `play.scroll_results` and, for a Final call of a revision that names a landmark, `play.landmarks`. The sparks come from the module's own `afterLock` (the combo bonus) and the finish from `landmarkTierOf`; a test checks both against the device's copy in `scroll-model`. |
| `readResults(authority, {assetId, revision})` | `POST /v1/play/results/read` | The caller's own calls (in the order locked), sparks, combo and landmark for one revision; nothing locked reads as zeroes. A read, so it answers while recording is paused. |
| `readLandmarks(authority)` | `POST /v1/play/landmarks/read` | The caller's own landmarks, newest first (key, name, finish, Scroll, day). For the Universe overlay (S-4). A read, so it answers while recording is paused; nothing in it forms or moves a place. |

Refusals map to the shared problems: an unknown revision, call or exposure is one `NOT_FOUND` (a lock is no oracle); a
forged option is `UNPROCESSABLE_REQUEST`; a reused command key is `COMMAND_KEY_REUSED`.

A second lock of a call that already has one, by another command, **stands as the first**: the answer carries the stored
option and `newlyLocked: false`, and nothing changes. A landmark is awarded once with its Final call and is never upgraded.

## Tables, jobs, lock order, erasure

| Item | Detail |
|---|---|
| Tables | `play.calls` (0074): one row per person, Scroll revision and call stop: the option locked, `correct`, the command, the time and `lock_seq`, the order locked (a sequence, not the clock, so a clock that steps back cannot reorder a combo). Never updated. `play.scroll_results` (0074, bounds widened by 0077): per person and revision, calls locked, sparks (at most five) and combo, replaced with each lock. `play.landmarks` (0077): one row per person and revision whose Final call was locked, when it names a landmark: the key and name the person saw, the finish (`gold` or `plain`) and the time. Written once, in the Final call's transaction; never updated. It names no planet: the Universe attaches it from the asset (S-4, D-084). |
| Jobs, notices | none. A lock changes nothing another module reads, so it enqueues nothing and bumps no universe revision. |
| Lock order | personal root, then the caller's own account; no other root |
| Clear | erased (all three tables) |
| Account deletion | erased (universe-keyed) |
| Export | `play.scrolls`: per Scroll its title (if still reachable), sparks, combo and, for each call, the question, the option picked in words, whether it was right and when. `play.landmarks`: each landmark's name, finish, day and Scroll title (if still reachable). No identifier, no key and not the right answer. |
| Erasure order | third in the registry (after rooms and feedback): nothing refers to play rows |

## Failure and recovery

- A lost response: retry with the same command ID; the receipt replays it, with today's results.
- The same command ID for another pick: `COMMAND_KEY_REUSED`.
- Recording resumed or paused while a client held an old generation: `recording_generation_stale`; the client reads the
  policy again and sends the same lock.
- Clear or a privacy reset: the receipt of an earlier epoch is never replayed, and the rows are gone.

## Planned

The weekly Orbit and the Universe overlay with the landmark tray (S-4), play in threads and rooms. None of them changes
the wall. A landmark is shown on a planet only after the Universe reads `readLandmarks`; until S-4 it is stored and
shown on the Scroll's own end.

## Related

Decisions D-063, D-064, D-082, D-083, D-180 to D-182, D-187, D-188. Contracts: `packages/contracts/src/play.ts`. Client:
`packages/client-core/src/play-session.ts`, `packages/ui/src/scroll/stage-reader/` (the call view, sparks chip),
`apps/client/features/scroll/use-stage-play.ts`. Tally rule shared with the device: `packages/scroll-model/src/v2/play.ts`.
