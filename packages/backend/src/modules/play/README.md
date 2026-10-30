# modules/play

The play layer of a Scroll: the Call its a person locks, whether they were right, and the sparks and combo they earn
(D-063, D-064, D-180 to D-182). Rooms and threads will share it later; today only Scrolls use it.

Status: **implemented** and CI-verified against real PostgreSQL (`tests/integration/modules/play.test.ts`). Not yet run
on dev.

## What a person can do

- Pick an option of a Call it, **lock it in**, and see the reveal: "Called it!" with a spark for a right pick, "Plot twist!"
  with the sourced common guess for a wrong one. Two right calls in a row make a combo.
- Reload, and see the same calls revealed and the same sparks in the dock.
- With **recording paused**, play on the device and save nothing on the server. The screen says "Not saved while
  recording is paused." (D-083)
- Clear, or delete the account, and play is erased. Export, and it is listed in words (D-082).

Sparks belong to one Scroll revision. There is no total across Scrolls, no level, no ranking of people (D-064).

## The wall (D-063)

Which option was picked, whether it was right, sparks and combo are play results. They are shown back to the person and
exported to them, and go nowhere else. The modules that rank, plan, remember or form places from behaviour (`composer`
with Jev, `planner`, `evidence`, `personal-context`, `geography`, `scenes`) and the reasoning engine they call **never
import this module, and this module never imports them**: the dependency-cruiser rules `play-wall-nothing-derives-from-play`
and `play-wall-play-reaches-nothing-there`, proved to fail by `pnpm boundaries:probe`.

What still counts as engagement is unchanged: the reader reports `revealed` (and the contract allows `locked`) by kind,
through Evidence, with no field for an option or a result. `tests/integration/modules/play.test.ts` reads the same Scroll
twice, one person calling right and the other wrong, and finds the same qualification, activity, Personal Context
contribution and formed places.

## Entry points

| Operation | Route | Authority, effects, failure |
|---|---|---|
| `lockCall(authority, {commandId, assetId, revision, stopId, option, recordingGeneration})` | `POST /v1/play/calls/lock` | Personal root, then own account. An identical retry answers the stored lock. The recording gate (D-083): paused or a stale generation stores nothing, writes no receipt and answers `recorded: false`. Then the person must have an **activated exposure of that exact revision** (`experience` `HAS_ACTIVATED_EXPOSURE`) and the stop must be a **Call it of that revision** (`content` `READ_SCROLL_CALLS`, read from the immutable document); the Final call is not played yet. The option must be one the call has. Correctness is recomputed here, never taken from the client. One transaction writes the receipt, `play.calls` and `play.scroll_results`. |
| `readResults(authority, {assetId, revision})` | `POST /v1/play/results/read` | The caller's own calls (in the order locked), sparks and combo for one revision; nothing locked reads as zeroes. A read, so it answers while recording is paused. |

Refusals map to the shared problems: an unknown revision, call or exposure is one `NOT_FOUND` (a lock is no oracle); a
forged option is `UNPROCESSABLE_REQUEST`; a reused command key is `COMMAND_KEY_REUSED`.

A second lock of a call that already has one, by another command, **stands as the first**: the answer carries the stored
option and `newlyLocked: false`, and nothing changes.

## Tables, jobs, lock order, erasure

| Item | Detail |
|---|---|
| Tables | `play.calls` (0073): one row per person, Scroll revision and call stop: the option locked, `correct`, the command, the time. Never updated. `play.scroll_results` (0073): per person and revision, calls locked, sparks and combo, replaced with each lock. |
| Jobs, notices | none. A lock changes nothing another module reads, so it enqueues nothing and bumps no universe revision. |
| Lock order | personal root, then the caller's own account; no other root |
| Clear | erased (both tables) |
| Account deletion | erased (universe-keyed) |
| Export | `play.scrolls`: per Scroll its title (if still reachable), sparks, combo and, for each call, the question, the option picked in words, whether it was right and when. No identifier and not the right answer. |
| Erasure order | first in the registry: nothing refers to play rows |

## Failure and recovery

- A lost response: retry with the same command ID; the receipt replays it, with today's results.
- The same command ID for another pick: `COMMAND_KEY_REUSED`.
- Recording resumed or paused while a client held an old generation: `recording_generation_stale`; the client reads the
  policy again and sends the same lock.
- Clear or a privacy reset: the receipt of an earlier epoch is never replayed, and the rows are gone.

## Planned

Final call and landmarks (S-3), the weekly Orbit and the Universe overlay (S-4), play in threads and rooms, a landmark
tray. None of them changes the wall.

## Related

Decisions D-063, D-064, D-082, D-083, D-180 to D-182. Contracts: `packages/contracts/src/play.ts`. Client:
`packages/client-core/src/play-session.ts`, `packages/ui/src/scroll/stage-reader/` (the call view, sparks chip),
`apps/client/features/scroll/use-stage-play.ts`. Tally rule shared with the device: `packages/scroll-model/src/v2/play.ts`.
