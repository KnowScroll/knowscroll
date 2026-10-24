# Shared Reel pool database (`knowscroll_pool`)

The pool is the one record of Reel spend. It is shared by dev and stage, and it lives outside every
world database, so resetting a world never forgets money already spent (CF-30, CF-62, ADR-0050).

Status: **implemented**, runtime-verified for v1's orders. Migration `0005` has not been applied on the
server yet; the runbook (`docs/v2/operations/cutroom-and-spend.md`) applies it.

## What it holds

`pool_order` has one row per order sent to the shared Cutroom: the request id, the script digest and
take, the ordering world, the ceiling it reserved, the approval behind it, and, once it ends, the
outcome and the real cost. `pool_budget` has one row, the cap.

**The rule:** settled spend plus the whole ceiling of every open claim never exceeds the cap. A claim
that would pass it is refused with `cap_exceeded`; real spend is recorded as it was, even above its
ceiling (ADR-0012), and the cap then refuses further claims.

## Functions (all SECURITY DEFINER; the tables are not the worlds')

| Function | Does |
| --- | --- |
| `pool_next_take(digest)` | The next take for a script: highest take so far plus one |
| `pool_claim(request, digest, take, until, body_sha256, world, ceiling, approval)` | Reserves the ceiling. Answers `claimed`, `already_ordered` (an order of this script is open or already made the Reel: receive it instead), `cap_exceeded` or `take_taken` |
| `pool_settle(request, world, outcome, spent, final_run)` | Records the real cost, once. The same figures again are a no-op; other figures raise. Only the ordering world settles |
| `pool_release(request, world)` | Gives back a claim whose request was never sent |
| `pool_orders()`, `pool_budget_status()` | Reads |

A world reaches them as a member of `ks_pool_client`. The v2 world roles (`ks2_dev`, `ks2_stage`) are
not members until the runbook grants it.

## Migrations

| File | Does | State |
| --- | --- | --- |
| `0001_shared_pool.sql` | Tables, the cap rule, the functions | Applied (v1) |
| `0002_cap_seven_dollars.sql` | Cap 700 cents (owner, 2026-10-09) | Applied (v1) |
| `0005_cap_four_dollars_more.sql` | Cap 1017 cents: the 617 cents settled plus up to 400 new (D-030) | To apply; see below |

Applied files never change. `0005` refuses a pool that is not in the state the owner approved (cap 700,
at most 617 committed), so it cannot turn "400 more" into some other figure. It moves the cap and its
CHECK together. Numbers 0003 and 0004 were a grant protocol that was never applied and is gone (D-041).

A v2 deploy does not run pool migrations. `0005` is applied by hand as the pool's owner, in one
transaction together with its row in `schema_migrations` (file name and SHA-256 of its text, as v1's
migrator recorded each file); the runbook gives the exact commands, the checks before and after, and what a
recorded row means for a v1 deploy of stage.

## Tests

`tests/integration/pool-reel-allowance.test.ts` builds a disposable pool database from these files and
proves the cap at exactly 1017, settle-once, give-back of unused room, and the migration's refusals.
`tests/integration/modules/reel-order.test.ts` drives the real functions through the Reel commands. Both
are labelled fixture evidence: they move no money and say nothing about the live pool.
